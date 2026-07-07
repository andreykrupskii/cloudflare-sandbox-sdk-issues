import { tracing } from 'cloudflare:workers';
import { getSandbox, type DirectoryBackup, type Sandbox } from '@cloudflare/sandbox';
import { jwtVerify } from 'jose';

// Container-backed Durable Object, re-exported under the binding name `Sandbox` (see
// wrangler.toml). No customization is needed to reproduce the issue.
export { Sandbox } from '@cloudflare/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  // The Sandbox SDK writes snapshots here when createBackup({ localBucket: true }) is used.
  // The binding name MUST be BACKUP_BUCKET — the SDK looks it up by that name.
  BACKUP_BUCKET: R2Bucket;
  // Shared HS256 secret: the client signs a short-lived bearer token, the Worker verifies it.
  REPRO_SECRET: string;
}

const WORKSPACE_DIR = '/workspace';
const JWT_ISSUER = 'repro-client';
const JWT_AUDIENCE = 'repro-worker';

// Correlates a set of RPC calls with a single repro run and, optionally, a single sandbox
// instance within that run. Sent by the client on every request and attached to every span so
// traces can be grouped in the trace UI by run_id / run_instance_id.
interface RunContext {
  runId?: string;
  runInstanceId?: string;
}

// One POST endpoint; the operation is `method`, its inputs are `params` — same JSON-RPC shape
// as our production worker. A workspace is addressed by `workspaceId` (also the Durable Object id).
type RpcRequest = (
  | { method: 'create_workspace'; params?: { snapshotId?: string } }
  | { method: 'bash'; params: { workspaceId: string; command: string } }
  | { method: 'snapshot_workspace'; params: { workspaceId: string } }
  | { method: 'destroy_workspace'; params: { workspaceId: string } }
) &
  RunContext;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const verifyAuth = async (request: Request, secret: string): Promise<void> => {
  const bearer = request.headers.get('authorization') ?? '';
  if (!bearer.startsWith('Bearer ')) {
    throw new Error('missing bearer token');
  }
  await jwtVerify(bearer.slice('Bearer '.length).trim(), new TextEncoder().encode(secret), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
};

// Tag a span with the run identifiers so every span emitted for a request is discoverable by
// run_id / run_instance_id in the trace UI.
const tagRun = (span: Span, run: RunContext): void => {
  span.setAttribute('run_id', run.runId);
  span.setAttribute('run_instance_id', run.runInstanceId);
};

// The SDK stamps a structured `context` on its errors; PR #799 (commit f553148) added the
// platform's container exit code + stop reason to it when a container dies mid-operation (e.g.
// containerExitCode 137 = OOM kill, 143 / stopReason 'runtime_signal' = signalled eviction,
// 0 / 'exit' = clean exit). Grab the whole object rather than cherry-picking fields — the shape can
// grow and everything in it (reason, phase, retryable, ...) is useful for diagnosis. Read it
// structurally: the error crosses the DO RPC boundary (so `instanceof` won't hold) and the context
// may sit on the error itself or on a wrapped `cause`.
const errorContext = (error: unknown): Record<string, unknown> | undefined => {
  const e = error as { context?: unknown; cause?: { context?: unknown } };
  const ctx = e?.context ?? e?.cause?.context;
  return ctx && typeof ctx === 'object' ? (ctx as Record<string, unknown>) : undefined;
};

// Rebuild a DirectoryBackup handle from the SDK-written sidecar at `backups/{id}/meta.json`,
// so a caller can pass back a plain `snapshotId` string. `localBucket: true` is re-asserted
// here (the SDK doesn't store that flag in the sidecar, but every snapshot uses it).
const resolveSnapshot = async (bucket: R2Bucket, snapshotId: string): Promise<DirectoryBackup> => {
  const obj = await bucket.get(`backups/${snapshotId}/meta.json`);
  if (!obj) {
    throw new Error(`snapshot not found: ${snapshotId}`);
  }
  const meta = await obj.json<{ id: string; dir: string }>();
  return { id: meta.id, dir: meta.dir, localBucket: true };
};

const dispatch = async (req: RpcRequest, env: Env): Promise<unknown> => {
  switch (req.method) {
    case 'create_workspace': {
      return tracing.enterSpan('rpc.create_workspace', async (span) => {
        tagRun(span, req);
        const workspaceId = crypto.randomUUID();
        span.setAttribute('workspace_id', workspaceId);
        span.setAttribute('from_snapshot', Boolean(req.params?.snapshotId));
        if (req.params?.snapshotId) span.setAttribute('snapshot_id', req.params.snapshotId);
        const sandbox = getSandbox(env.Sandbox, workspaceId, { sleepAfter: '60s' });
        try {
          await tracing.enterSpan('sandbox.mkdir', () =>
            sandbox.mkdir(WORKSPACE_DIR, { recursive: true }), // first container call → starts the container
          );
          if (req.params?.snapshotId) {
            await tracing.enterSpan('sandbox.restoreBackup', async () =>
              sandbox.restoreBackup(await resolveSnapshot(env.BACKUP_BUCKET, req.params!.snapshotId!)),
            );
          }
          return { workspaceId, status: 'ready' };
        } catch (error) {
          // Tear down the half-started container so a failed create doesn't leak a Running instance.
          await tracing.enterSpan('sandbox.destroy.cleanup', () =>
            getSandbox(env.Sandbox, workspaceId)
              .destroy()
              .catch((cleanupError) => {
                console.error(`cleanup after failed create_workspace failed (${workspaceId})`, cleanupError);
              }),
          );
          span.setAttribute('error', String(error));
          if (error instanceof Error) span.setAttribute('error.stack', error.stack);
          // Attach the SDK's full error context so the trace names the actual cause. The whole
          // object goes on one attribute; each primitive field is also promoted to its own `ctx.*`
          // attribute so it stays filterable in the trace UI (container exit code, stop reason, ...).
          const ctx = errorContext(error);
          if (ctx) {
            span.setAttribute('error.context', JSON.stringify(ctx));
            for (const [key, value] of Object.entries(ctx)) {
              if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                span.setAttribute(`ctx.${key}`, value);
              }
            }
          }
          throw error;
        }
      });
    }
    case 'bash': {
      return tracing.enterSpan('rpc.bash', async (span) => {
        tagRun(span, req);
        span.setAttribute('workspace_id', req.params.workspaceId);
        span.setAttribute('command', req.params.command);
        const sandbox = getSandbox(env.Sandbox, req.params.workspaceId);
        const result = await tracing.enterSpan('sandbox.exec', (execSpan) =>
          sandbox.exec(req.params.command).then((r) => {
            execSpan.setAttribute('exit_code', r.exitCode);
            return r;
          }),
        );
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      });
    }
    case 'snapshot_workspace': {
      return tracing.enterSpan('rpc.snapshot_workspace', async (span) => {
        tagRun(span, req);
        span.setAttribute('workspace_id', req.params.workspaceId);
        const sandbox = getSandbox(env.Sandbox, req.params.workspaceId);
        const backup = await tracing.enterSpan('sandbox.createBackup', (backupSpan) =>
          sandbox
            .createBackup({ dir: WORKSPACE_DIR, gitignore: true, localBucket: true })
            .then((b) => {
              backupSpan.setAttribute('snapshot_id', b.id);
              return b;
            }),
        );
        return { workspaceId: req.params.workspaceId, snapshotId: backup.id };
      });
    }
    case 'destroy_workspace': {
      return tracing.enterSpan('rpc.destroy_workspace', async (span) => {
        tagRun(span, req);
        span.setAttribute('workspace_id', req.params.workspaceId);
        await tracing.enterSpan('sandbox.destroy', () =>
          getSandbox(env.Sandbox, req.params.workspaceId).destroy(),
        );
        return { workspaceId: req.params.workspaceId, destroyed: true };
      });
    }
    default:
      throw new Error(`unknown method: ${(req as { method: string }).method}`);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await verifyAuth(request, env.REPRO_SECRET);
    } catch (err) {
      return json({ error: `unauthorized: ${err instanceof Error ? err.message : String(err)}` }, 401);
    }
    if (request.method !== 'POST') {
      return json({ error: 'use POST { method, params }' }, 405);
    }
    try {
      return json(await dispatch(await request.json<RpcRequest>(), env));
    } catch (err) {
      // Forward the SDK's full error context (when present) so the client can print the exact
      // cause alongside the generic message.
      const ctx = errorContext(err);
      return json(
        {
          error: err instanceof Error ? err.message : String(err),
          ...(ctx && { context: ctx }),
        },
        500,
      );
    }
  },
};

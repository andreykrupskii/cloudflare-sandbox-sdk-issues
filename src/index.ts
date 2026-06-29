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

// One POST endpoint; the operation is `method`, its inputs are `params` — same JSON-RPC shape
// as our production worker. A workspace is addressed by `workspaceId` (also the Durable Object id).
type RpcRequest =
  | { method: 'create_workspace'; params: { snapshotId?: string } }
  | { method: 'bash'; params: { workspaceId: string; command: string } }
  | { method: 'snapshot_workspace'; params: { workspaceId: string } }
  | { method: 'destroy_workspace'; params: { workspaceId: string } };

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
      const workspaceId = crypto.randomUUID();
      const sandbox = getSandbox(env.Sandbox, workspaceId);
      await sandbox.mkdir(WORKSPACE_DIR, { recursive: true }); // first container call → starts the container
      if (req.params.snapshotId) {
        await sandbox.restoreBackup(await resolveSnapshot(env.BACKUP_BUCKET, req.params.snapshotId));
      }
      return { workspaceId, status: 'ready' };
    }
    case 'bash': {
      const sandbox = getSandbox(env.Sandbox, req.params.workspaceId);
      const result = await sandbox.exec(req.params.command);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }
    case 'snapshot_workspace': {
      const sandbox = getSandbox(env.Sandbox, req.params.workspaceId);
      const backup = await sandbox.createBackup({ dir: WORKSPACE_DIR, gitignore: true, localBucket: true });
      return { workspaceId: req.params.workspaceId, snapshotId: backup.id };
    }
    case 'destroy_workspace': {
      await getSandbox(env.Sandbox, req.params.workspaceId).destroy();
      return { workspaceId: req.params.workspaceId, destroyed: true };
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
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },
};

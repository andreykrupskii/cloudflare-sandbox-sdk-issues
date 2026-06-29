// End-to-end reproduction of cloudflare/sandbox-sdk#794.
//
// Scenario:
//   1. create a workspace
//   2. write a file into it
//   3. snapshot it                       -> snapshotId
//   4. destroy the original workspace
//   5. create N workspaces FROM that snapshot, concurrently
//
// Step 5 is the bug: a share of the concurrent creates fail with
// "RPC session was shut down by disposing the main stub", and some failures leave a
// container stuck in the Running state.
//
// Config + auth come from .env (WORKER_URL, REPRO_SECRET).
// Run:  node scripts/repro.mjs [count=10]

import { readFileSync } from 'node:fs';
import { SignJWT } from 'jose';

const COUNT = Number(process.argv[2] ?? 10);

// --- config + auth -------------------------------------------------------------------

function loadEnv() {
  const env = Object.fromEntries(
    readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
  );
  if (!env.WORKER_URL || !env.REPRO_SECRET) {
    throw new Error('set WORKER_URL and REPRO_SECRET in .env (copy .env.example)');
  }
  return env;
}

const { WORKER_URL, REPRO_SECRET } = loadEnv();

// Short-lived HS256 bearer the Worker verifies — iss/aud must match src/index.ts.
function mintToken() {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('repro-client')
    .setAudience('repro-worker')
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(REPRO_SECRET));
}

// One JSON-RPC call; throws on a non-200 so callers can rely on the result.
async function rpc(method, params = {}) {
  const token = await mintToken();
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    throw new Error(body.error ?? `http ${res.status}`);
  }
  return body;
}

// --- one function per RPC method -----------------------------------------------------

async function createWorkspace(snapshotId) {
  const { workspaceId } = await rpc('create_workspace', snapshotId ? { snapshotId } : {});
  return workspaceId;
}

function writeFile(workspaceId, path, content) {
  return rpc('bash', { workspaceId, command: `echo ${JSON.stringify(content)} > ${path}` });
}

async function snapshotWorkspace(workspaceId) {
  const { snapshotId } = await rpc('snapshot_workspace', { workspaceId });
  return snapshotId;
}

function destroyWorkspace(workspaceId) {
  return rpc('destroy_workspace', { workspaceId });
}

// Fire `count` create_workspace({ snapshotId }) calls at once. Never throws — records each outcome.
function createManyFromSnapshot(snapshotId, count) {
  const attempts = Array.from({ length: count }, (_, i) =>
    createWorkspace(snapshotId).then(
      (workspaceId) => ({ i, ok: true, workspaceId }),
      (err) => ({ i, ok: false, error: err.message }),
    ),
  );
  return Promise.all(attempts);
}

// --- scenario ------------------------------------------------------------------------

async function main() {
  console.log(`worker: ${new URL(WORKER_URL).host}\n`);

  console.log('1. create workspace');
  const workspaceId = await createWorkspace();
  console.log(`   -> ${workspaceId}`);

  console.log('2. write file');
  await writeFile(workspaceId, '/workspace/hello.txt', 'hello from the repro');

  console.log('3. snapshot');
  const snapshotId = await snapshotWorkspace(workspaceId);
  console.log(`   -> ${snapshotId}`);

  console.log('4. destroy original workspace');
  await destroyWorkspace(workspaceId);

  console.log(`5. create ${COUNT} workspaces from the snapshot, concurrently`);
  const results = (await createManyFromSnapshot(snapshotId, COUNT)).sort((a, b) => a.i - b.i);
  for (const r of results) {
    console.log(`   [${String(r.i).padStart(2, '0')}] ${r.ok ? 'OK  ' : 'FAIL'} ${r.ok ? r.workspaceId : r.error}`);
  }

  const created = results.filter((r) => r.ok).map((r) => r.workspaceId);
  console.log(`\n${created.length}/${COUNT} ok · ${COUNT - created.length} failed`);
  if (created.length) {
    console.log(`created (still running): ${created.join(' ')}`);
  }
  console.log('check the dashboard — failed starts may leave containers stuck in Running.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

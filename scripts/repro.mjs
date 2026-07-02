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
// Every call carries a run_id (one per repro run) and a run_instance_id (one per sandbox
// lifecycle). With `traces` enabled on the Worker, use these to find the failing request's
// trace — which now reports the real underlying error.
//
// Config + auth come from .env (WORKER_URL, REPRO_SECRET).
// Run:  node scripts/repro.mjs [count=10]

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';

const COUNT = Number(process.argv[2] ?? 10);

// --- config + auth -------------------------------------------------------------------

// Load the sibling .env into process.env (Node's built-in loader).
const dotenvPath = fileURLToPath(new URL('../.env', import.meta.url));
process.loadEnvFile(dotenvPath);

const { WORKER_URL, REPRO_SECRET } = process.env;
if (!WORKER_URL || !REPRO_SECRET) {
  throw new Error('set WORKER_URL and REPRO_SECRET in .env (copy .env.example)');
}

// One id for the whole run; a fresh instance id is minted per sandbox lifecycle (the setup
// workspace, and each concurrent create). Both are attached to every RPC so the resulting
// spans can be grouped in the trace UI.
const RUN_ID = randomUUID();

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
async function rpc(method, params = {}, runInstanceId) {
  const token = await mintToken();
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params, runId: RUN_ID, runInstanceId }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { text }; }
  if (res.status !== 200) {
    throw new Error(body.error ?? `http ${res.status}: ${text}`);
  }
  return body;
}

// --- one function per RPC method -----------------------------------------------------

async function createWorkspace(snapshotId, runInstanceId) {
  const { workspaceId } = await rpc('create_workspace', snapshotId ? { snapshotId } : {}, runInstanceId);
  return workspaceId;
}

function writeFile(workspaceId, path, content, runInstanceId) {
  return rpc('bash', { workspaceId, command: `echo ${JSON.stringify(content)} > ${path}` }, runInstanceId);
}

async function snapshotWorkspace(workspaceId, runInstanceId) {
  const { snapshotId } = await rpc('snapshot_workspace', { workspaceId }, runInstanceId);
  return snapshotId;
}

function destroyWorkspace(workspaceId, runInstanceId) {
  return rpc('destroy_workspace', { workspaceId }, runInstanceId);
}

// Fire `count` create_workspace({ snapshotId }) calls at once. Never throws — records each
// outcome with its instance id and start/end timing (failures return notably faster).
function createManyFromSnapshot(snapshotId, count) {
  const t0 = Date.now();
  const attempts = Array.from({ length: count }, (_, i) => {
    const start = Date.now() - t0;
    const runInstanceId = randomUUID();
    return createWorkspace(snapshotId, runInstanceId).then(
      (workspaceId) => ({ i, ok: true, workspaceId, runInstanceId, start, end: Date.now() - t0 }),
      (err) => ({ i, ok: false, error: err.message, runInstanceId, start, end: Date.now() - t0 }),
    );
  });
  return Promise.all(attempts);
}

// --- scenario ------------------------------------------------------------------------

async function main() {
  console.log(`worker:  ${new URL(WORKER_URL).host}`);
  console.log(`run_id:  ${RUN_ID}\n`);

  // The setup workspace gets its own instance id, distinct from the N creates.
  const setupInstanceId = randomUUID();

  console.log('1. create workspace');
  const workspaceId = await createWorkspace(undefined, setupInstanceId);
  console.log(`   -> ${workspaceId}`);

  console.log('2. write file');
  await writeFile(workspaceId, '/workspace/hello.txt', 'hello from the repro', setupInstanceId);

  console.log('3. snapshot');
  const snapshotId = await snapshotWorkspace(workspaceId, setupInstanceId);
  console.log(`   -> ${snapshotId}`);

  console.log('4. destroy original workspace');
  await destroyWorkspace(workspaceId, setupInstanceId);

  console.log(`5. create ${COUNT} workspaces from the snapshot, concurrently`);
  const results = (await createManyFromSnapshot(snapshotId, COUNT)).sort((a, b) => a.i - b.i);
  for (const r of results) {
    const index = String(r.i).padStart(2, '0');
    if (r.ok) {
      console.log(`   [${index}] OK   start=+${r.start}ms end=+${r.end}ms run_instance_id=${r.runInstanceId} workspaceId=${r.workspaceId}`);
    } else {
      console.log(`   [${index}] FAIL start=+${r.start}ms end=+${r.end}ms run_instance_id=${r.runInstanceId} ${r.error}`);
    }
  }

  const created = results.filter((r) => r.ok).map((r) => r.workspaceId);
  console.log(`\n---- summary: ${created.length}/${COUNT} ok · ${COUNT - created.length}/${COUNT} failed ----`);
  console.log(`run_id: ${RUN_ID}`);
  if (created.length) {
    console.log(`created (still running): ${created.join(' ')}`);
  }
  console.log('check the dashboard — failed starts may leave containers stuck in Running.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});

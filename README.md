# Concurrent sandbox creation fails and leaks Running containers

Minimal reproduction for **cloudflare/sandbox-sdk#794**.

A Worker exposes a small authenticated JSON-RPC API with four
methods: `create_workspace`, `bash`, `snapshot_workspace`, `destroy_workspace`. A client script
fires **N `create_workspace` calls concurrently**. A share of them fail with:

```
RPC session was shut down by disposing the main stub
```

even with the account far below the instance cap — and roughly half of the failed starts leave a
container stuck in the **Running** state that is never torn down.

## How it works

- **`src/index.ts`** — one `POST /` endpoint, body `{ method, params }`. Every request carries a
  short-lived HS256 bearer token the Worker verifies with a shared secret (`REPRO_SECRET`).
- **`scripts/repro.mjs`** — one script that runs the reproduction scenario: create a
  workspace, write a file, snapshot it, destroy it, then create N workspaces from the snapshot
  concurrently (the failing step).
- Snapshots use the SDK's `createBackup({ localBucket: true })`, which persists to the
  `BACKUP_BUCKET` R2 bucket; `create_workspace({ snapshotId })` restores from it — the exact path
  our scheduled workflows use.
- **Tracing** — per the maintainer's suggestion on the issue, this runs the preview SDK build
  ([`pkg.pr.new/@cloudflare/sandbox@799`](https://pkg.pr.new/@cloudflare/sandbox@799), from PR #799)
  and enables persisted traces. Every RPC is wrapped in a span (`rpc.create_workspace`, etc.) and
  tagged with a `run_id` (one per repro run) and `run_instance_id` (one per sandbox lifecycle) that
  the client sends on every request. In the Worker → **Observability** → **Traces** UI, filter by
  those ids to find a failing request's trace, which now reports the *real* underlying error (e.g.
  `there is no container instance that can be provided to this durable object`) instead of the
  generic `RPC session was shut down by disposing the main stub`. A failed `create_workspace` also
  now tears its half-started container down (`sandbox.destroy.cleanup` span) to avoid the leak.
- **Error context** — the SDK stamps a structured `context` on its errors; PR #799 (commit
  `f553148`) adds the platform's container exit code and stop reason to it when a container dies
  mid-operation. The Worker forwards the whole `context` rather than cherry-picking fields: it
  JSON-stamps it on the span as `error.context` and promotes each primitive to a filterable `ctx.*`
  attribute, and the client prints it on `FAIL` lines as `context={...}` — e.g.
  `"containerExitCode":137,"stopReason":"runtime_signal"` for an OOM kill, `143` for a signalled
  eviction, `0` / `"exit"` for a clean exit. This is what distinguishes an evicted/killed container
  from a clean exit.

## Prerequisites

- Node 20.12+.
- A Cloudflare account with Containers enabled.
- Docker running locally (wrangler builds the image on deploy).
- `wrangler` authenticated: `npx wrangler login`.

## Setup

```bash
# 1. Install
npm install

# 2. Create the R2 bucket the SDK writes snapshots to
npx wrangler r2 bucket create sandbox-sdk-issue-794-backups

# 3. Deploy — this CREATES the Worker (note the URL it prints).
#    Requests return 401 until the secret is set in step 4.
npx wrangler deploy

# 4. Set the shared secret ON THE WORKER (it exists now). Paste a random value,
#    e.g. the output of:  openssl rand -hex 32
npx wrangler secret put REPRO_SECRET

# 5. Configure the client: copy .env.example -> .env and fill in
#    WORKER_URL   = the URL printed in step 3
#    REPRO_SECRET = the SAME value you pasted in step 4
cp .env.example .env
```

## Reproduce

```bash
node scripts/repro.mjs        # or pick a count: node scripts/repro.mjs 20
```

It creates a workspace, writes a file, snapshots it, destroys the original, then creates N
(default 10) workspaces from that snapshot concurrently — the path our scheduled jobs use.
Example output:

```
worker:  sandbox-sdk-issue-794.<you>.workers.dev
run_id:  e31a3293-…

1. create workspace
   -> 9c1f4e2a-…
2. write file
3. snapshot
   -> d664ffee-…
4. destroy original workspace
5. create 10 workspaces from the snapshot, concurrently
   [00] OK   start=+0ms end=+3275ms run_instance_id=e1548591-… workspaceId=47b30a72-…
   [02] FAIL start=+1ms end=+28139ms run_instance_id=f83ce5bb-… there is no container instance that can be provided to this durable object
   [03] OK   start=+2ms end=+9941ms run_instance_id=c614ab51-… workspaceId=cc209571-…
   [08] FAIL start=+6ms end=+18368ms run_instance_id=91343c7e-… The sandbox container stopped while the operation was pending. context={"reason":"runtime_replaced","retryable":true,"containerExitCode":137,"stopReason":"runtime_signal"}
   ...

---- summary: 7/10 ok · 3/10 failed ----
run_id: e31a3293-…
created (still running): 47b30a72-… cc209571-… …
check the dashboard — failed starts may leave containers stuck in Running.
```

Take the `run_instance_id` from a `FAIL` line and search for it in the Worker → **Observability**
→ **Traces** UI to open that request's trace and read the accurate error.

Expected: all N succeed (the account is well below its instance cap). The failure rate scales with
concurrency — it shows up as low as 2–3 concurrent and is roughly 30–40% at 10. Re-run a few times.

## The container leak

Open the Worker → **Durable Objects** (container app `sandbox-sdk-issue-794`) →
**Instances**. After a burst, one or two instances sit in the **Running** state whose id does
**not** appear in the script's `created (...)` list — orphans from the failed starts. They stay
Running on their own. (Successful creates return their `workspaceId`; failed ones never return an
id, which is why the orphans are only visible on the dashboard.)

## RPC reference

All calls are `POST /` with header `Authorization: Bearer <token>` and body `{ method, params }`.
See `scripts/repro.mjs` for how the token is minted and each method is called.

| method | params | returns |
|--------|--------|---------|
| `create_workspace` | `{ snapshotId? }` | `{ workspaceId, status }` |
| `bash` | `{ workspaceId, command }` | `{ stdout, stderr, exitCode }` |
| `snapshot_workspace` | `{ workspaceId }` | `{ workspaceId, snapshotId }` |
| `destroy_workspace` | `{ workspaceId }` | `{ workspaceId, destroyed }` |

## Cleanup

`repro.mjs` leaves the successful sandboxes running so you can inspect them; they idle-stop after
~10 minutes. The leaked (orphaned) instances have no id in the output, so reap them from the
dashboard — or just remove everything via **Tear down** below.

## Tear down the deployment

Remove everything this repro created:

```bash
# 1. Delete the Worker (removes its Durable Objects and stops running containers).
npx wrangler delete

# 2. Delete the container application. `wrangler delete` does NOT remove it, and a leftover
#    app blocks re-deploying under the same name. Find its ID, then delete it:
npx wrangler containers list                 # the app named sandbox-sdk-issue-794-sandbox
npx wrangler containers delete <ID>

# 3. Delete the R2 bucket that held the snapshots. If it refuses because it isn't empty,
#    delete it from the dashboard (R2 → the bucket → Delete), which clears the contents.
npx wrangler r2 bucket delete sandbox-sdk-issue-794-backups
```

The `REPRO_SECRET` Worker secret is removed with the Worker in step 1.

## Notes

- `instance_type = basic`, `max_instances = 10` — the failures occur from an empty account, so
  this is not a capacity limit.
- Running the creations sequentially (one at a time) produces no failures.
- The SDK is pinned to the preview build `pkg.pr.new/@cloudflare/sandbox@799` (PR #799, the
  maintainer's RPC robustness + tracing fixes); the base image stays at `0.12.2`. The issue was
  originally seen with `@cloudflare/sandbox` `0.12.2` (and `0.11.x`), both with the `0.12.2` image.

# Concurrent sandbox creation fails and leaks Running containers

Minimal reproduction for **cloudflare/sandbox-sdk#794**.

A Worker exposes a small authenticated JSON-RPC API (mirroring our production setup) with four
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

## Prerequisites

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
worker: sandbox-sdk-issue-794.<you>.workers.dev

1. create workspace
   -> 9c1f4e2a-…
2. write file
3. snapshot
   -> d664ffee-…
4. destroy original workspace
5. create 10 workspaces from the snapshot, concurrently
   [00] FAIL RPC session was shut down by disposing the main stub
   [01] OK   4119ca0c-…
   [02] FAIL RPC session was shut down by disposing the main stub
   [03] OK   216890c6-…
   ...
7/10 ok · 3/10 failed
created (still running): 4119ca0c-… 216890c6-… …
check the dashboard — failed starts may leave containers stuck in Running.
```

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
- `@cloudflare/sandbox` and the base image are both `0.12.2`; the issue also reproduces on `0.11.x`.

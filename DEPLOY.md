# character-forge Deployment Guide

## Architecture

Single Express server that:
- Serves the Vite-built frontend from `dist/`
- Handles API routes under `/api/`
- Caches generated item sprites in SQLite (`character-forge.db`)
- Proxies D&D Beyond's public character-service endpoint at import time
- With `CF_MULTIPLAYER=1`: online tables (M64) — rooms HTTP API under
  `/api/rooms`, a WebSocket gateway at `/ws` on the same port, the
  encounter event log in SQLite, and uploaded battle maps under
  `<data dir>/maps/`

Rooms live in process memory and the volume forbids replicas, so this is
**one instance** (`numReplicas: 1` in `railway.json`). Every deploy
disconnects every table for the few seconds the swap takes; clients
reconnect with backoff. Avoid deploying while a session is running
(`GET /api/health` shows `sockets`).

## Railway Deployment

### 1. Connect the GitHub repo
- railway.app → **New Project** → **Deploy from GitHub repo**
- Pick `sraths91/character-forge` (or your fork)
- Railway auto-detects `railway.json` and builds on every push to `main`

### 2. Environment variables
Set in the Railway service → Variables:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | — | `production` — enables `dist/` static serving and the volume guard |
| `CF_MULTIPLAYER` | no | unset | `1` enables online tables: the ws gateway at `/ws`, room recovery on boot, the janitor; also disables the global `GET /api/characters` list and requires a room token to write the shared item-sprite cache |
| `ALLOWED_ORIGINS` | prod | — | Comma-separated origins, e.g. `https://character-forge-gh-production.up.railway.app,https://cf.example.com`. Used for CORS **and** for the WebSocket `Origin` check (403 otherwise). A socket from the page's own host is always allowed, so list custom domains and any other front-ends |
| `CF_DATA_DIR` | no | `RAILWAY_VOLUME_MOUNT_PATH`, else `dirname(CF_DB_PATH)` | Directory for persistent data: the DB when `CF_DB_PATH` is unset, and uploaded maps (`maps/<roomId>/`). Must be on the volume in production |
| `CF_DB_PATH` | no | `<data dir>/character-forge.db`, else `<repo>/character-forge.db` | Explicit SQLite file path. Leave unset on Railway to derive it from the volume, or set it under the mount, e.g. `/app/data/character-forge.db` |
| `RAILWAY_VOLUME_MOUNT_PATH` | auto | — | Injected by Railway when a volume is attached. With `NODE_ENV=production`, the server **refuses to boot** if the DB path or data dir is not under it, rather than silently writing to the ephemeral container disk |
| `PORT` | no | `3101` | Railway auto-injects; the server respects it |

### 3. Persistent volume (SQLite)
Settings → **Volumes**:
- Mount path: `/app/data` (`railway.json` sets `requiredMountPath`, so a deploy without it fails)
- Size: **5 GB**. Maps are capped at 20 per room / 100 MB per room, and
  uploads are refused (507) above 70 % volume use; the event log is small
  (~0.7 KB per event) and the janitor trims it.

Railway then injects `RAILWAY_VOLUME_MOUNT_PATH=/app/data`, and with no other
configuration the database lives at `/app/data/character-forge.db`. An existing
`CF_DB_PATH=/app/data/character-forge.db` keeps working. A `CF_DB_PATH` or
`CF_DATA_DIR` outside the mount fails startup with a `startup failed` log line.

### Schema migrations
On boot the server applies any pending `api/db/migrations/NNNN_name.sql` files
(recorded in `schema_migrations`). Before applying anything to an existing DB
it writes `<db>.pre-NNNN.bak` next to it (last 3 kept). It refuses to boot if
an applied migration file was edited or the DB is newer than the code, so a
rollback to an older build after a schema change needs the matching backup.

### 4. Health check
Railway uses `GET /api/health` (configured in `railway.json`). It runs
`SELECT 1` against the database and returns:
```json
{ "ok": true, "time": 1715432100000, "migrationVersion": 2, "dataDir": "/app/data", "sockets": 0, "rooms": 0 }
```
(`sockets` / `rooms` only with `CF_MULTIPLAYER=1`.)
If the database is unusable it returns `503 { "ok": false, "error": "database unavailable" }`.
Railway auto-restarts the service if this stops responding.

### Multiplayer operations (`CF_MULTIPLAYER=1`)
- **WebSocket**: `wss://<host>/ws`, same port as HTTP (Railway supports
  it natively). Auth is the first message (`hello {token}`), never the URL.
  Limits: 16 KiB frames, 20 msg/s (burst 40), 30 s heartbeat.
- **Shutdown** (SIGTERM, `drainingSeconds: 30`): rooms stop taking intents
  and persist, sockets close with 1012, then HTTP drains and the DB closes
  (WAL checkpoint). A turn in flight is replayed on the next boot.
- **Recovery**: on boot every live encounter is reloaded; a running one
  comes back **paused** and continues when the DM presses resume
  (`dm.resume`) once the players have reconnected. An encounter saved by
  an incompatible engine build is marked `abandoned`.
- **Janitor** (hourly): deletes event logs of encounters ended > 7 days
  ago, rooms idle 30 days (with their maps), and checkpoints the WAL
  above 64 MB.
- **Security headers**: a report-only `Content-Security-Policy` on every
  response (`script-src 'self'`, …) — watch the browser console before
  switching it to enforcing. Map files are served with `nosniff` and
  `default-src 'none'`.
- **Rate limits** (per IP): room create 5/hour, join 10/minute, import
  20/minute, monster search 60/minute and monster lookups 120/minute
  (cache hits are not counted), item sprites 200/minute.

### 5. Deploy
Push to `main` → Railway picks up the change, runs `npm ci && npm run build`, then `NODE_ENV=production node api/server.js`. First build takes ~2 minutes; subsequent builds reuse the npm cache.

### 6. Verify
- `GET https://character-forge-gh-production.up.railway.app/api/health` → `{"ok":true,...}`
- Open the root URL → import UI loads
- Paste a public D&D Beyond character URL → sprite renders

## Custom domain (optional)
Networking → **Custom Domain** → add `character-forge.yourdomain.com`. Create a CNAME pointing at the Railway target. HTTPS provisions automatically via Let's Encrypt.

## CI

`.github/workflows/ci.yml` runs on every push and PR to `main`:
- **lint**: Node 22, `npm run lint`
- **test**: Node 22+24 matrix, full `npm test` suite
- **build**: Node 22, verifies `npm run build` produces `dist/index.html`

CI must pass before merging.

## Local development

```bash
# Frontend (Vite dev server on :3100, proxies /api to :3101)
npm run dev

# API server (on :3101)
npm run dev:api

# Both concurrently
npm run dev:all

# Tests
npm test

# Lint
npm run lint

# Production build
npm run build && npm start
```

## D&D Beyond rate limits

The app uses D&DB's undocumented public character-service endpoint
(`character-service.dndbeyond.com/character/v5/character/<id>`). Only public
characters resolve. The endpoint is unofficial and may break or rate-limit
without notice. Imports are rate-limited server-side (20/minute per IP) and
time out after 8 s, as do Open5e lookups (SRD 5.1 creatures only).

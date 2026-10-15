# character-forge Deployment Guide

## Architecture

Single Express server that:
- Serves the Vite-built frontend from `dist/`
- Handles API routes under `/api/`
- Caches generated item sprites in SQLite (`character-forge.db`)
- Proxies D&D Beyond's public character-service endpoint at import time

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
| `CF_DATA_DIR` | no | `RAILWAY_VOLUME_MOUNT_PATH`, else `dirname(CF_DB_PATH)` | Directory for persistent data (the DB when `CF_DB_PATH` is unset; uploaded maps later). Must be on the volume in production |
| `CF_DB_PATH` | no | `<data dir>/character-forge.db`, else `<repo>/character-forge.db` | Explicit SQLite file path. Leave unset on Railway to derive it from the volume, or set it under the mount, e.g. `/app/data/character-forge.db` |
| `RAILWAY_VOLUME_MOUNT_PATH` | auto | — | Injected by Railway when a volume is attached. With `NODE_ENV=production`, the server **refuses to boot** if the DB path or data dir is not under it, rather than silently writing to the ephemeral container disk |
| `PORT` | no | `3101` | Railway auto-injects; the server respects it |

### 3. Persistent volume (SQLite)
Settings → **Volumes**:
- Mount path: `/app/data`
- Size: 1 GB (item-sprite cache grows linearly with unique items rendered; 1 GB is generous)

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
{ "ok": true, "time": 1715432100000, "migrationVersion": 1, "dataDir": "/app/data" }
```
If the database is unusable it returns `503 { "ok": false, "error": "database unavailable" }`.
Railway auto-restarts the service if this stops responding.

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
- **test**: Node 20+22 matrix, full `npm test` suite (currently 129 tests)
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
without notice. Imports are rate-limited server-side (20/minute per IP) to
be polite.

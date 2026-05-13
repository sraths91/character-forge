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
| `NODE_ENV` | yes | — | `production` — enables `dist/` static serving |
| `CF_DB_PATH` | yes (in Railway) | `<repo>/character-forge.db` | Point at the persistent volume so the item-sprite cache survives redeploys, e.g. `/app/data/character-forge.db` |
| `PORT` | no | `3101` | Railway auto-injects; the server respects it |

### 3. Persistent volume (SQLite)
Settings → **Volumes**:
- Mount path: `/app/data`
- Size: 1 GB (item-sprite cache grows linearly with unique items rendered; 1 GB is generous)

Then set `CF_DB_PATH=/app/data/character-forge.db` so the database lives on the volume.

### 4. Health check
Railway uses `GET /api/health` (configured in `railway.json`). It returns:
```json
{ "ok": true, "time": 1715432100000 }
```
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

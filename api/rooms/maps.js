// Map upload and serving (M64 B10).
//
//   PUT    /api/rooms/:id/maps[?filename=x.png][&kind=map|token]  (DM)  raw image body ≤ 10 MB
//            → 201 {mapId, kind, url, mime, width, height, bytes, sha256}  (200 when already uploaded)
//   GET    /api/rooms/:id/maps                   (member) → {maps: [...]}
//   DELETE /api/rooms/:id/maps/:mapId            (DM)  → {ok}
//   GET    /api/maps/<roomId>/<sha256>.<ext>     immutable static file
//
// Validation: magic bytes + header dimensions (lib/image-sniff.js), PNG /
// JPEG / WebP only (GIF, SVG and anything else → 415, as is a declared
// Content-Type or filename extension that disagrees with the bytes),
// ≤ 8192 px per side and ≤ 16.7 MP (422), 20 maps / 100 MB per room and
// ≤ 70 % volume use (409 / 507). Files are content-addressed, written to a
// temp file and renamed into place, then recorded; a failed insert unlinks.
//
// Token images (M64 1.5 W6, `kind=token`, uploaded_maps.kind from
// migration 0005): the DM's picture for a non-humanoid monster. Same
// sniffing, ≤ 1024 px per side, 20 per room (counted apart from maps,
// the 100 MB room budget shared), served at the same static path. The
// same bytes uploaded twice return the first row whatever its kind.

import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, unlinkSync, statfsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { sniffImage, dimensionProblem, IMAGE_TYPES, MAP_LIMITS } from '../lib/image-sniff.js';
import { bearerToken, newId } from './tokens.js';
import { RoomError } from './service.js';

export const MAP_QUOTA = Object.freeze({ maxBytes: 10 * 1024 * 1024, maxMaps: 20, maxRoomBytes: 100 * 1024 * 1024, maxVolumeUse: 0.7 });

/** Upload kinds (uploaded_maps.kind). */
export const MAP_KINDS = Object.freeze(['map', 'token']);
/** Token images: one creature's picture, ≤ 1024 px per side. */
export const TOKEN_LIMITS = Object.freeze({ maxSide: 1024, maxPixels: 1024 * 1024 });

const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * @param {import('express').Express} app
 * @param {object} o
 * @param {ReturnType<import('./service.js').createRoomService>} o.rooms
 * @param {import('better-sqlite3').Database} o.conn
 * @param {string|null} o.dataDir
 * @param {typeof MAP_QUOTA} [o.quota]
 * @param {(path: string) => {blocks: number, bavail: number}} [o.statfs]
 * @param {() => number} [o.now]
 * @param {(level: string, msg: string, extra?: object) => void} [o.log]
 */
export function mountMapRoutes(app, { rooms, conn, dataDir, quota = MAP_QUOTA, statfs = statfsSync, now = Date.now, log = () => {} }) {
  const mapsRoot = dataDir ? join(dataDir, 'maps') : null;
  const q = {
    usage: conn.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM uploaded_maps WHERE room_id = ?'),
    kindCount: conn.prepare('SELECT COUNT(*) AS n FROM uploaded_maps WHERE room_id = ? AND kind = ?'),
    bySha: conn.prepare('SELECT * FROM uploaded_maps WHERE room_id = ? AND sha256 = ?'),
    byId: conn.prepare('SELECT * FROM uploaded_maps WHERE room_id = ? AND id = ?'),
    list: conn.prepare('SELECT * FROM uploaded_maps WHERE room_id = ? ORDER BY created_at, id'),
    insert: conn.prepare(`INSERT INTO uploaded_maps (id, room_id, rel_path, mime, bytes, sha256, width, height, uploaded_by_participant_id, created_at, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    remove: conn.prepare('DELETE FROM uploaded_maps WHERE room_id = ? AND id = ?'),
    shaUsers: conn.prepare('SELECT COUNT(*) AS n FROM uploaded_maps WHERE room_id = ? AND sha256 = ?')
  };
  const publicMap = (r) => ({
    mapId: r.id, kind: r.kind || 'map', url: `/api/${r.rel_path.replace(/^maps\//, 'maps/')}`, mime: r.mime,
    width: r.width, height: r.height, bytes: r.bytes, sha256: r.sha256, createdAt: r.created_at
  });

  function auth(req, roomId, { dm = false } = {}) {
    const a = rooms.authenticate(bearerToken(req));
    if (!a || a.roomId !== roomId) throw new RoomError(401, 'UNAUTHENTICATED', 'A token for this room is required');
    if (dm && a.role !== 'dm') throw new RoomError(403, 'E_FORBIDDEN', 'Only the DM can do that');
    return a;
  }

  // Auth runs before the body is read, so strangers cannot make us buffer 10 MB.
  const requireDm = (req, _res, next) => {
    try { req.member = auth(req, req.params.id, { dm: true }); next(); } catch (err) { next(err); }
  };
  const rawBody = express.raw({ type: () => true, limit: quota.maxBytes });

  app.put('/api/rooms/:id/maps', requireDm, rawBody, (req, res, next) => {
    try {
      if (!mapsRoot) throw new RoomError(503, 'NO_STORAGE', 'Map storage is not configured');
      const kind = req.query.kind === undefined ? 'map' : req.query.kind;
      if (!MAP_KINDS.includes(kind)) throw new RoomError(400, 'BAD_KIND', `kind must be ${MAP_KINDS.join(' or ')}`);
      const noun = kind === 'token' ? 'token image' : 'map';
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length === 0) throw new RoomError(400, 'EMPTY', 'Send the image bytes as the request body');
      const sniff = sniffImage(body);
      if (!sniff.ok) {
        const what = sniff.reason === 'gif' ? 'GIF' : sniff.reason === 'svg' ? 'SVG' : null;
        throw new RoomError(415, 'UNSUPPORTED_MEDIA', what ? `${what} ${noun}s are not accepted; use PNG, JPEG or WebP`
          : `Not a readable PNG, JPEG or WebP image (${sniff.reason})`);
      }
      const declared = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (declared && declared !== 'application/octet-stream' && declared !== sniff.mime) {
        throw new RoomError(415, 'UNSUPPORTED_MEDIA', `Content-Type ${declared} does not match the image bytes (${sniff.mime})`);
      }
      const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
      const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase();
      if (filename && EXT_MIME[ext] !== sniff.mime) {
        throw new RoomError(415, 'UNSUPPORTED_MEDIA', `The file name ${filename} does not match the image bytes (${sniff.mime})`);
      }
      const problem = dimensionProblem(sniff, kind === 'token' ? TOKEN_LIMITS : MAP_LIMITS);
      if (problem) throw new RoomError(422, 'BAD_DIMENSIONS', problem);

      const roomId = req.params.id;
      const sha256 = createHash('sha256').update(body).digest('hex');
      const existing = q.bySha.get(roomId, sha256);
      if (existing) return res.status(200).json(publicMap(existing));

      const use = q.usage.get(roomId);
      if (q.kindCount.get(roomId, kind).n >= quota.maxMaps) throw new RoomError(409, 'QUOTA', `A room holds at most ${quota.maxMaps} ${noun}s`);
      if (use.bytes + body.length > quota.maxRoomBytes) throw new RoomError(409, 'QUOTA', 'This room is out of map storage');
      const fs = statfs(dataDir);
      if (fs.blocks > 0 && 1 - fs.bavail / fs.blocks > quota.maxVolumeUse) {
        throw new RoomError(507, 'VOLUME_FULL', 'The server is low on storage');
      }

      const dir = join(mapsRoot, roomId);
      mkdirSync(dir, { recursive: true });
      const fileName = `${sha256}.${IMAGE_TYPES[sniff.mime]}`;
      const relPath = `maps/${roomId}/${fileName}`;
      const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
      const final = join(dir, fileName);
      writeFileSync(tmp, body, { flag: 'wx' });
      renameSync(tmp, final);
      const id = newId('map_');
      try {
        q.insert.run(id, roomId, relPath, sniff.mime, body.length, sha256, sniff.width, sniff.height, req.member.participantId, now(), kind);
      } catch (err) {
        try { unlinkSync(final); } catch { /* already gone */ }
        throw err;
      }
      res.status(201).json(publicMap(q.byId.get(roomId, id)));
      if (kind === 'token') log('info', 'maps: token image uploaded', { roomId, bytes: body.length, width: sniff.width, height: sniff.height });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/rooms/:id/maps', (req, res, next) => {
    try {
      auth(req, req.params.id);
      res.json({ maps: q.list.all(req.params.id).map(publicMap) });
    } catch (err) { next(err); }
  });

  app.delete('/api/rooms/:id/maps/:mapId', (req, res, next) => {
    try {
      auth(req, req.params.id, { dm: true });
      const row = q.byId.get(req.params.id, req.params.mapId);
      if (!row) throw new RoomError(404, 'NOT_FOUND', 'No such map');
      q.remove.run(req.params.id, row.id);
      if (q.shaUsers.get(req.params.id, row.sha256).n === 0 && mapsRoot) rmSync(join(dataDir, row.rel_path), { force: true });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  // Immutable static serving, outside the production-only SPA block and
  // ahead of the /api JSON 404. Missing files are a JSON 404 (fallthrough
  // off → the error middleware), never index.html.
  if (mapsRoot) {
    app.use('/api/maps', express.static(mapsRoot, {
      index: false,
      dotfiles: 'deny',
      fallthrough: false,
      redirect: false,
      cacheControl: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'");
      }
    }));
  }
}

/** Remove a room's map directory (janitor). */
export function removeRoomMaps(dataDir, roomId, rm = rmSync) {
  if (!dataDir || !/^[A-Za-z0-9_-]+$/.test(roomId)) return;
  rm(join(dataDir, 'maps', roomId), { recursive: true, force: true });
}

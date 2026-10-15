// Rooms HTTP API (M64 B6). Tokens travel only in `Authorization: Bearer`
// headers (never in URLs) and are returned exactly once.
//
//   POST   /api/rooms                         {name?}                   → 201 {roomId, code, dmToken, participantId}
//   POST   /api/rooms/join                    {code, displayName}       → 201 {roomId, participantId, token, displayName}
//   GET    /api/rooms/:id                     (member)                  → {room, me, members, seats}
//   POST   /api/rooms/:id/kick                (DM) {participantId}      → {ok}
//   POST   /api/rooms/:id/seats/:seat/claim   (player: self; DM: {participantId}) {characterId} → {seat}
//   POST   /api/rooms/:id/seats/:seat/ai      (DM) {characterId, archetype?, force?}         → {seat}
//   DELETE /api/rooms/:id/seats/:seat         (DM, or the seat's player) → {ok}
//
// `characterId` is the ddb id returned by POST /api/import?room=<roomId>.

import { publicSeat } from './service.js';
import { bearerToken } from './tokens.js';

/**
 * Mount the rooms routes.
 * @param {import('express').Express} app
 * @param {object} ctx
 * @param {ReturnType<import('./service.js').createRoomService>} ctx.rooms
 * @param {(name: string) => import('express').RequestHandler} ctx.limiter
 */
export function mountRoomRoutes(app, { rooms, limiter }) {
  const auth = (req) => rooms.authenticate(bearerToken(req));
  const wrap = (fn) => (req, res, next) => {
    try { fn(req, res); } catch (err) { next(err); }
  };
  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  app.post('/api/rooms', limiter('roomCreate'), wrap((req, res) => {
    res.status(201).json(rooms.createRoom({ name: body(req).name ?? null }));
  }));

  app.post('/api/rooms/join', limiter('roomJoin'), wrap((req, res) => {
    const { code, displayName } = body(req);
    res.status(201).json(rooms.joinRoom({ code, displayName }));
  }));

  app.get('/api/rooms/:id', wrap((req, res) => {
    res.json(rooms.describe(auth(req), req.params.id));
  }));

  app.post('/api/rooms/:id/kick', wrap((req, res) => {
    res.json(rooms.kick(auth(req), req.params.id, body(req).participantId));
  }));

  app.post('/api/rooms/:id/seats/:seat/claim', wrap((req, res) => {
    const { characterId, participantId } = body(req);
    res.json({ seat: publicSeat(rooms.claimSeat(auth(req), req.params.id, req.params.seat, { characterId, participantId })) });
  }));

  app.post('/api/rooms/:id/seats/:seat/ai', wrap((req, res) => {
    const { characterId, archetype, force } = body(req);
    res.json({ seat: publicSeat(rooms.assignAiSeat(auth(req), req.params.id, req.params.seat, { characterId, archetype, force: force === true })) });
  }));

  app.delete('/api/rooms/:id/seats/:seat', wrap((req, res) => {
    res.json(rooms.releaseSeat(auth(req), req.params.id, req.params.seat));
  }));
}

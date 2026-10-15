// Room identity primitives (M64 B4/B6): bearer tokens, their hashes, room
// codes, ids, and display-name rules. Pure Node crypto; no DB access.

import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Crockford base32 alphabet (no I, L, O, U). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Length of a room join code. */
export const ROOM_CODE_LENGTH = 6;
/** Longest display name, in code points, after normalisation. */
export const MAX_DISPLAY_NAME = 32;

/**
 * A fresh bearer token: 32 random bytes (256 bits), base64url.
 * Returned to the client exactly once; only {@link hashToken} is stored.
 * @returns {string}
 */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 of a token, base64url. Tokens are looked up by hash, so no
 * secret is ever compared in memory.
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('base64url');
}

/**
 * A random id: 16 bytes (128 bits) base64url, optionally prefixed.
 * @param {string} [prefix='']
 * @returns {string}
 */
export function newId(prefix = '') {
  return prefix + randomBytes(16).toString('base64url');
}

/**
 * A random 6-character Crockford base32 room code.
 * @param {(max: number) => number} [rand=randomInt]  injectable for tests
 * @returns {string}
 */
export function generateRoomCode(rand = randomInt) {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += CROCKFORD_ALPHABET[rand(CROCKFORD_ALPHABET.length)];
  return out;
}

/**
 * Normalise a typed room code: upper-case, drop spaces and hyphens, and
 * map Crockford's look-alikes (O→0, I/L→1). Returns null when the result
 * is not a well-formed code.
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeRoomCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of s) if (!CROCKFORD_ALPHABET.includes(ch)) return null;
  return s;
}

// Cc (controls), bidi embeddings/overrides/isolates, zero-width and other
// invisible format characters, line/paragraph separators.
const STRIP_RE = /[\p{Cc}\u061C\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]/gu;

/**
 * Apply the display-name rules: NFC-normalise, strip control, bidi and
 * zero-width characters, collapse whitespace, trim, and require 1–32 code
 * points.
 * @param {unknown} input
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
export function sanitizeDisplayName(input) {
  if (typeof input !== 'string') return { ok: false, error: 'displayName must be a string' };
  const name = input.normalize('NFC').replace(STRIP_RE, '').replace(/\s+/gu, ' ').trim();
  const len = [...name].length;
  if (len < 1) return { ok: false, error: 'displayName is empty' };
  if (len > MAX_DISPLAY_NAME) return { ok: false, error: `displayName is longer than ${MAX_DISPLAY_NAME} characters` };
  return { ok: true, name };
}

/**
 * Read `Authorization: Bearer <token>`.
 * @param {import('express').Request|{headers: Record<string, string|undefined>}} req
 * @returns {string|null}
 */
export function bearerToken(req) {
  const h = req.headers?.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})\s*$/.exec(h);
  return m ? m[1] : null;
}

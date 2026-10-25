/**
 * M65 C28 — durable room credentials, one per room code.
 *
 * A room token is a resume token: presenting it again brings back the
 * same participant, seat and DM role. sessionStorage (this tab) keeps the
 * room the tab is in, so a reload reconnects; localStorage keeps every
 * room this device joined or created, keyed by room code, so closing the
 * tab or the browser and coming back is "rejoin by code" instead of a new
 * join (which would make a new participant and lose the seat).
 *
 *   localStorage  `cf-room-creds`  {[code]: {roomId, code, token, role, displayName, savedAt}}
 *   sessionStorage `cf-play-creds` {roomId, code, token, role}   (the active room)
 *
 * "Forget this device" deletes a code's entry (the participant stays in
 * the room until the DM kicks it). Every storage call is guarded: private
 * mode leaves the store working in memory.
 */

/** localStorage key (durable, per room code). */
export const ROOM_CREDS_STORAGE = 'cf-room-creds';
/** sessionStorage key (this tab's active room). */
export const SESSION_CREDS_STORAGE = 'cf-play-creds';

const CODE_RE = /^[0-9A-Z]{6}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Normalise a creds object; null when it is not usable.
 * @param {unknown} c
 * @returns {{roomId: string, code: string, token: string, role: 'dm'|'player', displayName?: string}|null}
 */
export function cleanCreds(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.roomId !== 'string' || !c.roomId || typeof c.token !== 'string' || !TOKEN_RE.test(c.token)) return null;
  const code = typeof c.code === 'string' ? c.code.toUpperCase() : '';
  return {
    roomId: c.roomId, code, token: c.token, role: c.role === 'dm' ? 'dm' : 'player',
    ...(typeof c.displayName === 'string' && c.displayName ? { displayName: c.displayName.slice(0, 32) } : {})
  };
}

function readJson(storage, key) {
  try {
    const raw = storage?.getItem?.(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeJson(storage, key, value) {
  try {
    if (value === null) storage?.removeItem?.(key);
    else storage?.setItem?.(key, JSON.stringify(value));
  } catch { /* private mode / quota: memory only */ }
}

/**
 * @param {{session?: Storage|null, durable?: Storage|null, now?: () => number}} [opts]
 * @returns {{
 *   active: () => object|null, setActive: (creds: object|null) => void,
 *   remembered: () => object[], byCode: (code: string) => object|null,
 *   remember: (creds: object) => boolean, forget: (code: string) => void
 * }}
 */
export function createRoomCreds({ session = null, durable = null, now = () => Date.now() } = {}) {
  let memory = null;
  function all() {
    if (memory) return memory;
    const raw = readJson(durable, ROOM_CREDS_STORAGE);
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [code, v] of Object.entries(raw)) {
        const c = cleanCreds(v);
        if (c && CODE_RE.test(code) && c.code === code) out[code] = { ...c, savedAt: Number(v.savedAt) || 0 };
      }
    }
    memory = out;
    return memory;
  }
  function save(next) { memory = next; writeJson(durable, ROOM_CREDS_STORAGE, next); }

  return {
    active() { return cleanCreds(readJson(session, SESSION_CREDS_STORAGE)); },
    setActive(creds) { writeJson(session, SESSION_CREDS_STORAGE, creds ? cleanCreds(creds) : null); },
    remembered() { return Object.values(all()).sort((a, b) => b.savedAt - a.savedAt); },
    byCode(code) { return all()[String(code || '').toUpperCase()] || null; },
    remember(creds) {
      const c = cleanCreds(creds);
      if (!c || !CODE_RE.test(c.code)) return false;
      save({ ...all(), [c.code]: { ...(all()[c.code] || {}), ...c, savedAt: now() } });
      return true;
    },
    forget(code) {
      const next = { ...all() };
      delete next[String(code || '').toUpperCase()];
      save(next);
    }
  };
}

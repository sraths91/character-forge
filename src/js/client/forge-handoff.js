/**
 * M65 V21 — the forge → table handoff ("Play at the table").
 *
 * The forge's versus panel no longer runs its own combat driver: it
 * creates a server-hosted solo room (`POST /api/rooms {mode: 'solo'}`,
 * E3's B28 — the DM drives every seat no player holds), imports the forge
 * party into it, seats each member as a DM-driven AI seat, and hands
 * play.html a pre-filled encounter setup (the queued monsters, flanking
 * and the current map). play.html opens in the same tab with the room
 * code; the DM creds go through room-creds.js like any created room.
 *
 * Character import: a member whose raw D&D Beyond JSON the forge kept
 * (pasted imports, `stashForgeJson`) is re-posted as `{json}`; a member
 * imported by URL / id is imported by `{characterId}` (the server
 * re-fetches it). A character already in the room is reused, not
 * re-imported. A pasted member whose JSON this browser no longer holds is
 * skipped with a warning.
 *
 *   sessionStorage `cf-forge-handoff` {code, roomId, setup, warnings, createdAt}
 *   localStorage   `cf-forge-json:<forgeId>` the raw JSON of a pasted import
 *
 * Pure apart from the injected api / storages: Node-testable against a
 * real in-process server.
 */

import { PC_PROFILES } from '../scene/ai/pc-profiles.js';
import { MONSTER_PRESETS } from '../scene/monster-presets.js';
import { calibFromKnownSize } from '../map/calibration.js';

/** sessionStorage key: the setup play.html pre-fills once. */
export const HANDOFF_STORAGE = 'cf-forge-handoff';
/** localStorage key prefix: a pasted character's raw DDB JSON. */
export const FORGE_JSON_PREFIX = 'cf-forge-json:';
/** A DDB character JSON is ~100–400 KB; refuse anything far beyond. */
const FORGE_JSON_MAX_CHARS = 1_500_000;
/** A handoff older than this is ignored by play.html. */
export const HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;

function log(level, event, fields = {}) {
  try { globalThis.console?.[level]?.(JSON.stringify({ event, ...fields })); } catch { /* logging never throws */ }
}

/**
 * Keep a pasted character's raw JSON so the handoff can import it into a
 * room later. Best effort: quota / private mode just skips it.
 * @param {Storage|null} storage — localStorage
 * @param {string} characterId — the forge's parsed id (e.g. `paste:123`)
 * @param {object} raw — the pasted DDB JSON
 * @returns {boolean} stored
 */
export function stashForgeJson(storage, characterId, raw) {
  if (!storage || !characterId || !raw || typeof raw !== 'object') return false;
  try {
    const text = JSON.stringify(raw);
    if (text.length > FORGE_JSON_MAX_CHARS) return false;
    storage.setItem(FORGE_JSON_PREFIX + characterId, text);
    return true;
  } catch (err) {
    log('warn', 'forge_handoff.stash_failed', { characterId, error: String(err?.message || err) });
    return false;
  }
}

/**
 * @param {Storage|null} storage
 * @param {string} characterId
 * @returns {object|null} the stashed raw JSON
 */
export function forgeJsonFor(storage, characterId) {
  try {
    const raw = storage?.getItem?.(FORGE_JSON_PREFIX + characterId);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * The server AI archetype for a forge PC: the PC_PROFILES key whose
 * archetype the forge's AI editor picked, else 'auto' (infer from class).
 * @param {object} pc
 * @returns {string}
 */
export function archetypeFor(pc) {
  const picked = pc?._aiProfile?.archetype;
  if (!picked) return 'auto';
  const key = Object.keys(PC_PROFILES).find(k => PC_PROFILES[k].archetype === picked);
  return key || 'auto';
}

/** `data:<mime>;base64,<…>` → {bytes, mime}, or null. */
export function dataUrlBytes(dataUrl) {
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  try {
    const bin = globalThis.atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1].toLowerCase() };
  } catch { return null; }
}

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(Number(v) || 0)));

/**
 * The `dm.encounter.setup` payload the forge hands the table (the shape
 * views/setup.js `setupPayload` makes, so `draftFromSetup` inverts it).
 *
 * @param {object} args
 * @param {object} args.scene — the forge's current scene (scene-state shape)
 * @param {{id: string, slug: string, name: string}[]} args.encounter — the queued monsters
 * @param {{seat: number, forgeId: string}[]} args.seats — the seated party, in order
 * @param {{mapId: string, url: string, width: number, height: number}|null} [args.image] — the room map upload of an image scene
 * @returns {object} setup payload
 */
export function forgeSetupPayload({ scene, encounter = [], seats = [], image = null }) {
  const cols = clampInt(scene?.cols ?? 10, 4, 60);
  const rows = clampInt(scene?.rows ?? 7, 4, 60);
  const sm = scene?.map || {};
  let map;
  if (sm.kind === 'image' && image?.mapId) {
    const imgW = image.width || cols * 64;
    const imgH = image.height || rows * 64;
    map = { kind: 'image', imageId: image.mapId, url: image.url || null, imgW, imgH, calib: { ...calibFromKnownSize(imgW, imgH, cols, rows).calib } };
  } else if (sm.kind === 'generated' && typeof sm.biome === 'string') {
    map = { kind: 'generated', biome: sm.biome, seed: (sm.seed >>> 0) || 1 };
  } else {
    map = { kind: 'color', color: typeof sm.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(sm.color) ? sm.color : '#3d5a3d' };
  }

  const taken = new Set();
  const key = (p) => `${p.col},${p.row}`;
  const placements = {};
  seats.forEach((s, i) => {
    const saved = scene?.positions?.[s.forgeId];
    let pos = saved && Number.isInteger(saved.col) && Number.isInteger(saved.row)
      ? { col: clampInt(saved.col, 0, cols - 1), row: clampInt(saved.row, 0, rows - 1) }
      : { col: i < rows ? Math.min(1, cols - 1) : 0, row: i % rows };
    if (taken.has(key(pos))) pos = freeCell(taken, cols, rows, 0) || pos;
    taken.add(key(pos));
    placements[`pc-${s.seat}`] = pos;
  });

  const monsters = [];
  encounter.forEach((e, i) => {
    if (!MONSTER_PRESETS[e.slug]) return;
    const id = `m-${monsters.length + 1}`;
    let pos = { col: i < rows ? cols - 2 : cols - 1, row: i % rows };
    if (taken.has(key(pos))) pos = freeCell(taken, cols, rows, cols - 1, -1) || pos;
    taken.add(key(pos));
    placements[id] = pos;
    monsters.push({ id, slug: e.slug, name: String(e.name || MONSTER_PRESETS[e.slug].name).slice(0, 64) });
  });

  const t = scene?.terrain;
  const terrain = t && typeof t.flags === 'string' && t.cols === cols && t.rows === rows ? { ...t } : null;
  return {
    map,
    grid: { cols, rows, ...(terrain ? { terrain } : {}), ...(scene?.flankingEnabled ? { flankingEnabled: true } : {}) },
    monsters,
    placements,
    initiativeMode: 'individual'
  };
}

/** The first free cell scanning columns from `startCol` in direction `dir`. */
function freeCell(taken, cols, rows, startCol, dir = 1) {
  for (let c = startCol; c >= 0 && c < cols; c += dir) {
    for (let r = 0; r < rows; r++) if (!taken.has(`${c},${r}`)) return { col: c, row: r };
  }
  return null;
}

/**
 * Create the solo room, import + seat the party, upload an image map and
 * stash the setup for play.html.
 *
 * @param {object} args
 * @param {Function} args.createApi — client/api.js createApi
 * @param {Function} args.fetch
 * @param {object[]} args.party — the forge party records (selected members), in seat order
 * @param {{id: string, slug: string, name: string}[]} args.encounter — the queued monsters
 * @param {object} args.scene — the forge's current scene
 * @param {object} args.roomCreds — client/room-creds.js createRoomCreds()
 * @param {Storage|null} [args.jsonStorage] — localStorage (stashed pasted JSON)
 * @param {Storage|null} [args.handoffStorage] — sessionStorage (the setup for play.html)
 * @param {(characterId: string) => {style?: string|null, swing?: string|null}} [args.cinemaPick] — the forge's style / swing picks
 * @param {(roomCharacterId: string, pick: object) => void} [args.saveCinemaPick] — carry them to the room id
 * @param {() => number} [args.now]
 * @param {(msg: string) => void} [args.progress]
 * @returns {Promise<{roomId: string, code: string, url: string, setup: object, seats: object[], warnings: string[]}>}
 */
export async function handoffToTable({
  createApi, fetch, party = [], encounter = [], scene = {}, roomCreds,
  jsonStorage = null, handoffStorage = null, cinemaPick = null, saveCinemaPick = null,
  now = () => Date.now(), progress = () => {}
}) {
  if (!party.length) throw new Error('Pick at least one party member.');
  if (!encounter.length) throw new Error('Add at least one opponent.');
  const warnings = [];
  progress('Opening a solo room…');
  const room = await createApi({ fetch }).createRoom(null, { mode: 'solo' });
  const creds = { roomId: room.roomId, code: room.code, token: room.dmToken, role: 'dm', displayName: 'DM' };
  const api = createApi({ fetch, token: () => creds.token });
  log('info', 'forge_handoff.room_created', { roomId: room.roomId, mode: room.mode || 'solo', party: party.length, monsters: encounter.length });

  let already = [];
  try { already = (await api.listCharacters(room.roomId))?.characters || []; } catch { already = []; }
  const seats = [];
  for (const pc of party) {
    const forgeId = String(pc.id);
    let characterId = null;
    const existing = already.find(c => String(c.ddbId) === forgeId);
    if (existing) characterId = String(existing.ddbId);
    else {
      progress(`Importing ${pc.name || forgeId}…`);
      const json = forgeJsonFor(jsonStorage, forgeId);
      try {
        if (json) characterId = (await api.importCharacter(room.roomId, { json }))?.character?.id ?? null;
        else if (/^\d+$/.test(forgeId)) characterId = (await api.importCharacter(room.roomId, { characterId: forgeId }))?.character?.id ?? null;
        else warnings.push(`${pc.name || forgeId}: re-paste the character JSON in the forge to bring it to the table.`);
      } catch (err) {
        warnings.push(`${pc.name || forgeId}: import failed (${err.message}).`);
        log('warn', 'forge_handoff.import_failed', { forgeId, status: err.status ?? null, error: err.message });
      }
    }
    if (!characterId) continue;
    const seat = seats.length + 1;
    await api.aiSeat(room.roomId, seat, characterId, archetypeFor(pc));
    seats.push({ seat, forgeId, characterId, name: pc.name || null });
    const pick = cinemaPick?.(forgeId);
    if (pick && saveCinemaPick) saveCinemaPick(characterId, pick);
  }
  if (!seats.length) throw new Error(`No party member could be brought to the table. ${warnings.join(' ')}`.trim());

  let image = null;
  if (scene?.map?.kind === 'image') {
    const data = dataUrlBytes(scene.map.image);
    if (data) {
      progress('Uploading the map…');
      try {
        image = await api.uploadMap(room.roomId, data.bytes, { filename: `forge-map.${data.mime.includes('png') ? 'png' : 'jpg'}`, mime: data.mime });
      } catch (err) {
        warnings.push(`The map image did not upload (${err.message}); the table starts on a colour map.`);
        log('warn', 'forge_handoff.map_upload_failed', { roomId: room.roomId, error: err.message });
      }
    }
  }

  const setup = forgeSetupPayload({ scene, encounter, seats, image });
  roomCreds.setActive(creds);
  roomCreds.remember(creds);
  try {
    handoffStorage?.setItem?.(HANDOFF_STORAGE, JSON.stringify({ code: room.code, roomId: room.roomId, setup, warnings, createdAt: now() }));
  } catch (err) {
    log('warn', 'forge_handoff.stash_setup_failed', { error: String(err?.message || err) });
  }
  log('info', 'forge_handoff.ready', { roomId: room.roomId, seats: seats.length, monsters: setup.monsters.length, map: setup.map.kind });
  return { roomId: room.roomId, code: room.code, url: `/play.html?code=${encodeURIComponent(room.code)}`, setup, seats, warnings };
}

/**
 * play.html side: the forge's pending setup for the room this tab is in.
 * @param {Storage|null} storage — sessionStorage
 * @param {string} code — the active room code
 * @param {{now?: () => number}} [opts]
 * @returns {{setup: object, warnings: string[]}|null}
 */
export function readHandoff(storage, code, { now = () => Date.now() } = {}) {
  try {
    const raw = storage?.getItem?.(HANDOFF_STORAGE);
    const h = raw ? JSON.parse(raw) : null;
    if (!h || !code || h.code !== code || !h.setup || typeof h.setup !== 'object') return null;
    if (!(now() - (Number(h.createdAt) || 0) <= HANDOFF_MAX_AGE_MS)) return null;
    return { setup: h.setup, warnings: Array.isArray(h.warnings) ? h.warnings.map(String) : [] };
  } catch { return null; }
}

/** Drop the pending handoff (once the setup view applied it). */
export function clearHandoff(storage) {
  try { storage?.removeItem?.(HANDOFF_STORAGE); } catch { /* private mode */ }
}

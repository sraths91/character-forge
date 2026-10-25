/**
 * M64 E5 / M5 — the read-only RenderView the 2D battle renderer draws.
 *
 * `projectBattleView(encounterState, appearanceCache)` turns the
 * server-owned EncounterState (or a per-seat projection of it) into a
 * small, pure-JSON view: what to draw, never how the game works. Two
 * clients holding the same state build deep-equal views. The renderer
 * (`renderBattleScene(canvas, view, local)` in sprite/compositor.js)
 * never mutates it, so a deep-frozen view is fine.
 *
 * RenderView v1:
 * {
 *   v: 1,
 *   encounterId: string|null,
 *   round: number,
 *   activeId: string|null,           // whose turn it is (null outside a running encounter)
 *   grid: {cols, rows, cellFt},
 *   map: {kind: 'color'|'generated'|'image', color, biome?, seed?, preset?,
 *         imageId?, url?, imgW?, imgH?, calib?: {cellPx, offsetX, offsetY}, cinemaBiome?},
 *   terrain: {v, cols, rows, flags}|null,   // wire form (map/terrain.js)
 *   fog: {revealed: string}|null,           // base64 bitset (map/fog.js); null = no fog
 *   tokens: [{
 *     id, kind: 'pc'|'monster', side: 'party'|'hostile', name, col, row,
 *     appearanceKey,                    // bake-cache key for the look (sheet / preset)
 *     hpState: 'healthy'|'wounded'|'down',
 *     size: number,                     // cells per side (1 or 2 …), see below
 *     status?: 'active'|'downed'|'stable'|'dead',
 *     hp?: number, hpMax?: number,      // omitted when the projection redacts them
 *     tempHp: boolean,
 *     conditions: string[],             // condition ids
 *     worstCondition: string|null,      // the one that tints the body
 *     concentration: string|null,       // spell id / name
 *     hidden: boolean,
 *     facing?: 'north'|'east'|'south'|'west',  // sprite row (see below)
 *     imageUrl?: string                 // DM token image (see below)
 *   }]                                  // sorted by row, then col, then id (draw order)
 * }
 *
 * The local (per-viewer) half is NOT in the view; see `renderBattleScene`.
 * Pure, Node-safe, no DOM.
 *
 * v1 additive fields (phase 1.5, E5 — optional, no version bump):
 *   tokens[].facing  'north'|'east'|'south'|'west' — from the client's
 *                    `local.facings` (map/facing.js) or a persisted
 *                    `entity.facing`; absent ⇒ the renderer's default.
 *   tokens[].status  'active'|'downed'|'stable'|'dead' — `entity.status`
 *                    (E1), else derived from hp (map/token-fx.js). Any
 *                    non-active status forces hpState 'down'. Absent on
 *                    legacy-adapter tokens (treated as 'active').
 *   tokens[].size    cells per side (1 Medium and smaller, 2 Large, 3 Huge,
 *                    4 Gargantuan) from `entity.size` or the stat block's
 *                    `size`. RENDERING ONLY: the token is drawn size×size
 *                    anchored at (col,row) and `tokenAtCell` hit-tests
 *                    every covered cell, but movement / reach legality
 *                    (scene/grid-legality.js) stays 1×1 this phase (owner
 *                    default, plan Q3).
 *   tokens[].imageUrl  DM-uploaded token image (same-origin path, see
 *                    isTokenImageUrl) drawn instead of the LPC composite
 *                    (circular mask + side ring, same bake-cache slot).
 *
 * v1 additive fields (M65 M21, E5 — optional, no version bump):
 *   tokens[].imageId  the campaign-authored `statBlock.tokenImageId` the
 *                    token's `imageUrl` was resolved from (absent when the
 *                    entity carried its own `imageUrl`). It is part of the
 *                    image bake key (map/token-cache.js `imageKeyFor`).
 *   Resolution (`resolveTokenImage`): `entity.imageUrl` wins; else the
 *   room's upload for `statBlock.tokenImageId`, looked up through
 *   `opts.tokenImages` (a `tokenImageIndex(maps)` built from
 *   `GET /api/rooms/:id/maps`, a Map, a plain object or a function), or
 *   the appearance cache's `putTokenImages` index. An id the room does
 *   not hold (yet) leaves the token on its LPC look.
 *
 * Corpses (M65 M21): a dead PC is never `hidden` — it stays on the map as
 * the death-fade marker, also on the next encounter's map when the run
 * seeds it `status: 'dead'` (first seen dead → no fade, faint at once).
 */

import { facingFor } from './facing.js';
import { statusOf, isDownStatus, isTokenImageUrl } from './token-fx.js';

/** RenderView version. */
export const RENDER_VIEW_VERSION = 1;

/**
 * Body-tint priority, highest first. Mirrors CONDITION_PRIORITY in
 * sprite/lpc-config.js (not exported there); keep the two in step.
 */
export const CONDITION_PRIORITY = Object.freeze([
  'unconscious', 'petrified', 'paralyzed', 'poisoned', 'frightened', 'charmed', 'invisible', 'stunned'
]);

const DEFAULT_COLOR = '#3d5a3d';

/**
 * Condition ids from plain strings or R7 lifecycle objects.
 * @param {Array<string|{id: string}>} conditions
 * @returns {string[]}
 */
export function conditionIdsOf(conditions) {
  return (Array.isArray(conditions) ? conditions : [])
    .map(c => (typeof c === 'string' ? c : c?.id))
    .filter(c => typeof c === 'string' && c.length > 0);
}

/**
 * The condition that tints the body (highest priority), or null.
 * @param {Array<string|{id: string}>} conditions
 * @returns {string|null}
 */
export function worstConditionOf(conditions) {
  const ids = conditionIdsOf(conditions);
  return CONDITION_PRIORITY.find(c => ids.includes(c)) || null;
}

/**
 * HP bucket the sprite shows (mirrors classifyHpState in lpc-config.js).
 * @param {number|null|undefined} hp
 * @param {number|null|undefined} hpMax
 * @param {number} [deathFailures]
 * @returns {'healthy'|'wounded'|'down'}
 */
export function hpStateOf(hp, hpMax, deathFailures = 0) {
  if ((deathFailures || 0) >= 3) return 'down';
  if (hp === 0) return 'down';
  if (Number.isFinite(hp) && Number.isFinite(hpMax) && hpMax > 0 && hp / hpMax < 0.25) return 'wounded';
  return 'healthy';
}

// FNV-1a 32-bit over a string → 8 hex chars.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Fields that change during play (they are separate bake-key parts) or
// never reach the sprite. Everything else is treated as visual.
const NON_VISUAL_KEYS = new Set([
  'id', 'name', 'hp', 'conditions', 'deathSaves', 'concentration', 'spells', 'combatMods',
  'position', 'pos', '_position', '_reactionUsed', 'damageDealt'
]);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined && typeof value[k] !== 'function').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/**
 * Monster look key: every instance of a preset shares one bake.
 * @param {string} slug
 * @returns {string}
 */
export function monsterAppearanceKey(slug) {
  return `monster:${slug || 'unknown'}`;
}

/**
 * Content key for a character record's LOOK (equipment, race, hair,
 * customisations …), ignoring HP, conditions and other per-turn state.
 * Two records that render the same base sprite share a key.
 * @param {object} character
 * @returns {string}
 */
export function appearanceKeyOf(character) {
  if (!character || typeof character !== 'object') return 'none';
  if (character._isMonster && character._presetSlug) return monsterAppearanceKey(character._presetSlug);
  const visual = {};
  for (const k of Object.keys(character)) {
    if (!NON_VISUAL_KEYS.has(k)) visual[k] = character[k];
  }
  return `a:${fnv1a(stableStringify(visual))}`;
}

/**
 * Client-side store of character sheets by id, keyed for the renderer by
 * appearance. The client fills it once per fetched sheet; the projector
 * reads `keyFor`, the renderer reads `characterFor`.
 * @returns {{put: (characterId: string, character: object) => string,
 *            keyFor: (characterId: string) => string|null,
 *            characterFor: (appearanceKey: string) => object|null,
 *            delete: (characterId: string) => void, clear: () => void}}
 */
export function createAppearanceCache() {
  const keyById = new Map();
  const byKey = new Map();
  let images = new Map();
  return {
    /**
     * M65 M21 — replace the room's token-image index (the
     * `GET /api/rooms/:id/maps` list, see `tokenImageIndex`).
     * @param {object[]|Map<string, string>|Record<string, string>} maps
     */
    putTokenImages(maps) { images = tokenImageIndex(maps); },
    /** Served URL of a room upload by id or sha256, or null. */
    tokenImageUrl(id) { return images.get(String(id)) || null; },
    put(characterId, character) {
      const key = appearanceKeyOf(character);
      keyById.set(String(characterId), key);
      byKey.set(key, character);
      return key;
    },
    keyFor(characterId) { return keyById.get(String(characterId)) || null; },
    characterFor(key) { return byKey.get(key) || null; },
    delete(characterId) { keyById.delete(String(characterId)); },
    clear() { keyById.clear(); byKey.clear(); images = new Map(); }
  };
}

/**
 * M65 M21 — the room's uploads as an id → served URL index. Accepts the
 * `GET /api/rooms/:id/maps` rows (`{mapId, sha256, url, kind}`; each row
 * is indexed by `mapId` and by `sha256`, so a campaign asset copied into
 * the room under a new id still resolves by content), a Map or a plain
 * object of id → url. URLs that fail `isTokenImageUrl` are dropped.
 * @param {object[]|Map<string, string>|Record<string, string>|null} maps
 * @returns {Map<string, string>}
 */
export function tokenImageIndex(maps) {
  const out = new Map();
  const put = (id, url) => {
    if (id != null && id !== '' && isTokenImageUrl(url) && !out.has(String(id))) out.set(String(id), url);
  };
  if (Array.isArray(maps)) {
    for (const row of maps) {
      if (!row || typeof row !== 'object') continue;
      put(row.mapId ?? row.id, row.url);
      put(row.sha256, row.url);
    }
  } else if (maps instanceof Map) {
    for (const [id, url] of maps) put(id, url);
  } else if (maps && typeof maps === 'object') {
    for (const [id, url] of Object.entries(maps)) put(id, url);
  }
  return out;
}

function lookupTokenImage(tokenImages, id) {
  if (!tokenImages || id == null) return null;
  if (typeof tokenImages === 'function') return tokenImages(String(id)) ?? null;
  if (tokenImages instanceof Map) return tokenImages.get(String(id)) ?? null;
  if (typeof tokenImages.tokenImageUrl === 'function') return tokenImages.tokenImageUrl(String(id));
  if (typeof tokenImages === 'object') return tokenImages[String(id)] ?? null;
  return null;
}

/**
 * M65 M21 — the image a token draws: the entity's own `imageUrl` when it
 * has one, else the room's upload for the campaign-authored
 * `statBlock.tokenImageId`. Only same-origin paths (`isTokenImageUrl`)
 * are returned.
 * @param {{imageUrl?: string|null, statBlock?: {tokenImageId?: string|null}|null}} entity
 * @param {Map<string, string>|Record<string, string>|((id: string) => string|null)|{tokenImageUrl: (id: string) => string|null}|null} [tokenImages]
 * @returns {{url: string, imageId: string|null}|null}
 */
export function resolveTokenImage(entity, tokenImages = null) {
  if (isTokenImageUrl(entity?.imageUrl)) return { url: entity.imageUrl, imageId: null };
  const id = entity?.statBlock?.tokenImageId;
  if (typeof id !== 'string' || id.length === 0) return null;
  const url = lookupTokenImage(tokenImages, id);
  return isTokenImageUrl(url) ? { url, imageId: id } : null;
}

function cacheKeyFor(appearanceCache, characterId) {
  if (!appearanceCache || characterId == null) return null;
  if (typeof appearanceCache.keyFor === 'function') return appearanceCache.keyFor(characterId);
  if (appearanceCache instanceof Map) return appearanceCache.get(String(characterId)) || null;
  if (typeof appearanceCache === 'object') return appearanceCache[String(characterId)] || null;
  return null;
}

/**
 * Normalise any map record (EncounterState map, legacy scene map) to the
 * view's map shape. Never carries inline data URLs into the view except
 * the legacy local `image` (single-player scenes).
 * @param {object|null} map
 * @returns {object}
 */
export function viewMapOf(map) {
  if (!map || typeof map !== 'object') return { kind: 'color', color: DEFAULT_COLOR };
  const kind = map.kind || (map.imageId || map.url ? 'image' : map.biome ? 'generated' : 'color');
  const out = { kind, color: map.color || DEFAULT_COLOR };
  if (kind === 'generated') {
    out.biome = map.biome || 'grass';
    out.seed = (map.seed >>> 0) || 0;
    if (map.preset) out.preset = map.preset;
  } else if (kind === 'image') {
    for (const k of ['imageId', 'url', 'image', 'imgW', 'imgH']) if (map[k] != null) out[k] = map[k];
    if (map.calib && map.calib.cellPx > 0) {
      out.calib = { cellPx: map.calib.cellPx, offsetX: map.calib.offsetX || 0, offsetY: map.calib.offsetY || 0 };
    }
  }
  if (map.cinemaBiome) out.cinemaBiome = map.cinemaBiome;
  return out;
}

// Draw order: by the bottom edge (a Large token's lower row), then col, then id.
function compareTokens(a, b) {
  const ab = a.row + tokenSizeOf(a) - 1;
  const bb = b.row + tokenSizeOf(b) - 1;
  return ab - bb || a.row - b.row || a.col - b.col || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const SIZE_CELLS = { tiny: 1, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 };

/**
 * Cells per side for an SRD size name ('Large' → 2). Unknown ⇒ 1.
 * @param {string|null|undefined} size
 * @returns {number}
 */
export function sizeCellsOf(size) {
  return SIZE_CELLS[String(size || '').trim().toLowerCase()] || 1;
}

/**
 * A token's footprint side in cells (defaults to 1).
 * @param {{size?: number}} token
 * @returns {number}
 */
export function tokenSizeOf(token) {
  const n = token?.size;
  return Number.isInteger(n) && n > 1 ? Math.min(n, 4) : 1;
}

/**
 * Every cell a token covers (anchor first, then row-major).
 * @param {{col: number, row: number, size?: number}} token
 * @returns {{col: number, row: number}[]}
 */
export function tokenCells(token) {
  const n = tokenSizeOf(token);
  const out = [];
  for (let dr = 0; dr < n; dr++) for (let dc = 0; dc < n; dc++) out.push({ col: token.col + dc, row: token.row + dr });
  return out;
}

/**
 * The token a click on `cell` hits: the top-most (last-drawn) token whose
 * footprint covers it, preferring the living over dead markers. Hidden
 * tokens count only with `{showHidden: true}` (the DM).
 * @param {{tokens: object[]}} view
 * @param {{col: number, row: number}} cell
 * @param {{showHidden?: boolean, includeDead?: boolean}} [opts]
 * @returns {object|null}
 */
export function tokenAtCell(view, cell, { showHidden = false, includeDead = true } = {}) {
  if (!cell || !Array.isArray(view?.tokens)) return null;
  let dead = null;
  for (let i = view.tokens.length - 1; i >= 0; i--) {
    const t = view.tokens[i];
    if (t.hidden && !showHidden) continue;
    const n = tokenSizeOf(t);
    if (cell.col < t.col || cell.row < t.row || cell.col >= t.col + n || cell.row >= t.row + n) continue;
    if (t.status !== 'dead') return t;
    if (!dead) dead = t;
  }
  return includeDead ? dead : null;
}

/**
 * EncounterState (full or per-seat projection) → RenderView.
 * @param {object} state — EncounterState v1 (shared/encounter-state.js)
 * @param {object} [appearanceCache] — createAppearanceCache(), a Map or a
 *   plain object of characterId → appearanceKey; PCs not in it get the
 *   placeholder key `pc:<characterId>`
 * @param {{facings?: Record<string, string>|Map<string, string>,
 *          tokenImages?: Map<string, string>|Record<string, string>|((id: string) => string|null)}} [opts] —
 *   `facings` is the client-held entity id → direction map (map/facing.js);
 *   `tokenImages` resolves `statBlock.tokenImageId` (see `resolveTokenImage`;
 *   defaults to the appearance cache's `putTokenImages` index)
 * @returns {object} RenderView
 */
export function projectBattleView(state, appearanceCache = null, opts = {}) {
  const grid = state?.grid || {};
  const entities = state?.entities && typeof state.entities === 'object' ? Object.values(state.entities) : [];
  const running = state?.phase === 'running' || state?.phase === 'awaiting-prompt';
  const tokenImages = opts?.tokenImages
    ?? (typeof appearanceCache?.tokenImageUrl === 'function' ? appearanceCache : null);
  const tokens = [];
  for (const e of entities) {
    if (!e || !e.pos) continue;
    const conditions = conditionIdsOf(e.conditions);
    const characterId = e.sheetRef?.characterId ?? null;
    const status = statusOf(e);
    const appearanceKey = e.kind === 'monster'
      ? monsterAppearanceKey(e.statBlock?.slug)
      : (cacheKeyFor(appearanceCache, characterId) || `pc:${characterId ?? e.id}`);
    const token = {
      id: String(e.id),
      kind: e.kind === 'monster' ? 'monster' : 'pc',
      side: e.side === 'hostile' ? 'hostile' : 'party',
      name: String(e.name ?? ''),
      col: e.pos.col,
      row: e.pos.row,
      appearanceKey,
      hpState: isDownStatus(status) ? 'down' : (e.hpState || hpStateOf(e.hp, e.hpMax)),
      size: sizeCellsOf(e.size ?? e.statBlock?.size),
      status,
      tempHp: (e.hpTemp || 0) > 0,
      conditions,
      worstCondition: worstConditionOf(conditions),
      concentration: e.concentration?.spellId ?? null,
      // M65 M21 — a dead PC is a corpse on the map, never hidden.
      hidden: !(e.kind !== 'monster' && status === 'dead') && (e.hidden === true || conditions.includes('hidden'))
    };
    if (Number.isFinite(e.hp)) token.hp = e.hp;
    if (Number.isFinite(e.hpMax)) token.hpMax = e.hpMax;
    const facing = facingFor(opts?.facings, e);
    if (facing) token.facing = facing;
    const image = resolveTokenImage(e, tokenImages);
    if (image) {
      token.imageUrl = image.url;
      if (image.imageId) token.imageId = image.imageId;
    }
    tokens.push(token);
  }
  tokens.sort(compareTokens);
  const terrain = grid.terrain && typeof grid.terrain.flags === 'string'
    ? { v: grid.terrain.v, cols: grid.terrain.cols, rows: grid.terrain.rows, flags: grid.terrain.flags }
    : null;
  return {
    v: RENDER_VIEW_VERSION,
    encounterId: state?.encounterId ?? null,
    round: Number.isFinite(state?.round) ? state.round : 0,
    activeId: running ? (state.initiative?.[state.turnIndex]?.entityId ?? null) : null,
    grid: { cols: grid.cols || 1, rows: grid.rows || 1, cellFt: grid.cellFt || 5 },
    map: viewMapOf(state?.map),
    terrain,
    fog: state?.fog && typeof state.fog.revealed === 'string' ? { revealed: state.fog.revealed } : null,
    tokens
  };
}

/**
 * Status fields of a legacy character record (hp object, deathSaves …).
 * @param {object} ch
 * @returns {{hpState: string, tempHp: boolean, conditions: string[], worstCondition: string|null, concentration: string|null}}
 */
function legacyStatus(ch) {
  const hp = ch.hp || {};
  const cur = typeof hp.current === 'number' ? hp.current
    : (typeof hp.max === 'number' && typeof hp.removed === 'number' ? Math.max(0, hp.max - hp.removed) : null);
  const conditions = conditionIdsOf(ch.conditions);
  return {
    hpState: hpStateOf(cur, typeof hp.max === 'number' ? hp.max : null, ch.deathSaves?.failures || 0),
    tempHp: (hp.temp || 0) > 0,
    conditions,
    worstCondition: worstConditionOf(conditions),
    concentration: ch.concentration ? String(ch.concentration) : null
  };
}

/**
 * Adapter for the pre-M64 call `renderBattleScene(canvas, characters,
 * scene, opts)`: builds the RenderView, the per-viewer `local`, and the
 * appearance map (key → record) the renderer resolves looks from.
 * Tokens keep the legacy draw order (PCs, then monsters).
 * @param {object[]} characters — party records
 * @param {object} scene — scene-state scene
 * @param {object} [opts] — the legacy opts (positionOf, monsterCharacters, overlays,
 *   aoeTemplate, pathPreview {cells, legal, costFt}, camera …)
 * @returns {{view: object, local: object, appearances: Map<string, object>}}
 */
export function legacySceneToView(characters, scene, opts = {}) {
  const appearances = new Map();
  const tokens = [];
  const list = (characters || []).filter(Boolean);
  const add = (ch, pos, kind) => {
    if (!pos) return;
    const key = appearanceKeyOf(ch);
    if (!appearances.has(key)) appearances.set(key, ch);
    tokens.push({
      id: String(ch.id), kind, side: kind === 'monster' ? 'hostile' : 'party', name: String(ch.name ?? ''),
      col: pos.col, row: pos.row, appearanceKey: key, hidden: false, ...legacyStatus(ch)
    });
  };
  list.forEach((ch, i) => add(ch, opts.positionOf ? opts.positionOf(scene, ch.id, i) : { col: i, row: 0 }, 'pc'));
  for (const mc of (opts.monsterCharacters || [])) add(mc, mc?._position, 'monster');
  const view = {
    v: RENDER_VIEW_VERSION,
    encounterId: null,
    round: 0,
    activeId: opts.activeTurnId ?? null,
    grid: { cols: scene.cols, rows: scene.rows, cellFt: 5 },
    map: viewMapOf(scene.map),
    terrain: scene.terrain && typeof scene.terrain.flags === 'string' ? scene.terrain : null,
    fog: null,
    tokens
  };
  const local = {
    camera: opts.camera || null,
    legacyZoom: (scene.cellSize * scene.scale) / 64,
    grid: { visible: !!scene.grid?.visible, color: scene.grid?.color },
    selectionId: opts.selectedAttackerId ?? null,
    animations: opts.animations || null,
    popups: opts.popups || null,
    effects: opts.effects || null,
    aoePreview: opts.aoeTemplate || null,
    pathPreview: opts.pathPreview || null,
    direction: opts.direction || 'south',
    frameIdx: opts.frameIdx || 0,
    appearances
  };
  return { view, local, appearances };
}

/**
 * The status half of a token's bake key: everything besides the look,
 * direction and frame that changes its pixels.
 * @param {object} token
 * @returns {string}
 */
export function tokenStatusKey(token) {
  const conds = [...(token.conditions || [])].sort().join('+');
  return `${token.hpState || 'healthy'}|${token.worstCondition || '-'}|${conds}|${token.tempHp ? 't' : '-'}|${token.concentration || '-'}`;
}

/**
 * A render-ready copy of a base character record carrying the token's
 * status (HP bucket, conditions, temp HP, concentration), so the sprite
 * pipeline tints and decorates it exactly as the bake key promises.
 * @param {object} base
 * @param {object} token
 * @returns {object}
 */
export function characterForToken(base, token) {
  const max = 100;
  const current = token.hpState === 'down' ? 0 : token.hpState === 'wounded' ? 10 : max;
  return {
    ...base,
    hp: { ...(base?.hp || {}), base: max, bonus: 0, override: null, max, current, removed: max - current, temp: token.tempHp ? 1 : 0 },
    deathSaves: { successes: 0, failures: 0 },
    conditions: [...(token.conditions || [])],
    concentration: token.concentration || null
  };
}

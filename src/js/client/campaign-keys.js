/**
 * M65 C21 — campaign keys kept in this browser (localStorage), one per
 * campaign id. A campaign key is the campaign's only credential until
 * accounts land (M65 decision 5: a 256-bit bearer, shown once), so the
 * DM's browser keeps it and "Forget" drops it from this device only (the
 * campaign itself is untouched on the server).
 *
 * Stored under `cf-campaign-keys` as `{[campaignId]: {key, name, savedAt}}`.
 * Every storage call is guarded: private mode or a full quota leaves the
 * store working in memory for the session.
 */

/** localStorage key. */
export const CAMPAIGN_KEYS_STORAGE = 'cf-campaign-keys';

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const ID_RE = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * @param {Storage|null} storage — window.localStorage (null: memory only)
 * @param {{now?: () => number}} [opts]
 * @returns {{list: () => {campaignId: string, name: string, savedAt: number}[],
 *            get: (campaignId: string) => string|null,
 *            put: (campaignId: string, key: string, name?: string) => boolean,
 *            rename: (campaignId: string, name: string) => void,
 *            forget: (campaignId: string) => void}}
 */
export function createCampaignKeys(storage, { now = () => Date.now() } = {}) {
  let memory = null;

  function read() {
    if (memory) return memory;
    let data = {};
    try {
      const raw = storage?.getItem?.(CAMPAIGN_KEYS_STORAGE);
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch { data = {}; }
    const clean = {};
    for (const [id, v] of Object.entries(data)) {
      if (ID_RE.test(id) && v && typeof v.key === 'string' && KEY_RE.test(v.key)) {
        clean[id] = { key: v.key, name: typeof v.name === 'string' ? v.name : id, savedAt: Number(v.savedAt) || 0 };
      }
    }
    memory = clean;
    return memory;
  }

  function write(next) {
    memory = next;
    try { storage?.setItem?.(CAMPAIGN_KEYS_STORAGE, JSON.stringify(next)); } catch { /* memory only */ }
  }

  return {
    list() {
      return Object.entries(read())
        .map(([campaignId, v]) => ({ campaignId, name: v.name, savedAt: v.savedAt }))
        .sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name));
    },
    get(campaignId) { return read()[campaignId]?.key ?? null; },
    put(campaignId, key, name = '') {
      if (!ID_RE.test(String(campaignId)) || !KEY_RE.test(String(key))) return false;
      write({ ...read(), [campaignId]: { key: String(key), name: String(name || campaignId).slice(0, 80), savedAt: now() } });
      return true;
    },
    rename(campaignId, name) {
      const cur = read()[campaignId];
      if (cur) write({ ...read(), [campaignId]: { ...cur, name: String(name).slice(0, 80) } });
    },
    forget(campaignId) {
      const next = { ...read() };
      delete next[campaignId];
      write(next);
    }
  };
}

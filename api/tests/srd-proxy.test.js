// M65 B23 — /api/srd/{items,spells}: the Open5e proxy filtered to the SRD
// 5.1 document (`document__key__in=srd-2014`), cached in items_cache; a
// record from any other document is never returned or cached.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../app.js';
import { startServer } from '../start.js';
import { CACHE_HIT_MIN } from '../srd/http.js';
import { tempRoot, tempDb, quiet, api } from './helpers/server.js';

const { root, cleanup } = tempRoot('cf-srd-');
after(cleanup);

const doc = (key) => ({ name: key, key });
const rec = (key, name, document = 'srd-2014', extra = {}) => ({ key, name, document: doc(document), desc: `${name} text`, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Open5e: routes by path, records every call (url + whether a signal rode along). */
function fakeOpen5e(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), signal: opts.signal });
    const u = new URL(url);
    for (const [pattern, handler] of routes) {
      if (pattern.test(u.pathname)) return handler(u, opts);
    }
    return json({ detail: 'Not found.' }, 404);
  };
  return { fetchImpl, calls };
}

async function boot(fetchImpl, { upstreamTimeoutMs = 2000 } = {}) {
  const { db } = await tempDb(root);
  const app = createApp({ db, env: { NODE_ENV: 'test' }, log: quiet, fetchImpl, upstreamTimeoutMs, limits: { srd: { windowMs: 60_000, max: 1000 } } });
  const srv = await startServer({ db, port: 0, host: '127.0.0.1', app, log: quiet });
  return { db, ...srv };
}
const cachedKeys = (s) => s.db.db.prepare('SELECT key, document_key, kind FROM items_cache ORDER BY key').all();

test('item search filters every upstream call to srd-2014 and never caches another document', async () => {
  const { fetchImpl, calls } = fakeOpen5e([
    [/^\/v2\/items\/$/, () => json({ results: [
      rec('srd_longsword', 'Longsword', 'srd-2014', { cost: '15.00', category: { name: 'Weapon' }, weapon: {} }),
      rec('srd-2024_longsword', 'Longsword', 'srd-2024'),               // the filter should have dropped it; we drop it too
      rec('tob_sword-of-x', 'Sword of X', 'tob')
    ] })],
    [/^\/v2\/magicitems\/$/, () => json({ results: [rec('srd_flame-tongue', 'Flame Tongue', 'srd-2014', { rarity: { name: 'Rare' }, requires_attunement: true })] })]
  ]);
  const s = await boot(fetchImpl);
  try {
    const r = await api(s.url, '/api/srd/items?q=sword');
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'open5e');
    assert.deepEqual(r.body.results.map(x => [x.key, x.kind]), [['srd_flame-tongue', 'magicitem'], ['srd_longsword', 'item']]);
    assert.deepEqual(r.body.results[1], { key: 'srd_longsword', name: 'Longsword', kind: 'item', cost: '15.00', category: 'Weapon', rarity: null, weight: null, requiresAttunement: false, weapon: true, armor: false });
    assert.equal(r.body.results[0].requiresAttunement, true);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      const u = new URL(c.url);
      assert.equal(u.searchParams.get('document__key__in'), 'srd-2014', `${u.pathname} filters with document__key__in`);
      assert.equal(u.searchParams.has('document__key'), false, 'document__key alone is ignored on items; never rely on it');
      assert.equal(u.searchParams.get('name__icontains'), 'sword');
      assert.ok(c.signal instanceof globalThis.AbortSignal, 'every fetch carries a timeout signal');
    }
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/v2/items/', '/v2/magicitems/']);
    assert.deepEqual(cachedKeys(s), [
      { key: 'srd_flame-tongue', document_key: 'srd-2014', kind: 'magicitem' },
      { key: 'srd_longsword', document_key: 'srd-2014', kind: 'item' }
    ], 'non-SRD keys are never cached');

    // ?kind narrows to one endpoint; a bad kind is 400.
    calls.length = 0;
    await api(s.url, '/api/srd/items?q=sword&kind=magicitem');
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/v2/magicitems/']);
    assert.equal((await api(s.url, '/api/srd/items?q=sword&kind=monster')).status, 400);
    assert.deepEqual((await api(s.url, '/api/srd/items?q=')).body, { results: [] });
  } finally { await s.close(); }
});

test('item get: cache-first, SRD only, falls through items → magicitems', async () => {
  const { fetchImpl, calls } = fakeOpen5e([
    [/^\/v2\/items\/srd_breastplate\/$/, () => json(rec('srd_breastplate', 'Breastplate', 'srd-2014', { armor: { ac_base: 14, ac_cap_dexmod: 2 } }))],
    [/^\/v2\/magicitems\/srd_potion-of-healing\/$/, () => json(rec('srd_potion-of-healing', 'Potion of Healing', 'srd-2014', { cost: '50.00' }))],
    [/^\/v2\/items\/a5e_thing\/$/, () => json(rec('a5e_thing', 'Thing', 'a5e-ag'))]
  ]);
  const s = await boot(fetchImpl);
  try {
    let r = await api(s.url, '/api/srd/items/srd_breastplate');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.source, r.body.kind, r.body.item.armor.ac_base], ['open5e', 'item', 14]);
    r = await api(s.url, '/api/srd/items/srd_breastplate');
    assert.equal(r.body.source, 'cache');
    assert.equal(calls.length, 1, 'the second read never reaches Open5e');

    r = await api(s.url, '/api/srd/items/srd_potion-of-healing');
    assert.deepEqual([r.status, r.body.kind], [200, 'magicitem']);
    assert.deepEqual(calls.slice(1).map(c => new URL(c.url).pathname), ['/v2/items/srd_potion-of-healing/', '/v2/magicitems/srd_potion-of-healing/']);
    assert.ok(calls.every(c => c.signal instanceof globalThis.AbortSignal));

    r = await api(s.url, '/api/srd/items/a5e_thing');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'NOT_SRD');
    assert.equal((await api(s.url, '/api/srd/items/nothing_here')).status, 404);
    assert.equal((await api(s.url, '/api/srd/items/bad%20key')).status, 400);
    assert.deepEqual(cachedKeys(s).map(x => x.key), ['srd_breastplate', 'srd_potion-of-healing'], 'a non-SRD key is never cached');
  } finally { await s.close(); }
});

test('spells: search and get through /v2/spells/ with the SRD filter', async () => {
  const { fetchImpl, calls } = fakeOpen5e([
    [/^\/v2\/spells\/$/, () => json({ results: [
      rec('srd_cure-wounds', 'Cure Wounds', 'srd-2014', { level: 1, school: { name: 'Evocation' }, casting_time: 'action' }),
      rec('a5e-ag_cure-wounds', 'Cure Wounds', 'a5e-ag', { level: 1 })
    ] })],
    [/^\/v2\/spells\/srd_revivify\/$/, () => json(rec('srd_revivify', 'Revivify', 'srd-2014', { level: 3 }))]
  ]);
  const s = await boot(fetchImpl);
  try {
    const r = await api(s.url, '/api/srd/spells?q=cure');
    assert.deepEqual(r.body.results, [{ key: 'srd_cure-wounds', name: 'Cure Wounds', kind: 'spell', level: 1, school: 'Evocation', ritual: false, concentration: false, castingTime: 'action' }]);
    assert.equal(new URL(calls[0].url).searchParams.get('document__key__in'), 'srd-2014');
    const g = await api(s.url, '/api/srd/spells/srd_revivify');
    assert.deepEqual([g.status, g.body.spell.level, g.body.kind], [200, 3, 'spell']);
    assert.equal((await api(s.url, '/api/srd/items/srd_revivify')).status, 404, 'a cached spell is not served as an item');
    assert.deepEqual(cachedKeys(s).map(x => [x.key, x.kind]), [['srd_cure-wounds', 'spell'], ['srd_revivify', 'spell']]);
  } finally { await s.close(); }
});

test('a search with enough cached name matches is served from the cache', async () => {
  const { fetchImpl, calls } = fakeOpen5e([]);
  const s = await boot(fetchImpl);
  try {
    const ins = s.db.db.prepare("INSERT INTO items_cache (key, document_key, kind, name, payload_json, fetched_at) VALUES (?, 'srd-2014', 'item', ?, ?, 1)");
    for (let i = 0; i < CACHE_HIT_MIN; i++) ins.run(`srd_arrow-${i}`, `Arrow ${i}`, JSON.stringify(rec(`srd_arrow-${i}`, `Arrow ${i}`)));
    const r = await api(s.url, '/api/srd/items?q=arrow');
    assert.equal(r.body.source, 'cache');
    assert.equal(r.body.results.length, CACHE_HIT_MIN);
    assert.equal(calls.length, 0);
  } finally { await s.close(); }
});

test('upstream failures: a 5xx is 502, a hung Open5e times out as 504', async () => {
  const { fetchImpl } = fakeOpen5e([
    [/^\/v2\/items\/$/, () => json({}, 500)],
    [/^\/v2\/spells\/$/, (_u, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    })]
  ]);
  const s = await boot(fetchImpl, { upstreamTimeoutMs: 50 });
  try {
    const bad = await api(s.url, '/api/srd/items?q=x&kind=item');
    assert.deepEqual([bad.status, bad.body.code], [502, 'OPEN5E_HTTP']);
    const slow = await api(s.url, '/api/srd/spells?q=x');
    assert.deepEqual([slow.status, slow.body.code], [504, 'UPSTREAM_TIMEOUT']);
    assert.deepEqual(cachedKeys(s), []);
  } finally { await s.close(); }
});

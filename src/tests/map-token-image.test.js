// M64 E5 / phase 1.5 — DM token images: URL policy, projection, the bake
// slot (and LPC fallback on a broken image), the image baker, and the
// mountTokenPicker DOM contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTokenImageUrl } from '../js/map/token-fx.js';
import { projectBattleView } from '../js/map/view.js';
import { createTokenCache, imageKeyFor } from '../js/map/token-cache.js';
import { renderBattleScene, prepareBattleView, bakeImageToken } from '../js/sprite/compositor.js';
import { validateEncounterState } from '../js/shared/encounter-state.js';
import {
  TOKEN_IMAGE_TYPES, TOKEN_IMAGE_MAX_BYTES, tokenImageUploadPath, checkTokenImageFile, mountTokenPicker
} from '../js/map/token-picker.js';
import { recordingCanvas, deepFreeze } from './helpers/mock-canvas.js';
import { createFakeDom } from './helpers/fake-dom.js';

const FIXTURE = () => JSON.parse(readFileSync(new URL('./fixtures/contracts/encounter-state.valid.json', import.meta.url), 'utf8'));
const URL_OK = '/api/maps/room1/abc123.webp';

test('isTokenImageUrl: same-origin paths only', () => {
  assert.equal(isTokenImageUrl(URL_OK), true);
  for (const bad of ['https://evil.example/x.png', '//evil.example/x.png', '/\\evil', 'data:image/png;base64,AA', 'blob:x', 'x.png', '/a b', '', null, 7]) {
    assert.equal(isTokenImageUrl(bad), false, String(bad));
  }
});

test('EncounterState accepts entity.imageUrl (path) and rejects other hosts; the view copies it', () => {
  const s = FIXTURE();
  s.entities['m-fanatic'].imageUrl = URL_OK;
  assert.equal(validateEncounterState(s).ok, true);
  const bad = FIXTURE();
  bad.entities['m-fanatic'].imageUrl = 'https://evil.example/x.png';
  assert.equal(validateEncounterState(bad).ok, false);
  const by = Object.fromEntries(projectBattleView(s).tokens.map(t => [t.id, t]));
  assert.equal(by['m-fanatic'].imageUrl, URL_OK);
  assert.equal('imageUrl' in by['m-goblin'], false);
  const sneaky = FIXTURE();
  sneaky.entities['m-fanatic'].imageUrl = '//evil.example/x.png';   // unvalidated input still never reaches the view
  assert.equal('imageUrl' in projectBattleView(sneaky).tokens.find(t => t.id === 'm-fanatic'), false);
});

const imgToken = (over = {}) => ({
  id: 'drake', kind: 'monster', side: 'hostile', name: 'Drake', col: 1, row: 1, appearanceKey: 'monster:goblin',
  hpState: 'healthy', status: 'active', tempHp: false, conditions: [], worstCondition: null, concentration: null, hidden: false,
  imageUrl: URL_OK, facing: 'east', ...over
});
const viewOf = (tokens) => deepFreeze({
  v: 1, encounterId: 'e', round: 1, activeId: null, grid: { cols: 4, rows: 4, cellFt: 5 },
  map: { kind: 'color', color: '#222' }, terrain: null, fog: null, tokens
});

test('token cache: image tokens use one img: key per HP bucket, ignoring facing/frame/conditions', () => {
  const cache = createTokenCache({ bake: async () => ({ canvas: {} }) });
  const t = imgToken();
  const k = cache.keyFor(t, { frameIdx: 3 });
  assert.equal(k, imageKeyFor(t));
  assert.match(k, /^img:\/api\/maps\/room1\/abc123\.webp\|/);
  assert.equal(cache.keyFor({ ...t, facing: 'north', conditions: ['prone'] }, { frameIdx: 9 }), k);
  assert.notEqual(cache.keyFor({ ...t, hpState: 'down' }), k);
});

test('renderer: one drawImage of the baked image disc; a failed image falls back to the LPC look', async () => {
  const bakes = [];
  const tokenCache = createTokenCache({
    bake: async (input) => {
      bakes.push(input);
      if (input.kind === 'token-image' && input.url.includes('broken')) throw new Error('404');
      return { canvas: { what: input.kind || 'lpc' }, frameCycle: 1 };
    }
  });
  const local = { tokenCache, resolveAppearance: () => ({ look: 'goblin' }), now: 0 };
  const good = viewOf([imgToken({ hpState: 'down', status: 'dead' })]);
  await prepareBattleView(good, local);
  assert.equal(bakes[0].kind, 'token-image');
  assert.deepEqual({ url: bakes[0].url, side: bakes[0].side, hpState: bakes[0].hpState }, { url: URL_OK, side: 'hostile', hpState: 'down' });
  const r = recordingCanvas();
  renderBattleScene(r.canvas, good, local);
  const draws = r.calls.filter(c => c[0] === 'drawImage');
  assert.equal(draws.length, 1);
  assert.equal(draws[0][1].what, 'token-image');
  assert.equal(r.count('rotate'), 0, 'image discs are not laid prone');

  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    const broken = viewOf([imgToken({ id: 'd2', imageUrl: '/api/maps/r/broken.png' })]);
    await prepareBattleView(broken, local);
    const r2 = recordingCanvas();
    renderBattleScene(r2.canvas, broken, local);
    assert.equal(r2.calls.filter(c => c[0] === 'drawImage')[0][1].what, 'lpc', 'LPC fallback');
  } finally { console.error = orig; }
  assert.match(errors[0], /bake_failed/);
});

test('bakeImageToken: centre-crops to a clipped disc, tints when down, rings in the side colour', async () => {
  const rc = recordingCanvas();
  const prevOff = globalThis.OffscreenCanvas;
  const prevImg = globalThis.Image;
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return rc.ctx; } };
  globalThis.Image = class { set src(v) { this._src = v; this.width = 300; this.height = 200; Promise.resolve().then(() => this.onload()); } get src() { return this._src; } };
  try {
    const res = await bakeImageToken({ url: '/api/maps/r/bake-test.png', side: 'party', hpState: 'down' });
    assert.ok(res.canvas);
    assert.equal(res.frameCycle, 1);
    assert.equal(rc.count('clip'), 1);
    const draw = rc.calls.find(c => c[0] === 'drawImage');
    assert.deepEqual(draw.slice(2), [50, 0, 200, 200, 0, 0, 128, 128], 'square centre crop into 128²');
    assert.equal(rc.count('getImageData'), 1, 'down tint via the filter matrix');
    assert.equal(rc.count('putImageData'), 1);
    assert.ok(rc.calls.some(c => c[0] === 'set:strokeStyle' && c[1] === '#2563eb'));
    rc.reset();
    await bakeImageToken({ url: '/api/maps/r/bake-test.png', side: 'hostile', hpState: 'healthy' });
    assert.equal(rc.count('getImageData'), 0, 'healthy: no pixel pass');
    assert.ok(rc.calls.some(c => c[0] === 'set:strokeStyle' && c[1] === '#b91c1c'));
  } finally {
    globalThis.OffscreenCanvas = prevOff;
    globalThis.Image = prevImg;
  }
});

test('tokenImageUploadPath / checkTokenImageFile', () => {
  assert.equal(tokenImageUploadPath('r 1'), '/api/rooms/r%201/maps');
  assert.equal(tokenImageUploadPath('r1', { kindSupported: true, filename: 'red dragon.png' }), '/api/rooms/r1/maps?kind=token&filename=red%20dragon.png');
  assert.deepEqual([...TOKEN_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(checkTokenImageFile({ type: 'image/png', size: 10 }), null);
  assert.match(checkTokenImageFile(null), /Choose/);
  assert.match(checkTokenImageFile({ type: 'image/gif', size: 10 }), /PNG, JPEG or WebP/);
  assert.match(checkTokenImageFile({ type: 'image/png', size: 0 }), /empty/);
  assert.match(checkTokenImageFile({ type: 'image/png', size: TOKEN_IMAGE_MAX_BYTES + 1 }), /10 MB/);
});

test('mountTokenPicker: upload previews the URL, errors are shown, Remove clears, unmount removes everything', async () => {
  const dom = createFakeDom();
  const root = dom.root();
  const uploads = [];
  let cleared = 0;
  let next = { url: URL_OK };
  const unmount = mountTokenPicker(root, {
    onUpload: async (f) => { uploads.push(f); if (next instanceof Error) throw next; return next; },
    onClear: () => { cleared++; }
  });
  const input = root.querySelector('[data-action="token-image-file"]');
  const img = root.querySelector('[data-role="image"]');
  const status = root.querySelector('[data-role="status"]');
  const clear = root.querySelector('[data-action="token-image-clear"]');
  assert.equal(img.hidden, true);
  assert.equal(clear.disabled, true);
  assert.equal(input.getAttribute('accept'), 'image/png,image/jpeg,image/webp');

  input.files = [{ type: 'image/gif', size: 5, name: 'x.gif' }];
  await dom.fire(input, 'change');
  assert.equal(uploads.length, 0, 'bad type never uploads');
  assert.equal(status.getAttribute('data-kind'), 'error');

  input.files = [{ type: 'image/png', size: 5, name: 'drake.png' }];
  dom.fire(input, 'change');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(uploads.length, 1);
  assert.equal(img.getAttribute('src'), URL_OK);
  assert.equal(img.hidden, false);
  assert.equal(status.getAttribute('data-kind'), 'ok');

  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(m);
  try {
    next = new Error('quota');
    dom.fire(input, 'change');
    await new Promise(r => setTimeout(r, 0));
  } finally { console.error = orig; }
  assert.match(status.textContent, /Upload failed: quota/);
  assert.match(errors[0], /map\.token_picker\.upload_failed/);
  assert.equal(img.getAttribute('src'), URL_OK, 'a failed upload keeps the previous image');

  dom.fire(clear, 'click');
  assert.equal(cleared, 1);
  assert.equal(img.hidden, true);

  assert.ok(dom.activeListeners() > 0);
  unmount();
  assert.equal(dom.activeListeners(), 0, 'every listener removed');
  assert.equal(root.children.length, 0);
  assert.throws(() => mountTokenPicker(root, {}), /onUpload is required/);
});

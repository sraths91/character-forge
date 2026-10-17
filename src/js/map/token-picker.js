/**
 * M64 E5 / phase 1.5 — DM token-image picker (R2 R7).
 *
 * Non-humanoid monsters (dragons, beasts, oozes) have no LPC look; the DM
 * can upload an image that the grid draws instead (`entity.imageUrl` →
 * `view.tokens[].imageUrl`, one drawImage in the token's bake slot).
 *
 * `mountTokenPicker(root, {onUpload, initialUrl, onClear, label})` builds a
 * small per-monster control in `root` — preview disc, file input, Remove
 * button, status line — and returns `unmount()`. E2 mounts one per
 * monster row in encounter setup. The picker does no network I/O itself:
 * `onUpload(file)` (E2, through client/api.js) PUTs the bytes and
 * resolves to the server's `{url}` (or the url string), which the picker
 * previews and E2 writes onto the entity as `imageUrl`.
 *
 * Upload endpoint: the map image endpoint with a kind flag,
 *   PUT /api/rooms/:id/maps?kind=token[&filename=…]   raw image bytes
 *     → 201 {mapId, url, mime, width, height, …}
 * `kind=token` is E3's (phase 1.5). Until the server advertises it,
 * `tokenImageUploadPath(roomId, {kindSupported: false})` omits the flag —
 * the bytes are stored as an ordinary map image (same validation, same
 * served URL; it counts against the room's map quota).
 */

import { isTokenImageUrl } from './token-fx.js';

/** Accepted token image types (the map endpoint's set: PNG, JPEG, WebP). */
export const TOKEN_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
/** Upload size cap; mirrors api/rooms/maps.js MAP_QUOTA.maxBytes. */
export const TOKEN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Upload path for a token image.
 * @param {string} roomId
 * @param {{filename?: string, kindSupported?: boolean}} [opts] — kindSupported:
 *   the server accepts `kind=token` (E3); false ⇒ plain map upload
 * @returns {string}
 */
export function tokenImageUploadPath(roomId, { filename = '', kindSupported = false } = {}) {
  const q = [];
  if (kindSupported) q.push('kind=token');
  if (filename) q.push(`filename=${encodeURIComponent(filename)}`);
  return `/api/rooms/${encodeURIComponent(roomId)}/maps${q.length ? `?${q.join('&')}` : ''}`;
}

/**
 * Client-side check before uploading (the server re-checks the bytes).
 * @param {{type?: string, size?: number}|null|undefined} file
 * @returns {string|null} a message, or null when the file may be sent
 */
export function checkTokenImageFile(file) {
  if (!file) return 'Choose an image file.';
  if (!TOKEN_IMAGE_TYPES.includes(file.type)) return 'Token images must be PNG, JPEG or WebP.';
  if (!(file.size > 0)) return 'That file is empty.';
  if (file.size > TOKEN_IMAGE_MAX_BYTES) return 'Token images must be 10 MB or smaller.';
  return null;
}

/**
 * @param {HTMLElement} root
 * @param {{onUpload: (file: File) => Promise<{url: string}|string>,
 *          initialUrl?: string|null,
 *          onClear?: () => void,
 *          label?: string}} opts
 * @returns {() => void} unmount
 */
export function mountTokenPicker(root, { onUpload, initialUrl = null, onClear = null, label = 'Token image' } = {}) {
  if (typeof onUpload !== 'function') throw new TypeError('mountTokenPicker: onUpload is required');
  const doc = root.ownerDocument || globalThis.document;
  let alive = true;
  let busy = false;

  const wrap = doc.createElement('div');
  wrap.className = 'token-picker';
  wrap.setAttribute('data-token-picker', '');

  const preview = doc.createElement('span');
  preview.className = 'token-picker-preview';
  preview.setAttribute('data-role', 'preview');
  const img = doc.createElement('img');
  img.setAttribute('alt', '');
  img.setAttribute('data-role', 'image');
  preview.appendChild(img);

  const field = doc.createElement('label');
  field.className = 'token-picker-field';
  field.appendChild(doc.createTextNode(label + ' '));
  const input = doc.createElement('input');
  input.setAttribute('type', 'file');
  input.setAttribute('accept', TOKEN_IMAGE_TYPES.join(','));
  input.setAttribute('data-action', 'token-image-file');
  field.appendChild(input);

  const clear = doc.createElement('button');
  clear.setAttribute('type', 'button');
  clear.setAttribute('data-action', 'token-image-clear');
  clear.textContent = 'Remove';

  const status = doc.createElement('span');
  status.className = 'token-picker-status';
  status.setAttribute('role', 'status');
  status.setAttribute('data-role', 'status');

  wrap.appendChild(preview);
  wrap.appendChild(field);
  wrap.appendChild(clear);
  wrap.appendChild(status);
  root.appendChild(wrap);

  const say = (text, kind = 'info') => { status.textContent = text; status.setAttribute('data-kind', kind); };
  const show = (url) => {
    if (url) { img.setAttribute('src', url); img.hidden = false; } else { img.removeAttribute?.('src'); img.hidden = true; }
    clear.disabled = !url;
  };
  show(isTokenImageUrl(initialUrl) ? initialUrl : null);

  const onChange = async () => {
    if (busy) return;
    const file = input.files?.[0] || null;
    const problem = checkTokenImageFile(file);
    if (problem) { say(problem, 'error'); return; }
    busy = true;
    input.disabled = true;
    say('Uploading…');
    try {
      const res = await onUpload(file);
      if (!alive) return;
      const url = typeof res === 'string' ? res : res?.url;
      if (!isTokenImageUrl(url)) throw new Error('the server returned no image URL');
      show(url);
      say('Token image set.', 'ok');
    } catch (err) {
      if (!alive) return;
      console.error(JSON.stringify({ event: 'map.token_picker.upload_failed', error: String(err?.message || err) }));
      say(`Upload failed: ${err?.message || err}`, 'error');
    } finally {
      busy = false;
      if (alive) { input.disabled = false; input.value = ''; }
    }
  };
  const onClearClick = () => {
    if (busy) return;
    show(null);
    say('Token image removed; the default sprite is used.');
    onClear?.();
  };
  input.addEventListener('change', onChange);
  clear.addEventListener('click', onClearClick);

  return function unmount() {
    if (!alive) return;
    alive = false;
    input.removeEventListener('change', onChange);
    clear.removeEventListener('click', onClearClick);
    wrap.remove();
  };
}

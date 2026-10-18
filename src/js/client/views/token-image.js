/**
 * M64 phase 1.5 wave 6 (E2) — the DM's token image picker, wired.
 *
 * E5's `mountTokenPicker` (map/token-picker.js) does no network I/O; this
 * module gives it one: the file is uploaded with
 * `PUT /api/rooms/:id/maps?kind=token` (`api.uploadTokenImage`, path from
 * E5's `tokenImageUploadPath(roomId, {filename, kindSupported: true})`)
 * and the returned same-origin URL is written onto the creature with
 * `dm.entity.patch {entityId, imageUrl}` (protocol v1.5); Remove sends
 * `imageUrl: null`.
 *
 * Only non-humanoid monsters get a picker (E3's server refuses a
 * humanoid stat block and PCs: they draw their LPC look).
 *
 * `createTokenPickers(ctx)` keeps one picker per entity id across
 * re-renders (a list re-render must not drop an upload in flight):
 * `hostFor(entity)` → the picker's host element (or null),
 * `prune(ids)` unmounts pickers for creatures no longer listed,
 * `dispose()` unmounts every one.
 */

import { mountTokenPicker } from '../../map/token-picker.js';
import { tokenImageAllowed } from '../selectors.js';

/**
 * @param {object} ctx — view ctx: {send, api: {uploadTokenImage}, room: {roomId}, deps?: {readFile?, mountTokenPicker?}}
 * @param {{onError?: (err: Error) => void}} [opts]
 * @returns {{hostFor: (entity: object) => HTMLElement|null, prune: (ids: Iterable<string>) => void, dispose: () => void, size: () => number}}
 */
export function createTokenPickers(ctx, { onError = () => {} } = {}) {
  const mount = ctx.deps?.mountTokenPicker || mountTokenPicker;
  const live = new Map();   // entityId → {host, unmount}

  async function upload(entityId, file) {
    const roomId = ctx.room?.roomId;
    if (!roomId || typeof ctx.api?.uploadTokenImage !== 'function') throw new Error('token uploads are unavailable here');
    const bytes = ctx.deps?.readFile ? await ctx.deps.readFile(file) : file;
    const rec = await ctx.api.uploadTokenImage(roomId, bytes, { filename: file?.name || '', mime: file?.type || 'application/octet-stream' });
    const url = typeof rec === 'string' ? rec : rec?.url;
    if (typeof url !== 'string' || !url) throw new Error('the server returned no image URL');
    await ctx.send({ t: 'dm.entity.patch', p: { entityId: String(entityId), imageUrl: url } });
    return url;
  }

  function clearImage(entityId) {
    Promise.resolve()
      .then(() => ctx.send({ t: 'dm.entity.patch', p: { entityId: String(entityId), imageUrl: null } }))
      .catch((err) => {
        globalThis.console?.warn?.(JSON.stringify({ event: 'client.token_image.clear_failed', entityId, error: String(err?.message || err) }));
        onError(err);
      });
  }

  return {
    hostFor(entity) {
      if (!tokenImageAllowed(entity)) return null;
      const have = live.get(entity.id);
      if (have) return have.host;
      const doc = ctx.doc || globalThis.document;
      const host = doc.createElement('div');
      host.className = 'play-token-image';
      const unmount = mount(host, {
        label: `Token image for ${entity.name}`,
        initialUrl: entity.imageUrl || null,
        onUpload: (file) => upload(entity.id, file),
        onClear: () => clearImage(entity.id)
      });
      live.set(entity.id, { host, unmount });
      return host;
    },
    prune(ids) {
      const keep = new Set(ids);
      for (const [id, p] of live) {
        if (keep.has(id)) continue;
        p.unmount();
        live.delete(id);
      }
    },
    dispose() {
      for (const p of live.values()) p.unmount();
      live.clear();
    },
    size: () => live.size
  };
}

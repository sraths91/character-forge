import {
  ASSET_MAP, BACK_DERIVED_POSES, WAIST_DERIVED_POSES, FRAME, getFrame
} from './sprite/lpc-config.js';
import { loadImage } from './sprite/image-cache.js';
import { drawDerivedItem } from './sprite/compositor.js';

const SCALE = 6;
let currentDirection = 'south';

async function renderCell(grid, weaponKey, pose, src) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = FRAME * SCALE;
  canvas.height = FRAME * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const img = await loadImage(src).catch(() => null);
  if (!img) {
    cell.innerHTML = `<div class="label">${weaponKey} — load failed</div>`;
    grid.appendChild(cell);
    return;
  }

  // Stage canvas: extract the per-asset frame at native 64×64
  const stage = document.createElement('canvas');
  stage.width = FRAME;
  stage.height = FRAME;
  const sctx = stage.getContext('2d', { colorSpace: 'srgb' });
  sctx.imageSmoothingEnabled = false;
  const f = getFrame(src, currentDirection);
  sctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, 0, 0, FRAME, FRAME);

  drawDerivedItem(ctx, stage, pose, SCALE);

  cell.appendChild(canvas);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${weaponKey} (rot:${pose.rotate}° scale:${pose.scale} @${pose.anchor.x},${pose.anchor.y})`;
  cell.appendChild(label);
  grid.appendChild(cell);
}

async function renderMainhand(grid, key, src) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  const canvas = document.createElement('canvas');
  canvas.width = FRAME * SCALE;
  canvas.height = FRAME * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = await loadImage(src).catch(() => null);
  if (!img) {
    cell.innerHTML = `<div class="label">${key} — load failed</div>`;
    grid.appendChild(cell);
    return;
  }
  const f = getFrame(src, currentDirection);
  ctx.drawImage(img, f.sx, f.sy, f.sw, f.sh, 0, 0, FRAME * SCALE, FRAME * SCALE);
  cell.appendChild(canvas);
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${key} (${f.sw}×${f.sh} @ ${f.sx},${f.sy})`;
  cell.appendChild(label);
  grid.appendChild(cell);
}

async function init() {
  const mainGrid = document.getElementById('main-grid');
  const backGrid = document.getElementById('back-grid');
  const waistGrid = document.getElementById('waist-grid');
  const torsoGrid = document.getElementById('torso-grid');
  const shieldGrid = document.getElementById('shield-grid');
  const helmGrid = document.getElementById('helm-grid');
  for (const [key, src] of Object.entries(ASSET_MAP.weapon)) {
    await renderMainhand(mainGrid, key, src);
  }
  for (const [key, pose] of Object.entries(BACK_DERIVED_POSES)) {
    if (ASSET_MAP.weapon[key]) {
      await renderCell(backGrid, key, pose, ASSET_MAP.weapon[key]);
    }
  }
  for (const [key, pose] of Object.entries(WAIST_DERIVED_POSES)) {
    if (ASSET_MAP.weapon[key]) {
      await renderCell(waistGrid, key, pose, ASSET_MAP.weapon[key]);
    }
  }
  // Phase B — torso/shield/helm raw frame previews. Each shows the south-row
  // frame 0 just like the mainhand grid; visual sanity check before tuning.
  for (const [key, val] of Object.entries(ASSET_MAP.torso)) {
    const src = typeof val === 'string' ? val : (val?.male || val?.female);
    if (src) await renderMainhand(torsoGrid, key, src);
  }
  for (const [key, src] of Object.entries(ASSET_MAP.shield)) {
    await renderMainhand(shieldGrid, key, src);
  }
  for (const [key, src] of Object.entries(ASSET_MAP.helm)) {
    await renderMainhand(helmGrid, key, src);
  }
  // Phase C — capes / backpacks / neck variants
  const capeGrid = document.getElementById('cape-grid');
  const backpackGrid = document.getElementById('backpack-grid');
  const neckGrid = document.getElementById('neck-grid');
  for (const [key, src] of Object.entries(ASSET_MAP.cape || {})) {
    await renderMainhand(capeGrid, key, src);
  }
  // Phase D2 — backpack has nested {style: {variant: {gender}}} structure.
  // Iterate to show all four (straps_adventurer/straps_scholar/full_adventurer/full_scholar).
  for (const [styleKey, styleVal] of Object.entries(ASSET_MAP.backpack || {})) {
    for (const [variantKey, variantVal] of Object.entries(styleVal || {})) {
      const src = variantVal?.male || variantVal?.female;
      if (src) await renderMainhand(backpackGrid, `${styleKey}/${variantKey}`, src);
    }
  }
  for (const [key, val] of Object.entries(ASSET_MAP.amulet || {})) {
    const src = typeof val === 'string' ? val : (val?.male || val?.female);
    if (src) await renderMainhand(neckGrid, key, src);
  }
  // Phase D3 — hair / beards / facial / eyes
  const hairGrid = document.getElementById('hair-grid');
  const beardGrid = document.getElementById('beard-grid');
  const facialGrid = document.getElementById('facial-grid');
  const eyesGrid = document.getElementById('eyes-grid');
  for (const [key, src] of Object.entries(ASSET_MAP.hair || {})) {
    if (src) await renderMainhand(hairGrid, key, src);
  }
  for (const [key, src] of Object.entries(ASSET_MAP.beard || {})) {
    if (src) await renderMainhand(beardGrid, key, src);
  }
  for (const [key, src] of Object.entries(ASSET_MAP.facial || {})) {
    if (src) await renderMainhand(facialGrid, key, src);
  }
  for (const [key, src] of Object.entries(ASSET_MAP.eyes || {})) {
    if (src) await renderMainhand(eyesGrid, key, src);
  }
}

function clearGrids() {
  for (const id of ['main-grid','back-grid','waist-grid','torso-grid','shield-grid','helm-grid','cape-grid','backpack-grid','neck-grid','hair-grid','beard-grid','facial-grid','eyes-grid']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
}

function bindDirectionButtons() {
  document.querySelectorAll('#direction-bar button').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentDirection = btn.dataset.dir;
      document.querySelectorAll('#direction-bar button').forEach(b => b.removeAttribute('data-active'));
      btn.setAttribute('data-active', 'true');
      clearGrids();
      await init();
    });
  });
}

bindDirectionButtons();
init();

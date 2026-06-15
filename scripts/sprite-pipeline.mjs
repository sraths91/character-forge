// M60 spike — generate → curate → commit pipeline for AI-generated
// sprites (monsters / bosses, where LPC has no layer-composable source).
//
// Diffusion output is NOT LPC: it's a flat, unregistered image that does
// not compose with the 18-layer equipment stack. So generated sprites are
// standalone art, staged here and (later, in M60) wired via a bespoke
// `spriteSheet` render path — never through the LPC compositor.
//
// This tool is the PREP → CURATE → COMMIT pipeline:
//   - prep:     clean a raw diffusion export (downscale / slice / key bg)
//               into 64×64 transparent frame(s) — via the in-repo
//               png-io + sprite-transform modules (no ImageMagick needed).
//   - validate: gate a frame (exactly 64×64, transparent) via macOS `sips`.
//   - register: promote a frame into public/assets/generated/ + record
//               provenance in art-gen/manifest.json.
// Generation itself is manual (Draw Things / Retro Diffusion — see
// art-gen/README.md + SETUP.md).
//
// Usage:
//   node scripts/sprite-pipeline.mjs prep <raw.png> [--downscale N] \
//        [--slice CxR] [--bg '#rrggbb'|auto] [--tolerance N] [--out DIR]
//   node scripts/sprite-pipeline.mjs validate <file.png>
//   node scripts/sprite-pipeline.mjs register <frame.png> --slug goblin \
//        --pose idle --model "..." --prompt "..." [--seed 7]
//   node scripts/sprite-pipeline.mjs list

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync
} from 'node:fs';
import { readPng, writePng } from './png-io.mjs';
import { nnDownscale, sliceGrid, keyBackground, countColors } from './sprite-transform.mjs';

export const TARGET_CELL = 64;

// =====================================================================
// Pure helpers (unit-tested in src/tests/sprite-pipeline.test.js)
// =====================================================================

/** Normalize a free-text asset name to a filesystem-safe slug. */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** `<slug>_<pose>.png` — the committed-asset naming convention. */
export function assetFileName(slug, pose) {
  return `${slug}_${pose}.png`;
}

/**
 * Build one provenance record. `at` is passed in (ISO string) rather than
 * read from the clock so the shape is deterministic + testable.
 */
export function buildProvenanceEntry({
  slug, pose, model, prompt, seed = null,
  source = null, license = null, at
}) {
  return {
    slug,
    pose,
    file: `public/assets/generated/${assetFileName(slug, pose)}`,
    model: model || null,
    prompt: prompt || null,
    seed,
    source,
    license,
    generatedAt: at
  };
}

/**
 * Insert-or-replace an entry keyed by (slug, pose). Returns a NEW manifest
 * (does not mutate the input) so re-registering an asset overwrites its
 * provenance rather than duplicating it.
 */
export function upsertManifest(manifest, entry) {
  const assets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const next = assets.filter(a => !(a.slug === entry.slug && a.pose === entry.pose));
  next.push(entry);
  next.sort((a, b) => (a.slug + a.pose).localeCompare(b.slug + b.pose));
  return { schemaVersion: manifest?.schemaVersion || 1, assets: next };
}

/** Parse a `CxR` slice spec (e.g. "4x1", "2x2") → { cols, rows }. */
export function parseSliceSpec(spec) {
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(String(spec || '').trim());
  if (!m) throw new Error(`bad --slice "${spec}" (want CxR, e.g. 4x1)`);
  const cols = parseInt(m[1], 10);
  const rows = parseInt(m[2], 10);
  if (cols < 1 || rows < 1) throw new Error(`--slice cols/rows must be ≥ 1`);
  return { cols, rows };
}

/** Parse `#rrggbb` / `rrggbb` → { r, g, b }. */
export function parseHexColor(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) throw new Error(`bad color "${hex}" (want #rrggbb)`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** Output filename for a prepped frame: single → `<base>_prep.png`,
 *  multi → `<base>_prep_<i>.png`. */
export function prepFrameName(base, index, total) {
  return total === 1 ? `${base}_prep.png` : `${base}_prep_${index}.png`;
}

/** Gate a processed sprite: exactly one 64×64 cell, with transparency. */
export function validateProcessedMeta({ width, height, hasAlpha }) {
  const problems = [];
  if (width !== TARGET_CELL || height !== TARGET_CELL) {
    problems.push(`must be ${TARGET_CELL}×${TARGET_CELL}, got ${width}×${height}`);
  }
  if (!hasAlpha) {
    problems.push('must have an alpha channel (transparent background)');
  }
  return { ok: problems.length === 0, problems };
}

/** Parse `sips -g pixelWidth -g pixelHeight -g hasAlpha` stdout. */
export function parseSipsProps(stdout) {
  const out = { width: NaN, height: NaN, hasAlpha: false };
  for (const line of String(stdout).split('\n')) {
    const m = line.trim().match(/^(pixelWidth|pixelHeight|hasAlpha):\s*(.+)$/);
    if (!m) continue;
    if (m[1] === 'pixelWidth') out.width = parseInt(m[2], 10);
    else if (m[1] === 'pixelHeight') out.height = parseInt(m[2], 10);
    else if (m[1] === 'hasAlpha') out.hasAlpha = m[2].trim() === 'yes';
  }
  return out;
}

// =====================================================================
// CLI (impure: sips probe + fs promote)
// =====================================================================

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'art-gen', 'manifest.json');
const GEN_DIR = join(ROOT, 'public', 'assets', 'generated');

function readManifest() {
  if (!existsSync(MANIFEST)) return { schemaVersion: 1, assets: [] };
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); }
  catch { return { schemaVersion: 1, assets: [] }; }
}

function probe(file) {
  const stdout = execFileSync('sips',
    ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'hasAlpha', file],
    { encoding: 'utf8' });
  return parseSipsProps(stdout);
}

function fixHint(file, meta) {
  // Lead with the in-repo `prep` (no extra tooling); ImageMagick is the
  // labeled secondary path for anyone who prefers it.
  const ops = [];
  if (meta.width !== TARGET_CELL || meta.height !== TARGET_CELL) {
    const factor = meta.width && meta.width % TARGET_CELL === 0
      ? meta.width / TARGET_CELL : 'N';
    ops.push(`--downscale ${factor}`);
  }
  if (!meta.hasAlpha) ops.push(`--bg auto`);
  const lines = [
    '', 'To fix — run `prep` (in-repo, no extra tools):',
    `  node scripts/sprite-pipeline.mjs prep "${file}" ${ops.join(' ')}`.trimEnd(),
    '  …then register the *_prep.png it writes.',
    'Alternatively (ImageMagick — `brew install imagemagick`):'
  ];
  if (meta.width !== TARGET_CELL || meta.height !== TARGET_CELL) {
    lines.push(`  magick "${file}" -filter point -resize ${TARGET_CELL}x${TARGET_CELL} "${file}"`);
  }
  if (!meta.hasAlpha) {
    lines.push(`  magick "${file}" -fuzz 8% -transparent '#RRGGBB' "${file}"`);
  }
  return lines.join('\n');
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return flags;
}

function cmdPrep(file, flags) {
  let img;
  try { img = readPng(file); }
  catch (e) { console.error(`prep: cannot read ${file}: ${e.message}`); return 1; }
  const steps = [`read ${img.width}×${img.height}`];

  // 1. downscale (whole image, before slicing)
  if (flags.downscale != null) {
    const f = Number(flags.downscale);
    try { img = nnDownscale(img, f); }
    catch (e) { console.error(`prep: ${e.message}`); return 1; }
    steps.push(`downscale ×${f} → ${img.width}×${img.height}`);
  }

  // 2. slice into a grid of frames (default: the single image)
  let frames = [img];
  if (flags.slice) {
    let spec;
    try { spec = parseSliceSpec(flags.slice); frames = sliceGrid(img, spec.cols, spec.rows); }
    catch (e) { console.error(`prep: ${e.message}`); return 1; }
    steps.push(`slice ${spec.cols}×${spec.rows} → ${frames.length} frame(s) of ${frames[0].width}×${frames[0].height}`);
  }

  // 3. key the flat background to alpha (per frame; `auto` = its corner)
  if (flags.bg) {
    const tol = flags.tolerance != null ? Number(flags.tolerance) : 8;
    try {
      frames = frames.map(fr => {
        const color = flags.bg === 'auto'
          ? { r: fr.rgba[0], g: fr.rgba[1], b: fr.rgba[2] }
          : parseHexColor(flags.bg);
        return keyBackground(fr, color, tol);
      });
    } catch (e) { console.error(`prep: ${e.message}`); return 1; }
    steps.push(`key bg ${flags.bg} (tol ${tol})`);
  }

  // write
  const outDir = flags.out || join(ROOT, 'art-gen', 'raw');
  mkdirSync(outDir, { recursive: true });
  const base = basename(file).replace(/\.png$/i, '');
  console.log(steps.join('  →  '));
  frames.forEach((fr, i) => {
    const name = prepFrameName(base, i, frames.length);
    writePng(join(outDir, name), fr);
    const ready = fr.width === TARGET_CELL && fr.height === TARGET_CELL;
    console.log(`  ${name}  ${fr.width}×${fr.height}  ${countColors(fr)} colors  ` +
      (ready ? '→ ready to register' : `→ NOT ${TARGET_CELL}×${TARGET_CELL}; register will reject`));
  });
  return 0;
}

function cmdValidate(file) {
  const meta = probe(file);
  const v = validateProcessedMeta(meta);
  console.log(`${basename(file)}: ${meta.width}×${meta.height}, alpha=${meta.hasAlpha}`);
  if (v.ok) { console.log('  OK — ready to register.'); return 0; }
  console.log('  NOT READY:'); v.problems.forEach(p => console.log(`   - ${p}`));
  console.log(fixHint(file, meta));
  return 1;
}

function cmdRegister(file, flags) {
  if (!flags.slug || !flags.pose) {
    console.error('register requires --slug and --pose'); return 1;
  }
  const slug = slugify(flags.slug);
  const meta = probe(file);
  const v = validateProcessedMeta(meta);
  if (!v.ok) {
    console.error(`Cannot register — ${basename(file)} failed validation:`);
    v.problems.forEach(p => console.error(`   - ${p}`));
    console.error(fixHint(file, meta));
    return 1;
  }
  mkdirSync(GEN_DIR, { recursive: true });
  const destName = assetFileName(slug, flags.pose);
  copyFileSync(file, join(GEN_DIR, destName));
  const entry = buildProvenanceEntry({
    slug, pose: flags.pose, model: flags.model, prompt: flags.prompt,
    seed: flags.seed != null ? Number(flags.seed) : null,
    source: flags.source || null, license: flags.license || null,
    at: new Date().toISOString()
  });
  const manifest = upsertManifest(readManifest(), entry);
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Registered ${destName} → public/assets/generated/`);
  console.log(`Provenance recorded in art-gen/manifest.json (${manifest.assets.length} asset(s)).`);
  if (!entry.model || !entry.prompt) {
    console.log('NOTE: --model and --prompt are blank; fill them for clean attribution.');
  }
  return 0;
}

function cmdList() {
  const m = readManifest();
  if (!m.assets.length) { console.log('No generated assets registered yet.'); return 0; }
  for (const a of m.assets) {
    console.log(`${a.slug}/${a.pose}  ${a.model || '(no model)'}  ${a.generatedAt || ''}`);
  }
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'prep' && rest[0]) return cmdPrep(rest[0], parseFlags(rest.slice(1)));
  if (cmd === 'validate' && rest[0]) return cmdValidate(rest[0]);
  if (cmd === 'register' && rest[0]) return cmdRegister(rest[0], parseFlags(rest.slice(1)));
  if (cmd === 'list') return cmdList();
  console.log('Usage:');
  console.log('  node scripts/sprite-pipeline.mjs prep <raw.png> [--downscale N] [--slice CxR] [--bg #rrggbb|auto] [--tolerance N] [--out DIR]');
  console.log('  node scripts/sprite-pipeline.mjs validate <file.png>');
  console.log('  node scripts/sprite-pipeline.mjs register <frame.png> --slug <name> --pose <pose> [--model ..] [--prompt ..] [--seed N] [--source ..] [--license ..]');
  console.log('  node scripts/sprite-pipeline.mjs list');
  return cmd ? 1 : 0;
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

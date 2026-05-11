// One-off extraction probe: fetch a public D&DB character, run through
// parseCharacter, and dump the appearance-relevant raw fields side-by-side
// with parsed output so we can verify field-name assumptions.
import { fetchDdbCharacter, extractCharacterId } from '../api/lib/ddb-fetch.js';
import { parseCharacter } from '../api/lib/ddb-parser.js';

const url = process.argv[2] || 'https://www.dndbeyond.com/characters/148566289';
const id = extractCharacterId(url);
if (!id) { console.error('Could not extract character id from', url); process.exit(1); }

console.log(`Fetching D&DB character ${id}…\n`);
let raw;
try {
  raw = await fetchDdbCharacter(id);
} catch (e) {
  console.error('Fetch failed:', e.message, e.code || '');
  process.exit(1);
}

const fields = ['hair','eyes','skin','age','height','weight','gender','faith','lifestyleId','lifestyle','inspiration'];
console.log('=== Raw background ===');
console.log('  background.definition.name        :', JSON.stringify(raw.background?.definition?.name));
console.log('  background.customBackground.name  :', JSON.stringify(raw.background?.customBackground?.name));
console.log('  background.hasCustomBackground    :', JSON.stringify(raw.background?.hasCustomBackground));
console.log();
console.log('=== Raw D&DB top-level appearance fields ===');
for (const f of fields) {
  const v = raw[f];
  console.log(`  ${f.padEnd(14)}: ${v === undefined ? '(missing)' : JSON.stringify(v)}`);
}
console.log('\n=== Raw traits ===');
for (const k of ['personalityTraits','ideals','bonds','flaws','appearance','backstory']) {
  const v = raw.traits?.[k];
  console.log(`  traits.${k.padEnd(20)}: ${v === undefined ? '(missing)' : JSON.stringify(String(v).slice(0,80))}`);
}
console.log(`  notes.backstory     : ${raw.notes?.backstory === undefined ? '(missing)' : JSON.stringify(String(raw.notes.backstory).slice(0,80))}`);

console.log('\n=== Parsed character (sprite-relevant subset) ===');
const parsed = parseCharacter(raw);
console.log('  name        :', parsed.name);
console.log('  race        :', parsed.race);
console.log('  classes     :', parsed.classes);
console.log('  level       :', parsed.level);
console.log('  gender      :', parsed.gender);
console.log('  faith       :', parsed.faith);
console.log('  lifestyle   :', parsed.lifestyle);
console.log('  inspiration :', parsed.inspiration);
console.log('  hp          :', parsed.hp);
console.log('  deathSaves  :', parsed.deathSaves);
console.log('  skinTone    :', parsed.skinTone);
console.log('  appearance  :', parsed.appearance);
console.log('  feats       :', parsed.feats);
console.log('  equipped    :', Object.fromEntries(Object.entries(parsed.equipment)
  .filter(([_,v]) => v != null && (Array.isArray(v) ? v.length : true))
  .map(([k,v]) => [k, Array.isArray(v) ? v.map(x => x.name) : v?.name])));
console.log('  carried (n) :', parsed.carried.length);

// Run through buildRenderPlan to confirm pipeline works
const { buildRenderPlan } = await import('../src/js/sprite/lpc-config.js');
const plan = buildRenderPlan(parsed);
console.log('\n=== Plan state (Phases F1, H, E2) ===');
console.log('  hpState        :', plan.hpState);
console.log('  subclassAura   :', plan.subclassAura);
console.log('  concentration  :', plan.concentrationAura);
console.log('  tempHpAura     :', plan.tempHpAura);
console.log('  bodyWidth      :', plan.bodyWidth);
console.log('\n=== Sprite layers emitted ===');
for (const l of plan.layers) {
  const src = l.src ? l.src.split('/').slice(-2).join('/') : '';
  const filter = l.filter ? ` [filter:${String(l.filter).slice(0,40)}]` : '';
  const extra = l.kind === 'glyph' ? ` glyph=${l.glyph}` : '';
  console.log(`  ${(l.slot||l.kind).padEnd(14)} ${l.kind.padEnd(13)} ${src}${filter}${extra}`);
}

console.log(`\n=== Hash of raw response (for diffing across runs) ===`);
const rawJson = JSON.stringify(raw);
const c = await import('node:crypto');
console.log('  size :', rawJson.length, 'bytes');
console.log('  sha256:', c.createHash('sha256').update(rawJson).digest('hex'));

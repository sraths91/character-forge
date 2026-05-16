/**
 * M23 — Character diff for re-imports.
 *
 * Compares a previously-parsed character against a newly-parsed one
 * (typically after the player levels up, attunes a new item, or just
 * re-imports the same D&DB sheet) and returns a sorted list of
 * meaningful changes the UI can render in a sync banner.
 *
 * Pure module. No DOM. Defensive against missing fields on either side
 * (a first-time import passes `null` for `prev` and gets [] back).
 *
 * Diff output shape:
 *   [
 *     { kind: 'level',       direction: 'up' | 'down', from, to },
 *     { kind: 'class-level', class, from, to },
 *     { kind: 'subclass',    class, name },          // newly chosen
 *     { kind: 'hp-max',      from, to, delta },
 *     { kind: 'ability',     stat, from, to },
 *     { kind: 'spell-added',   name, level },
 *     { kind: 'spell-removed', name, level },
 *     { kind: 'feature-added',   name, source, level },
 *     { kind: 'feature-removed', name, source },
 *     { kind: 'feat-added',   name },
 *     { kind: 'feat-removed', name },
 *     { kind: 'equipment-added',   slot, name },
 *     { kind: 'equipment-removed', slot, name }
 *   ]
 *
 * Order: structural changes (level/class) first, then numeric
 * (hp/abilities), then content (spells/features/feats/equipment).
 */

const PRIORITY = {
  'level':            10,
  'class-level':      11,
  'subclass':         12,
  'hp-max':           20,
  'ability':          21,
  'feature-added':    30,
  'feature-removed':  31,
  'spell-added':      40,
  'spell-removed':    41,
  'feat-added':       50,
  'feat-removed':     51,
  'equipment-added':  60,
  'equipment-removed':61
};

export function diffCharacters(prev, next) {
  if (!prev || !next) return [];
  const out = [];

  // Total level
  if (prev.level !== next.level && Number.isFinite(prev.level) && Number.isFinite(next.level)) {
    out.push({
      kind: 'level',
      direction: next.level > prev.level ? 'up' : 'down',
      from: prev.level, to: next.level
    });
  }

  // Per-class level + subclass
  const prevClasses = new Map((prev.classes || []).map(c => [c.name, c]));
  const nextClasses = new Map((next.classes || []).map(c => [c.name, c]));
  for (const [name, c] of nextClasses) {
    const before = prevClasses.get(name);
    if (!before) {
      // Brand-new class (multiclassing into something new)
      out.push({ kind: 'class-level', class: name, from: 0, to: c.level });
      if (c.subclass) out.push({ kind: 'subclass', class: name, name: c.subclass });
      continue;
    }
    if (before.level !== c.level) {
      out.push({ kind: 'class-level', class: name, from: before.level, to: c.level });
    }
    if (!before.subclass && c.subclass) {
      out.push({ kind: 'subclass', class: name, name: c.subclass });
    }
  }

  // HP max
  if (prev.hp?.max != null && next.hp?.max != null && prev.hp.max !== next.hp.max) {
    out.push({
      kind: 'hp-max',
      from: prev.hp.max, to: next.hp.max,
      delta: next.hp.max - prev.hp.max
    });
  }

  // Ability scores
  const stats = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
  for (const s of stats) {
    const a = prev.abilityScores?.[s];
    const b = next.abilityScores?.[s];
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      out.push({ kind: 'ability', stat: s, from: a, to: b });
    }
  }

  // Spells (by name + level)
  diffByKey(out,
    prev.spells || [], next.spells || [],
    s => `${s.name}|${s.level}`,
    s => ({ name: s.name, level: s.level }),
    'spell-added', 'spell-removed'
  );

  // Class features (by name + source)
  diffByKey(out,
    prev.classFeatures || [], next.classFeatures || [],
    f => `${f.name}|${f.source}`,
    f => ({ name: f.name, source: f.source, level: f.level }),
    'feature-added', 'feature-removed'
  );

  // Feats (array of strings)
  const prevFeats = new Set(prev.feats || []);
  const nextFeats = new Set(next.feats || []);
  for (const f of nextFeats) if (!prevFeats.has(f)) out.push({ kind: 'feat-added', name: f });
  for (const f of prevFeats) if (!nextFeats.has(f)) out.push({ kind: 'feat-removed', name: f });

  // Equipment (compare slot-by-slot)
  const slots = ['armor', 'mainhand', 'offhand', 'helm', 'cloak', 'gloves', 'boots', 'belt', 'amulet'];
  for (const slot of slots) {
    const a = prev.equipment?.[slot]?.name || null;
    const b = next.equipment?.[slot]?.name || null;
    if (a === b) continue;
    if (a && !b) out.push({ kind: 'equipment-removed', slot, name: a });
    else if (!a && b) out.push({ kind: 'equipment-added', slot, name: b });
    else { out.push({ kind: 'equipment-removed', slot, name: a }); out.push({ kind: 'equipment-added', slot, name: b }); }
  }

  out.sort((x, y) => (PRIORITY[x.kind] ?? 99) - (PRIORITY[y.kind] ?? 99));
  return out;
}

function diffByKey(out, prevList, nextList, keyFn, summaryFn, addedKind, removedKind) {
  const prevKeys = new Map(prevList.map(x => [keyFn(x), x]));
  const nextKeys = new Map(nextList.map(x => [keyFn(x), x]));
  for (const [k, v] of nextKeys) if (!prevKeys.has(k)) out.push({ kind: addedKind, ...summaryFn(v) });
  for (const [k, v] of prevKeys) if (!nextKeys.has(k)) out.push({ kind: removedKind, ...summaryFn(v) });
}

/**
 * Produce a one-line human label for a diff entry. Used by the UI.
 */
export function describeDiff(entry) {
  switch (entry.kind) {
    case 'level':
      return `Leveled ${entry.direction} to ${entry.to} (was ${entry.from})`;
    case 'class-level':
      return entry.from === 0
        ? `Multiclassed into ${entry.class} (now level ${entry.to})`
        : `${entry.class} level: ${entry.from} → ${entry.to}`;
    case 'subclass':
      return `Chose subclass for ${entry.class}: ${entry.name}`;
    case 'hp-max':
      return `Max HP ${entry.from} → ${entry.to} (${entry.delta >= 0 ? '+' : ''}${entry.delta})`;
    case 'ability':
      return `${entry.stat}: ${entry.from} → ${entry.to}`;
    case 'spell-added':   return `+ Spell: ${entry.name} (L${entry.level})`;
    case 'spell-removed': return `− Spell: ${entry.name} (L${entry.level})`;
    case 'feature-added':   return `+ Feature: ${entry.name}${entry.source ? ` (${entry.source})` : ''}`;
    case 'feature-removed': return `− Feature: ${entry.name}${entry.source ? ` (${entry.source})` : ''}`;
    case 'feat-added':   return `+ Feat: ${entry.name}`;
    case 'feat-removed': return `− Feat: ${entry.name}`;
    case 'equipment-added':   return `+ ${entry.slot}: ${entry.name}`;
    case 'equipment-removed': return `− ${entry.slot}: ${entry.name}`;
    default: return JSON.stringify(entry);
  }
}

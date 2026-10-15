/**
 * M64 H3 — shared test builders for engine wrappers and scenes.
 *
 * New tests import these instead of re-declaring `buildPc` /
 * `buildMonster` per file. Two layers:
 *
 *   buildPc / buildMonster / buildScene — minimal hand-rolled wrappers in
 *     the engine's expected shape (the M45 Phase 4b builders), cheap and
 *     dependency-free, for focused unit tests.
 *   pcFromSheet / monsterFromPreset — full wrappers built exactly the way
 *     the simulator builds them (simulator.js runOneIteration), from a
 *     parsed character or a MONSTER_PRESETS slug.
 *   loadDdbFixture / parsedDdbFixture — the SYNTHETIC D&D Beyond fixtures
 *     in src/tests/fixtures/ddb/ (never real user exports).
 *
 * These wrappers are today's engine shape. When M64 T5 lands, tests that
 * need EncounterState should build it and go through encounter-adapters.
 */

import { readFileSync } from 'node:fs';
import { parseCharacter } from '../../../api/lib/ddb-parser.js';
import { deriveAC } from '../../js/scene/pc-stats.js';
import { MONSTER_PRESETS } from '../../js/scene/monster-presets.js';
import { slotsForPc, lvl1SlotsForPc, lvl3SlotsForPc } from '../../js/scene/reactions.js';
import { isSpellcaster, freshSlots, isInnateCaster, freshInnateState } from '../../js/scene/monster-spells.js';
import { isLegendary, freshLegendaryBudget } from '../../js/scene/monster-legendary.js';

/** Names of the synthetic DDB fixtures shipped with the repo. */
export const DDB_FIXTURES = Object.freeze(['fighter-l5', 'wizard-l5', 'cleric-l5']);

/**
 * Minimal PC wrapper (Fighter 5, longsword) in the engine's shape.
 * @param {object} [overrides] — shallow-merged over the defaults
 * @returns {object}
 */
export function buildPc(overrides = {}) {
  return {
    ref: {
      name: 'Hero', classes: [{ name: 'Fighter', level: 5 }],
      equipment: { mainhand: { name: 'Longsword' } },
      abilityModifiers: { STR: 3, DEX: 2, CON: 2, INT: 0, WIS: 1, CHA: 0 }
    },
    id: 'pc1', name: 'Hero', kind: 'pc',
    hp: 30, hpMax: 30, ac: 16,
    weapon: { name: 'Longsword' },
    conditions: [], damageDealt: 0,
    _position: { col: 1, row: 1 },
    _sneakAttackUsedThisTurn: false,
    _cunningActionUsedThisTurn: false,
    _recklessUsedThisTurn: false,
    ...overrides
  };
}

/**
 * Minimal monster wrapper (goblin) in the engine's shape.
 * @param {object} [overrides]
 * @returns {object}
 */
export function buildMonster(overrides = {}) {
  return {
    ref: { name: 'Goblin' },
    id: 'm1', name: 'Goblin', kind: 'monster',
    presetSlug: 'goblin',
    hp: 7, hpMax: 7, ac: 12,
    attack: { name: 'Scimitar', bonus: 4, dice: '1d6+2' },
    conditions: [], damageDealt: 0,
    position: { col: 2, row: 1 },
    ...overrides
  };
}

/**
 * Scene record as the engine reads it.
 * @param {object} [overrides]
 * @returns {{cols: number, rows: number, flankingEnabled: boolean}}
 */
export function buildScene(overrides = {}) {
  return { cols: 10, rows: 7, flankingEnabled: false, ...overrides };
}

/**
 * Full PC wrapper from a parsed character, built like the simulator does.
 * @param {object} sheet — output of parseCharacter
 * @param {object} [overrides] — e.g. { id, hp, _position }
 * @returns {object}
 */
export function pcFromSheet(sheet, overrides = {}) {
  const mainhand = sheet.equipment?.mainhand || null;
  return {
    ref: sheet, id: sheet.id, name: sheet.name || 'PC', kind: 'pc',
    hp: sheet.hp?.current ?? sheet.hp?.max ?? 10,
    hpMax: sheet.hp?.max ?? 10,
    ac: deriveAC(sheet),
    weapon: mainhand,
    _chosenWeapon: mainhand,
    conditions: Array.isArray(sheet.conditions) ? [...sheet.conditions] : [],
    _position: { col: 0, row: 0 },
    damageDealt: 0,
    combatMods: sheet.combatMods || [],
    _reactionUsed: false,
    _lvl1Slots: lvl1SlotsForPc(sheet),
    _lvl3Slots: lvl3SlotsForPc(sheet),
    _slots: slotsForPc(sheet),
    _shieldActive: false,
    _actionSurgeUsed: 0,
    _secondWindUsed: false,
    _sneakAttackUsedThisTurn: false,
    _cunningActionUsedThisTurn: false,
    ...overrides
  };
}

/**
 * Full monster wrapper from a MONSTER_PRESETS slug, built like the simulator does.
 * @param {string} slug
 * @param {object} [overrides] — e.g. { id, position, hp }
 * @returns {object}
 */
export function monsterFromPreset(slug, overrides = {}) {
  const preset = MONSTER_PRESETS[slug];
  if (!preset) throw new Error(`monsterFromPreset: unknown preset "${slug}"`);
  const hpMax = preset.defaultHp?.max ?? 1;
  return {
    ref: { name: preset.name, presetSlug: slug },
    id: overrides.id || slug, name: preset.name, kind: 'monster', presetSlug: slug,
    hp: hpMax, hpMax,
    ac: preset.ac ?? 12,
    attack: { ...(preset.attack || { name: 'Strike', bonus: 2, dice: '1d6' }) },
    conditions: [],
    position: { col: 0, row: 0 },
    damageDealt: 0,
    _reactionUsed: false,
    _slots: isSpellcaster(slug) ? freshSlots(slug) : null,
    _innate: isInnateCaster(slug) ? freshInnateState(slug) : null,
    _legendaryBudget: isLegendary(slug) ? freshLegendaryBudget(slug) : 0,
    _concentrating: null,
    ...overrides
  };
}

/**
 * Raw (unparsed) synthetic DDB fixture.
 * @param {string} name — one of DDB_FIXTURES
 * @returns {object}
 */
export function loadDdbFixture(name) {
  if (!DDB_FIXTURES.includes(name)) throw new Error(`loadDdbFixture: unknown fixture "${name}"`);
  return JSON.parse(readFileSync(new URL(`../fixtures/ddb/${name}.json`, import.meta.url), 'utf8'));
}

/**
 * Parsed synthetic DDB fixture (parseCharacter output), fresh each call.
 * @param {string} name — one of DDB_FIXTURES
 * @returns {object}
 */
export function parsedDdbFixture(name) {
  return parseCharacter(loadDdbFixture(name));
}

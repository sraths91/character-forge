/**
 * Appearance / direction / inspiration customization overrides.
 *
 * Mirrors slot-overrides.js but stores cosmetic customization (hair style,
 * hair color, eye color, beard style, facial accessory, body width, skin
 * tone, render direction, inspiration toggle) keyed by character id so it
 * survives page reload.
 *
 * Schema (all fields optional — undefined means "fall through to D&DB or
 * race default", never overrides):
 *   {
 *     hairStyle: 'buzzcut'|'long'|...,
 *     hairColor: 'brown'|'black'|'blonde'|'red'|'gray'|'white',
 *     eyeColor:  'blue'|'brown'|'green'|'gray',
 *     beardStyle: 'basic'|'medium'|'winter'|'mustache'|'none',
 *     facial:    'glasses'|'eyepatch'|'none',
 *     bodyWidth: 'thin'|'normal'|'broad',
 *     skinTone:  'light'|'pale'|'tan'|'olive'|'dark'|'ashen'|'green'|'red'|'blue',
 *     direction: 'north'|'west'|'south'|'east',
 *     inspiration: true|false
 *   }
 */

const STORAGE_PREFIX = 'cf_appearance_';

export function loadAppearance(characterId) {
  if (!characterId) return {};
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + characterId);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveAppearance(characterId, overrides) {
  if (!characterId) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + characterId, JSON.stringify(overrides));
  } catch { /* quota / private mode — ignore */ }
}

/**
 * Apply persisted appearance overrides onto the character before render.
 * Returns the mutated character (in-place) so callers can chain.
 *
 * The override schema is "shallow" — only set fields are applied. Where
 * the renderer reads from nested structures (character.hair.style, etc.),
 * we set those nested fields.
 */
export function applyAppearanceOverrides(character, overrides) {
  if (!overrides) return character;

  if (overrides.hairStyle || overrides.hairColor) {
    character.hair = character.hair || {};
    if (overrides.hairStyle) character.hair.style = overrides.hairStyle;
    if (overrides.hairColor) character.hair.color = overrides.hairColor;
  }
  if (overrides.eyeColor) {
    character.eyes = character.eyes || {};
    character.eyes.color = overrides.eyeColor;
  }
  if (overrides.beardStyle === 'none') {
    character.beard = { style: 'none' };   // pickBeard treats 'none' as suppress
  } else if (overrides.beardStyle) {
    character.beard = character.beard || {};
    character.beard.style = overrides.beardStyle;
  }
  if (overrides.facial === 'none') {
    character.facial = '__none__';         // pickFacial treats sentinel as suppress
  } else if (overrides.facial) {
    character.facial = overrides.facial;
  }
  if (overrides.bodyWidth) {
    character.visualHints = { ...(character.visualHints || {}), bodyWidth: overrides.bodyWidth };
  }
  if (overrides.skinTone) {
    character.skinTone = overrides.skinTone;
  }
  if (typeof overrides.inspiration === 'boolean') {
    character.inspiration = overrides.inspiration;
  }
  // Phase E2 — HP override (clamped to character.hp.max). Stored as a delta
  // to existing hp.current so the original D&DB-imported value is preserved.
  if (typeof overrides.hpCurrent === 'number') {
    character.hp = { ...(character.hp || {}) };
    const max = character.hp.max ?? overrides.hpCurrent;
    character.hp.current = Math.max(0, Math.min(max, overrides.hpCurrent));
  }
  // Phase E3 — conditions array
  if (Array.isArray(overrides.conditions)) {
    character.conditions = overrides.conditions;
  }
  // Phase H — concentration spell
  if ('concentration' in overrides) {
    character.concentration = overrides.concentration || null;
  }
  return character;
}

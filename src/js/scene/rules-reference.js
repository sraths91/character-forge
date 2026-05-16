/**
 * M19 — Rules reference: maps every reason-text the combat resolver
 * emits to a one-line rule explanation and PHB / DMG page citation.
 *
 * The UI uses this to add a `title=` tooltip to every chip ("Adv:
 * Target blinded", "Dis: Attacker poisoned", "Out of reach", etc.)
 * so the DM can hover any reason and see WHY the engine ruled that way.
 *
 * Lookup is by exact reason string or a leading-prefix match (so
 * dynamic reasons like "Flanking with Adrin" or "Out of reach (15 ft
 * away, 5 ft reach)" still resolve).
 *
 * Sources cite 5e SRD / Player's Handbook 2014 page numbers (most
 * widely-circulated reference). The 2024 PHB renumbered some entries
 * but the rule text is largely unchanged.
 */

// Exact-match map: reason → { rule, page }
const EXACT = new Map();

// Prefix-match list: ordered so longer prefixes try first. Each entry
// is [ prefix, { rule, page } ].
const PREFIXES = [];

function reg(reasons, ref) {
  for (const r of (Array.isArray(reasons) ? reasons : [reasons])) {
    EXACT.set(r, ref);
  }
}
function regPrefix(prefix, ref) {
  PREFIXES.push([prefix, ref]);
  // Re-sort longest-first so "Out of reach (15 ft …)" matches the
  // "Out of reach" prefix not the empty string.
  PREFIXES.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Look up the rule + page citation for a reason string. Falls through
 * the exact map, then prefix list, then returns null for unknown strings.
 */
export function ruleFor(reason) {
  if (!reason) return null;
  const exact = EXACT.get(reason);
  if (exact) return exact;
  for (const [prefix, ref] of PREFIXES) {
    if (reason.startsWith(prefix)) return ref;
  }
  return null;
}

/**
 * Convenience: returns a `title=`-ready string like "PHB p195: a ranged
 * attacker within 5 ft of a hostile has disadvantage." Used by the UI
 * to add tooltips without each call site duplicating the formatting.
 */
export function tooltipFor(reason) {
  const ref = ruleFor(reason);
  if (!ref) return null;
  return `${ref.page}: ${ref.rule}`;
}

// ---------- Attacker conditions (PHB p292–293) ----------

reg('Attacker poisoned', {
  rule: 'a poisoned creature has disadvantage on attack rolls and ability checks.',
  page: 'PHB p292'
});
reg('Attacker blinded', {
  rule: 'a blinded creature has disadvantage on attack rolls.',
  page: 'PHB p290'
});
reg('Attacker frightened', {
  rule: 'a frightened creature has disadvantage on ability checks and attack rolls while it can see the source of its fear.',
  page: 'PHB p290'
});
reg('Attacker restrained', {
  rule: 'a restrained creature has disadvantage on attack rolls.',
  page: 'PHB p292'
});
reg('Attacker prone', {
  rule: 'a prone creature has disadvantage on attack rolls.',
  page: 'PHB p292'
});
reg('Attacker invisible', {
  rule: 'an invisible creature has advantage on attack rolls.',
  page: 'PHB p291'
});

// ---------- Target conditions (PHB p290–293) ----------

reg('Target blinded', {
  rule: 'attack rolls against a blinded creature have advantage.',
  page: 'PHB p290'
});
reg('Target restrained', {
  rule: 'attack rolls against a restrained creature have advantage.',
  page: 'PHB p292'
});
reg('Target invisible', {
  rule: 'attack rolls against an invisible creature have disadvantage.',
  page: 'PHB p291'
});
reg('Target paralyzed', {
  rule: 'attack rolls against a paralyzed creature have advantage; a melee hit within 5 ft is an automatic critical.',
  page: 'PHB p291'
});
reg('Target stunned', {
  rule: 'attack rolls against a stunned creature have advantage.',
  page: 'PHB p292'
});
reg('Target unconscious', {
  rule: 'attack rolls against an unconscious creature have advantage; a melee hit within 5 ft is an automatic critical.',
  page: 'PHB p292'
});
reg('Target petrified', {
  rule: 'attack rolls against a petrified creature have advantage.',
  page: 'PHB p291'
});
reg('Target prone (melee)', {
  rule: 'attack rolls against a prone creature have advantage if attacker is within 5 ft.',
  page: 'PHB p292'
});
reg('Target prone (ranged)', {
  rule: 'attack rolls against a prone creature have disadvantage if the attacker is not within 5 ft.',
  page: 'PHB p292'
});

// ---------- Positional rules (M14) ----------

regPrefix('Flanking with', {
  rule: '(optional rule) a creature on the opposite side of a target from an ally has advantage on melee attacks.',
  page: 'DMG p251'
});
regPrefix('Ranged attacker adjacent to', {
  rule: 'you have disadvantage on a ranged attack roll if you are within 5 ft of a hostile that isn\'t incapacitated.',
  page: 'PHB p195'
});
regPrefix('Out of reach', {
  rule: 'a melee weapon attack reaches only as far as the weapon\'s reach (5 ft, or 10 ft for reach weapons).',
  page: 'PHB p195'
});

// ---------- AutoCrit / autoMiss reasons ----------

regPrefix('Target paralyzed, melee within 5 ft', {
  rule: 'a melee hit on a paralyzed creature within 5 ft is an automatic critical hit.',
  page: 'PHB p291'
});
regPrefix('Target unconscious, melee within 5 ft', {
  rule: 'a melee hit on an unconscious creature within 5 ft is an automatic critical hit.',
  page: 'PHB p292'
});
reg('Attacker is paralyzed (incapacitated — cannot attack)', {
  rule: 'a paralyzed creature is incapacitated; an incapacitated creature can\'t take actions.',
  page: 'PHB p291'
});
reg('Attacker is stunned (incapacitated — cannot attack)', {
  rule: 'a stunned creature is incapacitated; an incapacitated creature can\'t take actions.',
  page: 'PHB p292'
});
reg('Attacker is unconscious (incapacitated — cannot attack)', {
  rule: 'an unconscious creature is incapacitated; an incapacitated creature can\'t take actions.',
  page: 'PHB p292'
});
reg('Attacker is petrified (incapacitated — cannot attack)', {
  rule: 'a petrified creature is incapacitated; an incapacitated creature can\'t take actions.',
  page: 'PHB p291'
});
reg('Attacker is charmed (cannot attack)', {
  rule: 'a charmed creature can\'t attack the charmer or target them with harmful abilities or magical effects.',
  page: 'PHB p290'
});

// ---------- Sneak Attack reasons (M15) ----------

reg('Advantage on the attack', {
  rule: 'once per turn, a rogue can deal extra damage with a finesse or ranged weapon when they have advantage on the attack roll.',
  page: 'PHB p96'
});
regPrefix('Ally adjacent to target', {
  rule: '(rogue) Sneak Attack also triggers if another enemy of the target is within 5 ft, that enemy isn\'t incapacitated, and you don\'t have disadvantage.',
  page: 'PHB p96'
});
reg('Weapon must be finesse or ranged', {
  rule: 'Sneak Attack only applies with a finesse weapon or a ranged weapon.',
  page: 'PHB p96'
});
reg('Cannot sneak attack with disadvantage', {
  rule: 'Sneak Attack requires no disadvantage on the attack roll, regardless of other triggers.',
  page: 'PHB p96'
});
reg('Need advantage OR ally within 5 ft of target', {
  rule: 'Sneak Attack requires advantage on the attack roll OR an unincapacitated ally within 5 ft of the target.',
  page: 'PHB p96'
});

// ---------- Action-panel block reasons (M17) ----------

regPrefix('No targets in reach', {
  rule: 'no hostile is within this weapon\'s reach from your current cell. Drag closer or pick a ranged weapon.',
  page: 'PHB p195'
});
regPrefix('No targets within', {
  rule: 'no hostile is within this weapon or spell\'s range from your current cell.',
  page: 'PHB p195'
});
reg('Speed 0 (grappled / restrained)', {
  rule: 'a grappled or restrained creature\'s speed becomes 0 and it can\'t benefit from any bonus to speed.',
  page: 'PHB p290'
});
reg('Blinded', {
  rule: 'a blinded creature automatically fails any ability check requiring sight.',
  page: 'PHB p290'
});
reg('No ally within 5 ft', {
  rule: 'the Help action requires an ally within 5 ft of you (or of a target, when granting attack advantage).',
  page: 'PHB p192'
});
regPrefix('Prone — half movement', {
  rule: 'standing up costs half your movement; while prone you can still take the Dash action but at the standing-up cost.',
  page: 'PHB p190'
});
regPrefix('Incapacitated', {
  rule: 'an incapacitated creature can\'t take actions or reactions.',
  page: 'PHB p290'
});

// ---------- Override + meta ----------

regPrefix('Override:', {
  rule: 'the d20 mode was set manually via the Auto/Adv/Dis/Normal radio in the combat panel.',
  page: 'character-forge'
});

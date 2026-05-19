# Deferred milestones

Animation-polish items paused while we work on combat AI + mechanics
correctness. Pick these up when the combat issues are resolved.

## M44.4 — Bow projectile arcs across the cinematic horizon

**Current behaviour.** `cinema.js`'s `drawProjectile` traces a straight
line from the attacker's anchor to the defender's anchor — a hand-tip
to torso lerp. It looks fine when the cinema view is "flat" (M43.2) but
now that we have a horizon with parallax silhouettes (M44.2), the
arrow looking like it's glued to a billboard sells the illusion poorly.

**Goal.** A proper projectile arc — ballistic-style — with a peak
between attacker and defender that lands at the impact moment.

**Approach.**
1. In `cinema.js` `drawProjectile`, replace the linear lerp with a
   quadratic Bézier whose control point is `midX, midY - arcHeight`.
2. `arcHeight` defaults to ~40px but scales with travel distance, so
   short-range bow shots arc less than long-range ones.
3. Compute the tangent at the current `u` and rotate the arrowhead to
   match — currently the head is a circle (direction-agnostic); a
   rotated arrowhead reads cleaner.
4. Update the per-projectile-type params (bow vs. crossbow vs. thrown
   dagger) so darting weapons stay nearly-flat and longbows arc high.

**Tests.** Pure-math test that the peak Y is between start.y and the
control point's Y; that endpoints match attacker/defender anchors at
u=0 and u=1; that arrow rotation aligns with the tangent.

**Tricky bits.**
- `effectsForWeaponHit` (M27) emits the `projectile` effect descriptor
  for both the grid-overlay path and the cinema path. The signature
  needs to stay compatible — arc-height is an additive optional param.
- For `staff-cast` (which uses `projectile` for spell darts), arc the
  same way but with a different default height + color.

## M44.5 — Directional facing in the cinema

**Current behaviour.** Every actor renders south-facing (front of the
LPC sheet) regardless of cinema role. Attacker on the left, defender
on the right, defender x-mirrored so they appear to face the attacker
— but both are actually drawn from the same south row. Up close this
reads as "two people staring at the camera" rather than "two people
facing each other".

**Goal.** Attacker samples the east-facing row, defender samples the
west-facing row. Each gets the appropriate side-view sprite.

**Approach.**
1. `cinema-sprites.js` `preloadActorSprite` accepts a `direction`
   already; we currently hardcode `'south'`. Change the call site:
   - attacker → `direction: 'east'`
   - defender → `direction: 'west'`
2. Drop the x-mirror on the defender (`scale: actor === 'defender' ?
   -s : s` becomes `s`) — the west-row sprite is already facing left.
3. The walk-strip frame indices used for windup/strike/hurt still apply
   per row, but verify the visual reads sensibly on east/west:
   - east row frame 2 reads as "mid-step away from camera"
   - east row frame 6 reads as "mid-step toward camera"
   - If the strike pose looks wrong, sample a different column (the
     east row's "stride forward" frame may be a different index).
4. Cache key currently is `(id, scale, direction)` — already correct.

**Tests.** Update `M44: makeLpcDrawSprite — defender is mirrored on the
x-axis` to assert the OPPOSITE — defender no longer mirrored. Update
`preloadActorSprite` tests to confirm east/west directions are passed
to renderSprite.

**Tricky bits.**
- LPC walk sheets have 9 frames per row; east + west rows have the
  SAME frame counts but different visual content. Verify visually
  in dev that the windup/strike frames still convey the motion.
- The defender's name label currently un-mirrors via a second `save/
  restore` block; that workaround can be removed once the mirror is
  dropped.

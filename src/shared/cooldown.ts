/** True when `now` is still within `cooldownMs` of `lastAt`. `lastAt <= 0` means "no prior
 *  attempt", which is never treated as within cooldown regardless of `now`. */
export function isWithinCooldown(lastAt: number, now: number, cooldownMs: number): boolean {
  if (lastAt <= 0) return false;
  return now - lastAt < cooldownMs;
}

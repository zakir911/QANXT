/**
 * What order to probe one target's checks in.
 *
 * On an address that does not change state the order is irrelevant, and this returns the list
 * it was given. On an address that does, order is part of the result, and that is not an
 * implementation detail to be tidied away later — it is a fact about testing something by
 * changing it.
 *
 * Measured on permits-legacy. `request.safe-verb-state-change` establishes that a GET changed
 * state by reading a page before and after. It ran tenth of eleven checks against
 * /approve.asp?id=1, in the alphabetical order the surface happened to produce. Ahead of it,
 * `authz.missing` issued the address as the owner and got 200, `authz.vertical` issued it as
 * an inspector and a clerk and got 200 twice more, and three injection checks each issued it
 * again. Every one of those is a legitimate probe asking whether the server refuses. Every one
 * of them also approved the permit. By the tenth check the record had been approved five times
 * and the witness page could not move, so the check that existed to see the change reported
 * honestly that it had seen none — of a change its own suite had already spent.
 *
 * A clean prior state is a resource, and the first probe consumes it. So the check that needs
 * it goes first.
 *
 * Note what this does not claim to solve. Two checks that both need an untouched record cannot
 * both have one, and nothing here can change that; the set below holds one check, and a second
 * entry would be a design problem rather than a list to extend.
 */
const NEEDS_AN_UNTOUCHED_RECORD = new Set(['request.safe-verb-state-change']);

export function probeOrder(checks: readonly string[], changesState: boolean | undefined): string[] {
  if (!changesState) return [...checks];

  const first = checks.filter(c => NEEDS_AN_UNTOUCHED_RECORD.has(c));
  if (first.length === 0) return [...checks];

  // Stable: everything else keeps the order it arrived in, so the only thing this changes is
  // what comes first.
  return [...first, ...checks.filter(c => !NEEDS_AN_UNTOUCHED_RECORD.has(c))];
}

import type { SecurityTarget } from '@qa-nxt/shared-types';

/**
 * The address a check should actually issue, as against the one the surface groups by.
 *
 * `identifier` is a template, and discovery builds it by stripping the query. That is right
 * for grouping — /view.asp?id=1 and /view.asp?id=2 are one endpoint — and wrong for sending a
 * request to an application that identifies a record in the query string. Measured on
 * permits-legacy: four checks were pointed at /approve.asp with no id, the application
 * answered 404 to all of them, and each honestly reported that it could not tell whether the
 * route was reachable. Nothing was broken and nothing was tested.
 *
 * Resolved here rather than in each of the twenty-eight call sites below, because every one of
 * them would otherwise have to remember, and the one that forgot would report a clean
 * inconclusive against an address that does not exist.
 *
 * Narrow on purpose:
 *  - a template carrying a placeholder is left alone, because the check substitutes into it
 *    itself and knows what the placeholder means;
 *  - the sample is preferred only when it carries a query the template dropped, which is
 *    exactly the measured case and nothing wider.
 */
export function issuableAddress(target: SecurityTarget): string {
  if (/\{[^}]+\}/.test(target.identifier)) return target.identifier;
  if (!target.sampleUrl) return target.identifier;
  if (target.identifier.includes('?')) return target.identifier;
  return target.sampleUrl.includes('?') ? target.sampleUrl : target.identifier;
}

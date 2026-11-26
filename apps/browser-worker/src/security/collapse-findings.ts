import type { SecurityFinding } from '@qa-nxt/security-engine';

/**
 * One fact, reported once.
 *
 * A scan of a 137-screen application produced **173 findings and 17 distinct facts**. 135 of
 * them said `x-content-type-options is not set`, and 16 said one session cookie is missing
 * HttpOnly. Three privilege escalations and a real missing-token hole were somewhere in the
 * other twenty-two lines.
 *
 * That is not a cosmetic problem. A report where 87% of the rows are two sentences repeated
 * cannot be read, and the thing a reviewer is paid to find is the row they will never reach.
 * It also makes every count the product publishes meaningless: "173 findings" is not 173
 * problems, and nothing in the output said so.
 *
 * ## Three ways the same fact arrived more than once
 *
 * **The whole application.** A response header is set by one piece of middleware. Missing on
 * 135 pages is one fix, not 135. The check that found it says so by setting `subject` on the
 * finding — `header:x-content-type-options` — and findings sharing a subject collapse into
 * one however many addresses they were seen at.
 *
 * **Every instance of one route.** `/api/shipments/shp-0001`, `shp-0002` and `shp-0003` are
 * three samples of `/api/shipments/{id}`, and an endpoint that serves protected data without
 * a session does it for every id. One route, one fix.
 *
 * **The same address, spelled two ways.** `/auth/sign-in` and
 * `http://127.0.0.1:4400/auth/sign-in` reached the surface as separate items, so account
 * lockout was reported against both. That one is simply a duplicate.
 *
 * ## What is deliberately *not* collapsed
 *
 * A finding whose fix is per-endpoint stays per-endpoint. Three read-only writes on three
 * different routes are three problems and three fixes, and merging them would hide two. Only
 * a declared `subject`, or the same fact on the same route template, is treated as one.
 *
 * Nothing is thrown away: the survivor carries how many times it was seen and the addresses
 * it was seen at, so the evidence is still there for whoever wants it.
 */

/** A finding, plus how many times this same fact was seen and where. */
export interface CollapsedFinding extends SecurityFinding {
  /** How many findings this one stands for. 1 when it stands only for itself. */
  occurrences: number;
  /** The addresses it was seen at, in the order seen, capped so a report stays readable. */
  seenAt: string[];
  /** True when more addresses were seen than `seenAt` lists. */
  moreAddresses: boolean;
}

const EXAMPLES_KEPT = 8;

/**
 * A path with its record identifiers replaced, so instances of one route group together.
 *
 * Only segments that cannot be a route name: a number, something carrying digits behind a
 * prefix (`shp-0001`, `inv_12`), a UUID, or a long hex string. A segment of plain letters is
 * left alone, because `/orders/sales/new` and `/orders/sales/approve` are different routes and
 * merging them would hide one.
 */
export function routeTemplate(endpoint: string | null | undefined): string {
  if (!endpoint) return '';
  let path = String(endpoint);
  // The same address spelled absolutely and relatively is the same address.
  try { path = new URL(path).pathname; } catch { /* relative already */ }
  const withoutQuery = path.split('?')[0] ?? '';
  return withoutQuery
    .split('/')
    .map(segment => looksLikeAnIdentifier(segment) ? '{id}' : segment)
    .join('/');
}

function looksLikeAnIdentifier(segment: string): boolean {
  if (segment === '') return false;
  if (/^\d+$/.test(segment)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true;
  // A prefix and a number: shp-0001, inv_12, drv001. Not a word on its own.
  if (/^[A-Za-z]{1,12}[-_]?\d+$/.test(segment)) return true;
  // A placeholder a template already carries.
  if (/^[{:].*$/.test(segment)) return true;
  return false;
}

/** What makes two findings the same fact. */
function identityOf(finding: SecurityFinding): string {
  const subject = (finding as { subject?: string }).subject;
  if (subject !== undefined && subject !== null && String(subject).trim() !== '') {
    // Declared application-wide: the address is not part of what is wrong.
    return `${finding.category}\u0000${String(subject).trim()}`;
  }
  return [
    finding.category,
    finding.title,
    finding.httpMethod ?? '',
    finding.parameter ?? '',
    finding.observedAsRole ?? '',
    routeTemplate(finding.endpoint)
  ].join('\u0000');
}

/**
 * Collapses findings that say the same thing, keeping the first of each and recording the
 * rest as occurrences. Order is preserved, so the most severe-first ordering a caller
 * arranged is not disturbed.
 */
export function collapseFindings(findings: readonly SecurityFinding[]): CollapsedFinding[] {
  const byIdentity = new Map<string, CollapsedFinding>();

  for (const finding of findings) {
    const identity = identityOf(finding);
    const seen = byIdentity.get(identity);
    const address = finding.endpoint ?? '';

    if (seen === undefined) {
      byIdentity.set(identity, {
        ...finding,
        occurrences: 1,
        seenAt: address === '' ? [] : [address],
        moreAddresses: false
      });
      continue;
    }

    seen.occurrences += 1;
    if (address !== '' && !seen.seenAt.includes(address)) {
      if (seen.seenAt.length < EXAMPLES_KEPT) seen.seenAt.push(address);
      else seen.moreAddresses = true;
    }
  }

  return [...byIdentity.values()];
}

/**
 * A sentence for the report, where a fact was seen more than once.
 *
 * Written for the reader rather than the database: "and 134 other addresses" is what a person
 * needs, and the addresses themselves are on the finding for anyone who wants them.
 */
export function alsoSeenAt(finding: CollapsedFinding): string | null {
  if (finding.occurrences <= 1) return null;
  const others = finding.occurrences - 1;
  const listed = finding.seenAt.slice(1);
  const examples = listed.length === 0 ? '' : ` Also at ${listed.join(', ')}`;
  const rest = finding.moreAddresses || listed.length < others
    ? `${listed.length === 0 ? ' Also at' : ' and'} ${others - listed.length} other address(es)`
    : '';
  return `The same thing is true at ${others} other address(es) this scan reached.${examples}${rest}`
    .replace(/\s+/g, ' ')
    .trim();
}

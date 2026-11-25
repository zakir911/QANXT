/**
 * The record a check can treat as the owning identity's, taken from what discovery reached.
 *
 * ## Why this is needed
 *
 * `authz.bola` compares what an identity can read against what a stranger can read, so it
 * has to be pointed at a record the first identity owns. Without one it says so and stops,
 * which is the right answer and not a pass.
 *
 * Nothing ever supplied one. Every scan driver in this project declares identities as
 * label, username, password and role, because that is what signing in needs — so the check
 * that exists to find an IDOR reported "give the identity a resourceId it owns" on every
 * target of every run, and the planted IDOR sat there untested.
 *
 * ## Why the sample URL is a legitimate answer
 *
 * Discovery walks the application *signed in as an identity*. Every address it recorded is
 * an address that identity reached and was shown. So the concrete identifier in a sample
 * URL is, by construction, a record available to the identity the crawl ran as — which is
 * what the check needs. It is weaker than a record created for the test and declared, and it
 * is far better than nothing: the alternative is a check that never runs.
 *
 * It is derived, not assumed, and a declared resourceId always wins. A caller that knows
 * which record belongs to whom is a better authority than a crawl.
 */

/**
 * The identifier a template's placeholder stood for in one concrete address.
 *
 * Compares the two by path segment, which is what makes it safe: a template segment holding
 * a placeholder is matched against the sample's segment in the same position, and nothing
 * else is read. A sample that does not line up with the template segment for segment yields
 * nothing rather than a guess.
 *
 * @param template e.g. "/api/shipments/{id}" or "/shipments/:id"
 * @param sample   e.g. "http://host/api/shipments/shp-0008" or the path alone
 * @returns the identifier, or null when it cannot be read off cleanly
 */
export function identifierFromSample(template: string, sample: string | null | undefined): string | null {
  if (!template || !sample) return null;

  const placeholder = /^(\{[^}]*\}|:[^/]+)$/;
  if (!placeholder.test(template.split('/').find(s => placeholder.test(s)) ?? '')) return null;

  const pathOf = (value: string) => {
    try {
      return new URL(value).pathname;
    } catch {
      return value.split('?')[0] ?? value;
    }
  };

  const wanted = (template.split('?')[0] ?? '').split('/').filter(s => s.length > 0);
  const given = (pathOf(sample) ?? '').split('/').filter(s => s.length > 0);
  if (wanted.length !== given.length) return null;

  let found: string | null = null;
  for (let i = 0; i < wanted.length; i++) {
    const expected = wanted[i] ?? '';
    const actual = given[i] ?? '';
    if (placeholder.test(expected)) {
      // More than one placeholder and it is no longer clear which record is "the" record.
      if (found !== null) return null;
      found = actual;
      continue;
    }
    // A literal segment that does not match means this sample is not an instance of this
    // template, whatever else lines up.
    if (expected.toLowerCase() !== actual.toLowerCase()) return null;
  }

  if (found === null || found.length === 0) return null;
  // A placeholder that matched another placeholder establishes nothing.
  if (placeholder.test(found)) return null;
  return found;
}

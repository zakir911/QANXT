import type { SecurityTarget } from '@qa-nxt/shared-types';
import { routeTemplate } from './collapse-findings.js';

/**
 * Addresses a more privileged identity can see and the map cannot.
 *
 * ## The gap this closes
 *
 * Discovery maps an application as **one** identity. A security scan is given **several** —
 * it has to be, because every authorization check compares two. So the surface is whatever
 * the crawling identity could see, and every check runs against that, while the scan holds
 * credentials that would have shown it more.
 *
 * Measured on freight. Discovery signs in as `ops.lead`. The claim detail page renders its
 * settle control only for a role holding `claim:settle`:
 *
 *     ${settleable && maySettle ? `<button data-route="/claims/${id}/settle">Settle</button>` : ''}
 *
 * `ops.lead` holds no such permission, so the control is not in the markup and
 * `GET /claims/clm-0001/settle` answers **403** to that identity. There is no amount of
 * crawling as `ops.lead` that finds the address. The scan is nevertheless given
 * `administrator`, which sees both.
 *
 * Behind that address is FP_D11_VIEWER_CAN_SETTLE_CLAIM — proven by hand, one request: the
 * `readonly` account, on a page that tells it *"Settling a claim needs the claim:settle
 * permission, which your role does not hold"*, settled a £5,953.11 claim for £1.00.
 *
 * ## What this does, and what it deliberately does not
 *
 * It reads each page the surface already holds as the most privileged identity available, and
 * reports every destination that identity's page declares which is not on the surface. The
 * address, the identity that could see it, and the page it was declared on.
 *
 * It does **not** add them as targets. Which checks an address implies is decided where the
 * surface is built, from the whole picture — the forms, the observed traffic, the route shape
 * — and guessing that here would be a second, worse copy of that rule. Making the product
 * *test* these addresses means letting discovery map as more than one identity, which is a
 * change to what an application record holds rather than something to infer in a worker.
 *
 * So this turns a silent miss into a named gap with the address in it, which is the standard
 * the rest of the scan already holds itself to: the reason a check did not conclude is the
 * most useful line in a report.
 */

/** The routing attributes the page extractor reads, so the two cannot disagree. */
const ROUTE_ATTRIBUTES = [
  'data-route', 'data-href', 'data-url', 'data-link', 'data-to', 'data-path',
  'data-navigate', 'data-target-url', 'routerlink', 'ng-href'
];

/** A destination the page declares, with the control that declares it. */
export interface DeclaredControl {
  address: string;
  /** The accessible-ish name of the control, where the markup carries one. */
  name: string | null;
}

/**
 * Destinations a page declares on its controls, read from the markup.
 *
 * Deliberately not a parser: this runs against a page already fetched, and the question is
 * only which addresses the markup names. Scripts and styles are stripped first, so a route in
 * a JavaScript string table is not mistaken for a control the page renders.
 */
export function declaredControlsIn(html: string | null | undefined): DeclaredControl[] {
  if (typeof html !== 'string' || html === '') return [];
  const page = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const found = new Map<string, DeclaredControl>();

  for (const attribute of ROUTE_ATTRIBUTES) {
    const pattern = new RegExp(`<([a-z][\\w-]*)([^>]*\\b${attribute}=["']([^"']+)["'][^>]*)>([^<]{0,80})`, 'gi');
    let match;
    while ((match = pattern.exec(page)) !== null) {
      const tag = (match[1] ?? '').toLowerCase();
      // An anchor carries its destination in href and is already followed.
      if (tag === 'a') continue;
      const address = (match[3] ?? '').trim();
      if (!address.startsWith('/')) continue;
      const name = (match[4] ?? '').replace(/\s+/g, ' ').trim();
      if (!found.has(address)) found.set(address, { address, name: name === '' ? null : name });
    }
  }

  // A form's action is the same kind of declaration and is just as likely to be role-gated.
  const forms = /<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/gi;
  let form;
  while ((form = forms.exec(page)) !== null) {
    const address = (form[1] ?? '').trim();
    if (!address.startsWith('/')) continue;
    if (!found.has(address)) found.set(address, { address, name: null });
  }

  return [...found.values()];
}

/** One address a privileged identity could see and the surface does not hold. */
export interface UnseenControl {
  address: string;
  declaredOn: string;
  name: string | null;
}

/**
 * Compares what a page declares against what the surface holds, by route shape, so a record
 * identifier does not make a known route look new.
 */
export function controlsTheSurfaceDoesNotHold(
  declaredOn: string,
  declared: readonly DeclaredControl[],
  targets: readonly SecurityTarget[]
): UnseenControl[] {
  const known = new Set<string>();
  for (const target of targets) {
    known.add(routeTemplate(target.identifier));
    if (target.sampleUrl) known.add(routeTemplate(target.sampleUrl));
  }

  const unseen = new Map<string, UnseenControl>();
  for (const control of declared) {
    const shape = routeTemplate(control.address);
    if (shape === '' || known.has(shape)) continue;
    if (unseen.has(shape)) continue;
    unseen.set(shape, { address: control.address, declaredOn, name: control.name });
  }
  return [...unseen.values()];
}

/** The sentence the scan reports, naming the address, the control and the identity. */
export function unseenControlGap(control: UnseenControl, identityLabel: string): string {
  const named = control.name === null ? '' : ` ("${control.name}")`;
  return `surface on ${control.address}: Not covered: the map was built as a different identity, `
    + `and ${identityLabel} can see a control${named} on ${control.declaredOn} that points here. `
    + 'Nothing probed this address, because it was not on the surface to probe. Discovery maps '
    + 'an application as one identity; this scan holds more than one, and the two do not see '
    + 'the same application.';
}

/**
 * Deciding which controls a crawl may press.
 *
 * Discovery used to follow `a[href]` and nothing else. On an application whose navigation
 * is buttons calling a client-side router that finds the landing page and stops, because
 * there is no href anywhere to follow. Reaching the rest means clicking things.
 *
 * Clicking things on somebody else's running application is not a small step. The crawler
 * cannot know what a button does before it presses it, and "Delete", "Send", "Pay" and
 * "Save" are all one click away from the nav items it is actually looking for. So the rule
 * here is not "avoid obvious disasters", it is the opposite default: a control is clicked
 * only if it reads as navigation or as plainly inert, and anything that reads like it
 * changes data is left alone unless somebody explicitly turned that on for the application.
 *
 * Being wrong in the cautious direction costs a missed page. Being wrong in the other
 * direction costs somebody's data, and there is no undo.
 */

export type InteractionMode = 'links' | 'navigation' | 'interactive';

/** What the page reports about one candidate control, gathered in the browser. */
export interface ClickCandidate {
  /** Index into the page's candidate list, used to re-find it after a navigation. */
  index: number;
  tagName: string;
  role: string;
  accessibleName: string;
  /** `type` for a button or input. */
  type: string;
  href: string;
  /** True when the element is inside a <form>. */
  inForm: boolean;
  /** True when the element is inside a <nav> or role="navigation". */
  inNav: boolean;
  disabled: boolean;
  /** A selector that finds this element again on the same page. */
  selector: string;
}

export interface ClickDecision {
  click: boolean;
  /** Why, for the exploration log. A skipped control is worth explaining. */
  reason: string;
}

/**
 * Labels that mean the control changes something. Matched as whole words against the
 * accessible name, so "Save" is caught and "Saved searches" is not treated as a verb by
 * accident — the word boundary matters more than it looks, because nav items like
 * "Payments" would otherwise be skipped for containing "pay".
 */
const MUTATING_WORDS = [
  'delete', 'remove', 'destroy', 'drop', 'erase', 'purge', 'clear',
  'submit', 'save', 'apply', 'confirm', 'approve', 'reject', 'decline',
  'send', 'email', 'invite', 'publish', 'deploy', 'release',
  'pay', 'purchase', 'buy', 'checkout', 'refund', 'charge', 'transfer', 'withdraw',
  'create', 'add', 'new', 'update', 'edit', 'rename', 'move', 'archive',
  'cancel', 'revoke', 'disable', 'enable', 'reset', 'restore',
  'upload', 'import', 'export', 'download',
  'sign out', 'signout', 'log out', 'logout', 'unsubscribe'
];

/** Roles that exist to move you somewhere. */
const NAVIGATION_ROLES = new Set(['link', 'menuitem', 'menuitemradio', 'tab', 'treeitem']);

const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();

/** True when the accessible name contains a mutating verb as a whole word. */
export function looksMutating(accessibleName: string): boolean {
  const name = normalise(accessibleName);
  if (name.length === 0) return false;

  return MUTATING_WORDS.some(word => {
    // Escaped because a couple of the entries contain a space, and none contain regex
    // metacharacters today — but a future entry might, and silently matching nothing is
    // the worst way for this list to fail.
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(name);
  });
}

/**
 * Whether following this link would change the application.
 *
 * `decide` hands an anchor with a destination straight to link following —
 * "it is an ordinary link and is already followed" — and link following applied no
 * mutation test at all. On an application built the modern way that is harmless, because
 * anything that writes is a form or a button and `decide` catches it. On an application
 * built the old way it is not: a crawl of a permit register, mapping pages and following
 * links, approved all three permits in it by way of
 * `<a href="/approve.asp?id=1">Approve</a>`.
 *
 * So the same words are tested here, against the link's own text and against its path.
 * The path matters as much as the text: an icon-only link has no accessible name, and a
 * legacy application names its intent in the URL more reliably than in the markup.
 *
 * The query string is deliberately not searched. A real one carries values — a search
 * term, a filter, a redirect target — and `?view=deleted` or `?q=cancelled+orders` is a
 * page to read, not an action to take.
 *
 * @param accessibleName the link's text or accessible name, which may be empty
 * @param url the link's resolved absolute URL
 */
export function linkLooksMutating(accessibleName: string, url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0] ?? url;
  }
  // A path is one word to a reader and several to a matcher: /permits/approve-all, the
  // ASP /approve.asp and the REST /api/v1/permits/1/approve all have to read the same.
  const words = `${accessibleName} ${path.replace(/[^a-z0-9]+/gi, ' ')}`;
  return looksMutating(words) && !onlyOpensAForm(words);
}

/**
 * Words that on a LINK name the record you are about to make or change, not a change
 * being made. The change happens when the form they open is submitted, and that submit
 * control is a button, which `decide` already refuses.
 *
 * Applying the full list to links cost real coverage the moment it landed: a permit
 * register's "New application" link was not followed, the application form behind it was
 * never discovered, and the suite for that target fell from two forms to one. A guard that
 * stops the crawl reaching half the application is not a safe guard, it is a broken one.
 *
 * Only these four are forgiven, and only when nothing else on the link is mutating, so
 * "Create" is followed and "Delete and create a replacement" is not.
 */
const OPENS_A_FORM = ['new', 'add', 'create', 'edit'];

function onlyOpensAForm(words: string): boolean {
  const remaining = MUTATING_WORDS.filter(word => !OPENS_A_FORM.includes(word));
  return !looksMutating(stripExcept(words, remaining));
}

/** The words of `text` that appear in `allowed`, so looksMutating can be asked about those alone. */
function stripExcept(text: string, allowed: readonly string[]): string {
  const name = normalise(text);
  return allowed.filter(word => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`, 'i').test(name);
  }).join(' ');
}

/**
 * Whether this control may be clicked under the given mode.
 *
 * `allowStateChanging` is the only thing that permits a control that looks like it writes,
 * and it is off unless somebody set it on the application. Nothing here infers it.
 */
export function decide(
  candidate: ClickCandidate,
  mode: InteractionMode,
  allowStateChanging: boolean
): ClickDecision {
  // Anything that is not one of the three known modes is treated as the safest one. A mode
  // this worker does not recognise is most likely an older control plane, a hand-edited
  // row, or a column default that was never backfilled — and in every one of those cases
  // the right reading of "I do not know what you meant" is "do not click anything".
  if (mode !== 'navigation' && mode !== 'interactive') {
    return { click: false, reason: 'the crawl is following links only' };
  }

  if (candidate.disabled) {
    return { click: false, reason: 'the control is disabled' };
  }

  // An anchor with a real destination is already handled by link following, and clicking
  // it would only duplicate the work.
  if (candidate.tagName === 'a' && candidate.href.length > 0) {
    return { click: false, reason: 'it is an ordinary link and is already followed' };
  }

  const role = normalise(candidate.role);
  const name = normalise(candidate.accessibleName);
  const navigationShaped = candidate.inNav || NAVIGATION_ROLES.has(role);

  // A submit button submits. There is no reading of that which is safe to guess at.
  if (candidate.type === 'submit' || candidate.type === 'reset') {
    return allowStateChanging
      ? { click: true, reason: 'state-changing clicks are permitted for this application' }
      : { click: false, reason: `it is a form ${candidate.type} control` };
  }

  // Inside a form, a control with no name is as likely to be the submit as anything else.
  // Navigation genuinely does live inside forms sometimes, so a nav-shaped control is
  // still allowed through.
  if (candidate.inForm && !navigationShaped && !allowStateChanging) {
    return { click: false, reason: 'it is inside a form' };
  }

  if (looksMutating(name) && !allowStateChanging) {
    return { click: false, reason: `its label "${candidate.accessibleName}" reads like it changes data` };
  }

  if (mode === 'navigation' && !navigationShaped) {
    return { click: false, reason: 'it is not navigation and the crawl is in navigation mode' };
  }

  if (name.length === 0 && !navigationShaped) {
    // Nothing to judge it by. In interactive mode that is not enough to go on.
    return { click: false, reason: 'it has no accessible name to judge it by' };
  }

  return { click: true, reason: navigationShaped ? 'it is navigation' : 'it is an inert control' };
}

/**
 * Deciding what a failing test actually tells you.
 *
 * ## Why this is its own module
 *
 * The first version of this logic lived inline in run-pipeline.mjs and reported that the
 * platform had found FP_D18, the search crash. It had not. FP_D18's keyword list contained
 * `500`, and the failure text was `locator.selectOption: Timeout 15000ms exceeded` — the
 * substring `500` sits inside `15000`. A naive `includes` turned a Playwright timeout into
 * a detected application defect.
 *
 * That is the exact failure mode this whole exercise exists to avoid, so the matching is
 * now explicit, bounded, and tested against the thing that fooled it.
 *
 * ## The distinction that matters
 *
 * A run reported "28 failed". None of the 28 was the application misbehaving. Every one
 * was the test tool unable to drive the page:
 *
 *   locator.fill: Error: Malformed value                   → filling a date input with text
 *   locator.fill: Cannot type text into input[type=number] → typing letters into a number input
 *   locator.selectOption: Timeout                          → a select the runner cannot drive
 *   locator.fill: Timeout                                  → a readonly field
 *
 * These are generated tests that cannot run, by construction. They report as failures,
 * indistinguishable in the summary from a real defect, so a team sees "28 failed" and goes
 * hunting for 28 bugs that do not exist while the real ones sit untouched.
 *
 * So a failure is classified before it is matched, and only an application failure can
 * count as detecting anything.
 */

/**
 * Playwright and runner errors. These say the test could not be performed; they say
 * nothing about whether the application is correct.
 */
const TOOL_ERROR_PATTERNS = [
  { pattern: /locator\.fill:\s*Error:\s*Malformed value/i,
    kind: 'unrunnable-date', explain: 'filling a date input with text the browser refuses' },
  { pattern: /Input of type "file" cannot be filled/i,
    kind: 'unrunnable-upload', explain: 'typing into a file input, which Playwright refuses' },
  { pattern: /Cannot type text into input\[type=number\]/i,
    kind: 'unrunnable-number', explain: 'typing letters into a number input the browser refuses' },
  { pattern: /locator\.selectOption:.*Timeout/i,
    kind: 'undrivable-select', explain: 'a select the runner could not drive' },
  { pattern: /locator\.fill:.*Timeout/i,
    kind: 'unfillable-field', explain: 'a field that never accepted input (often readonly)' },
  { pattern: /locator\.click:.*Timeout/i,
    kind: 'unclickable-control', explain: 'a control that never became clickable' },
  { pattern: /Executable doesn't exist|browserType\.launch/i,
    kind: 'browser-missing', explain: 'the browser could not start' },
  { pattern: /No worker picked this test up/i,
    kind: 'not-executed', explain: 'no worker claimed the job' },
  { pattern: /net::ERR_|ECONNREFUSED/i,
    kind: 'target-unreachable', explain: 'the application could not be reached' }
];

/**
 * Classifies one execution failure.
 *
 * Anything matching a tool pattern is a tool error. Everything else is treated as the
 * application failing, which is the cautious direction: a genuine defect misfiled as a
 * tool error would inflate the platform's score, and that is the error worth avoiding.
 */
/**
 * Tests whose result means nothing either way, because the test could not distinguish a
 * pass from a failure on the page it was pointed at.
 *
 * The required-field scenario is the case that forced this third category. It opened a form,
 * submitted it, and asserted the user stayed put because the field was not supplied. On a
 * form for creating something that works: the field arrives empty. On a form for editing
 * something the field arrives holding the current value, the submit is accepted exactly as
 * it should be, and the test reports a validation defect that is not there. 42 of 79
 * failures in the measured run were this shape.
 *
 * It is neither a tool error — the browser did everything it was asked — nor an application
 * failure, and calling it either one is wrong in a direction that matters. Counting it as an
 * application failure credits the platform with finding something. Counting it as a tool
 * error implies the browser refused. It gets its own name.
 *
 * This cannot be decided from the message alone: "Expected the URL to contain X" is the same
 * message a legitimate stays-on-its-route check produces. The test NAME is what separates
 * them, so the name is matched too, and where the name is missing the failure stays
 * unclassified rather than being guessed at.
 */
const UNRELIABLE_TEST_PATTERNS = [
  { namePattern: /\bis required on\b/i,
    messagePattern: /^Expected the URL to contain/i,
    kind: 'required-field-on-a-prepopulated-form',
    explain: 'the test never emptied the field, so the form was right to accept the submit' },

  // The boundary scenario's own objective says the field should "either accept the value
  // cleanly or refuse it with a message", and its assertion then requires the URL to stay on
  // the form. Those are incompatible: a form that accepts the value cleanly redirects to the
  // record it just saved, which is the success path the objective allows. The assertion is
  // reaching for "did not land on an error page" and lands on "did not navigate at all".
  { namePattern: /\bhandles\b.*\bon\b/i,
    messagePattern: /^Expected the URL to contain/i,
    kind: 'boundary-value-the-application-may-accept',
    explain: 'the assertion requires the form not to navigate, while its own objective '
           + 'allows the value to be accepted, which navigates' },

  // A whitespace rule used to sit here, discounting "does not accept whitespace alone"
  // failures on the grounds that a field which trims three spaces to empty and saves is
  // behaving correctly. That was true while the generator emitted the test for optional
  // fields as well. It is no longer: the scenario is now produced only where the field is
  // required, and a required field that accepts three spaces as a town name has a real
  // defect whichever way it behaves — it either stores whitespace as content, or trims to
  // empty and saves a required field with nothing in it.
  //
  // Leaving the rule in place discounted 9 of 14 genuine findings in a measured run and
  // reported 0 of 32 defects detected where the figure was 1. An error that understates
  // what the platform found is as wrong as one that overstates it, and this one was mine:
  // the generator was fixed and the thing that reads its output was not.
];

export function classifyFailure(message, name) {
  const text = String(message ?? '');
  const title = String(name ?? '');

  for (const entry of TOOL_ERROR_PATTERNS) {
    if (entry.pattern.test(text)) {
      return { kind: 'toolError', subkind: entry.kind, explain: entry.explain };
    }
  }
  for (const entry of UNRELIABLE_TEST_PATTERNS) {
    if (entry.namePattern.test(title) && entry.messagePattern.test(text)) {
      return { kind: 'unreliableTest', subkind: entry.kind, explain: entry.explain };
    }
  }
  if (text.trim().length === 0) {
    return { kind: 'unknown', subkind: 'no-message', explain: 'the failure carried no message' };
  }
  return { kind: 'applicationFailure', subkind: 'assertion', explain: 'the application did not behave as asserted' };
}

/**
 * Whole-token matching.
 *
 * `includes('500')` matched `15000ms`. A token only counts when it is not wedged inside a
 * longer run of the same character class, which is what a word boundary gives for `500`
 * and what a space-or-edge check gives for a phrase like `internal server`.
 */
function mentions(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b works for tokens starting and ending in a word character; for anything else fall
  // back to requiring a non-word neighbour, which is the same idea spelled out.
  const left = /^\w/.test(token) ? '\\b' : '(?<![\\w-])';
  const right = /\w$/.test(token) ? '\\b' : '(?![\\w-])';
  return new RegExp(`${left}${escaped}${right}`, 'i').test(text);
}

/**
 * How specifically a defect's keywords match a signal.
 *
 * Two numbers, because neither alone separates a real match from a coincidence: how many
 * distinct keywords matched, and how much text those keywords account for. "delivery date"
 * matching is worth more than "step" matching, and both matching is worth more than either.
 */
function specificity(keywords, text, onScreen) {
  const hits = keywords.filter(word => mentions(text, word));
  return {
    onScreen,
    matched: hits.length,
    weight: hits.reduce((total, word) => total + word.length, 0)
  };
}

/**
 * Whether one match is more specific than another.
 *
 * Naming the screen comes first and is not tradeable against keyword count. Two generic
 * keywords matching a failure on some other page is weaker evidence than one keyword
 * matching a failure on the defect's own page, however the counts fall — the colour-only
 * finding on /fleet/vehicles is FP_D23's, not FP_D21's, which is about a field on a stock
 * adjustment screen and merely shares accessibility vocabulary.
 */
function beats(candidate, incumbent) {
  if (candidate.onScreen !== incumbent.onScreen) return candidate.onScreen;
  if (candidate.matched !== incumbent.matched) return candidate.matched > incumbent.matched;
  return candidate.weight > incumbent.weight;
}

/** The most specific of a defect's own candidates. */
function best(candidates) {
  return candidates.reduce(
    (winner, candidate) =>
      winner === undefined || beats(candidate.specificity, winner.specificity) ? candidate : winner,
    undefined);
}

/**
 * Keywords per defect. Two or more must appear for a signal that does not already name the
 * screen, so a single common word cannot carry a claim on its own.
 */
export const DEFECT_KEYWORDS = {
  FP_D01_NEGATIVE_STOCK_ADJUSTMENT: ['negative', 'below zero', 'on hand'],
  FP_D02_DELIVERY_BEFORE_COLLECTION: ['delivery date', 'collection date', 'before'],
  FP_D03_WEIGHT_UNIT_IGNORED: ['weight', 'unit', 'pounds', 'kilograms'],
  FP_D04_DUPLICATE_INVOICE_REFERENCE: ['duplicate', 'unique', 'already exists'],
  FP_D05_CREDIT_LIMIT_BYPASSED: ['credit', 'hold', 'limit'],
  FP_D06_SURCHARGE_ON_GROSS: ['surcharge', 'fuel', 'gross', 'net'],
  FP_D07_RATE_BAND_BOUNDARY: ['band', 'boundary', 'rate per kg'],
  FP_D08_DUTY_EXCLUDES_FREIGHT: ['duty', 'freight', 'value for duty'],
  FP_D09_CREDIT_NOTE_EXCEEDS_INVOICE: ['credit note', 'exceed', 'invoice total'],
  FP_D10_PAGINATION_COUNT_WRONG: ['count', 'pagination', 'filtered'],
  FP_D11_VIEWER_CAN_SETTLE_CLAIM: ['permission', 'authorization', 'settle', 'forbidden'],
  FP_D12_SHIPMENT_IDOR: ['idor', 'authorization', 'object reference', 'access control'],
  FP_D13_LEGACY_API_KEY_FULL_SCOPE: ['api key', 'scope', 'expiry'],
  FP_D14_CANCEL_ORPHANS_ROUTE_STOP: ['route', 'stop', 'cancelled', 'orphan'],
  FP_D15_WIZARD_BACK_LOSES_DATA: ['step', 'back', 'cleared', 'wizard'],
  FP_D16_DOUBLE_SUBMIT_BOOKS_TWICE: ['duplicate', 'twice', 'idempotency'],
  FP_D17_RELEASE_REJECTED_DECLARATION: ['rejected', 'release', 'status'],
  FP_D18_LONG_SEARCH_CRASHES: ['internal server error', 'stack trace', 'http 500'],
  FP_D19_OVERSIZE_UPLOAD_CRASHES: ['upload', 'file size', 'internal server error'],
  FP_D20_MISSING_REFERENCE_CRASHES: ['internal server error', 'undefined', 'reference'],
  FP_D21_UNLABELLED_ADJUSTMENT_FIELD: ['label', 'accessible name', 'aria-label'],
  FP_D22_ERROR_NOT_ASSOCIATED: ['aria-describedby', 'associated', 'error message'],
  FP_D23_STATUS_BY_COLOUR_ONLY: ['colour', 'color', 'contrast', 'text alternative'],
  FP_D24_MODAL_NOT_ANNOUNCED: ['aria-modal', 'dialog', 'focus'],
  // Written against the oracle's actual message — "the page can be scrolled sideways by
  // 42px in a 1280px-wide window; the element reaching furthest is div, whose right edge
  // is at 1322px" — rather than against the words a reader of the defect would reach for.
  // The previous list ('overflow', 'horizontal scroll', 'viewport') appears nowhere in it,
  // so both defects read as missed while both were being found on every run.
  FP_D25_RATE_TABLE_OVERFLOWS: ['scrolled sideways', 'right edge', 'reaching furthest', 'overflow'],
  FP_D26_PLANNER_FIXED_WIDTH: ['scrolled sideways', 'right edge', 'reaching furthest', 'overflow'],
  FP_D27_AUDIT_LOG_SLOW: ['slow', 'response time', 'performance budget'],
  FP_D28_REFLECTED_XSS_IN_SEARCH: ['xss', 'script tag', 'reflected', 'injection'],
  FP_D29_NO_CSRF_ON_ADJUSTMENT: ['csrf', 'forgery', 'anti-forgery'],
  FP_D30_SESSION_COOKIE_FLAGS: ['httponly', 'secure flag', 'cookie'],
  FP_D31_STACK_TRACE_LEAKED: ['stack trace', 'disclosure', 'information leak'],
  FP_D32_PII_IN_QUERY_STRING: ['query string', 'personal data', 'email address']
};

const patternMatches = (pattern, path) => {
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${source}$`).test(path);
};

/**
 * Whether a signal's text places it on a defect's screen.
 *
 * Ground truth writes screens as route templates — `/billing/invoices/:id` — and a failure
 * names the instance it happened on, `/billing/invoices/inv-0004`. A literal substring test
 * can therefore never place a failure on a parameterised screen, so no defect on one could
 * ever be scored "found" however precisely an oracle named it.
 *
 * That is not a theoretical gap. The percentage oracle reported, on three separate
 * invoices, that the fuel surcharge was 11.5% of a total printed below it. The analyser
 * could not join any of them to FP_D06 and instead matched a keyword against an unrelated
 * failure on the surcharge *form*, scoring the defect "possible" on evidence that had
 * nothing to do with it. The finding was right and the measurement could not see it.
 *
 * So the paths in the text are extracted and tested against the template.
 */
/**
 * Which way a signal says the application was wrong.
 *
 * Being on the right screen with the right vocabulary is not enough to be the same defect.
 * Every test of the credit-note form failed with "expected the submission to be accepted,
 * but the form is still shown" — the form refuses everything, so it cannot be filled at
 * all. FP_D09 is the opposite complaint: a credit note *above* the invoice total is
 * accepted. Matching them credited a defect nobody had tested, on evidence that said the
 * application was too strict, to a defect about it being too lax.
 *
 * So each signal is read for its direction, each defect for the direction its own recorded
 * observation describes, and a contradiction rules the pair out. Only a contradiction: a
 * signal or a defect whose direction cannot be read is never excluded on a guess.
 */
function directionOfSignal(text) {
  if (/expected the submission to be refused, but it was accepted/i.test(text)
    || /accepted the submission/i.test(text)
    || /enforced in the browser and not on the server/i.test(text)
    || /enforced in the page and nowhere else/i.test(text)) return 'tooPermissive';

  if (/expected the submission to be accepted, but/i.test(text)
    || /expected this field to be (valid|accepted)/i.test(text)) return 'tooStrict';

  return 'either';
}

/** The direction a planted defect's own observation describes. */
function directionOfDefect(defect) {
  const observable = `${defect.observable ?? ''} ${defect.detail ?? ''}`;
  if (/\bit (saves|is created|is accepted|succeeds)\b/i.test(observable)
    || /\bis (created|accepted|settled|released|applied)\b/i.test(observable)
    || /\baccepts\b/i.test(observable)) return 'tooPermissive';

  if (/\bis (refused|rejected|blocked)\b/i.test(observable)
    && !/\bnot (refused|rejected)\b/i.test(observable)) return 'tooStrict';

  return 'either';
}

/** True when a signal's direction contradicts the defect's. */
function contradicts(signal, defect) {
  const a = directionOfSignal(signal.text);
  const b = directionOfDefect(defect);
  if (a === 'either' || b === 'either') return false;
  return a !== b;
}

/**
 * Whether a signal belongs to a defect's screen.
 *
 * The route, when the signal carries one, is the fact; the text is the fallback for signals
 * that have no route recorded — a page-level failure that names its path in prose, or a
 * security finding reported against a URL.
 */
function onScreen(signal, screen) {
  if (signal.route !== undefined) {
    const path = signal.route.split('?')[0];
    if (path === screen) return true;
    if (patternMatches(screen, path) && !fillsParameterWithAnAction(screen, path)) return true;
    // A route that is a known instance of some other screen must not then be matched by
    // text: that is how a failure on one screen was credited to a defect on another.
    return false;
  }
  return textIsOnScreen(signal.text, screen);
}

function textIsOnScreen(text, screen) {
  if (text.includes(screen)) return true;
  if (!screen.includes(':')) return false;

  // Every path-looking run in the text, with any query or fragment trimmed off.
  for (const found of text.matchAll(/\/[A-Za-z0-9._~\-/]*/g)) {
    const path = found[0].replace(/[).,;'"]+$/, '');
    if (patternMatches(screen, path) && !fillsParameterWithAnAction(screen, path)) return true;
  }
  return false;
}

/** Segments that are an action, never an identifier, however a template is written. */
const ACTION_SEGMENT = /^(new|create|add|edit|update|delete|remove|search|export|import)$/i;

/**
 * Whether a path only matches a template because a parameter swallowed an action segment.
 *
 * `/billing/invoices/:id` matches `/billing/invoices/new` as a string pattern, and they are
 * different pages: one shows an invoice, the other is the form that makes one. Allowing it
 * put a failure from the create form under a defect planted on the detail page — the right
 * screen by the regex and the wrong screen by every other measure.
 */
function fillsParameterWithAnAction(pattern, path) {
  const templateParts = pattern.split('/');
  const pathParts = path.split('/');
  if (templateParts.length !== pathParts.length) return false;

  return templateParts.some((part, index) =>
    part.startsWith(':') && ACTION_SEGMENT.test(pathParts[index] ?? ''));
}

/**
 * Joins failures and security findings back to the planted defects.
 *
 * @param {object[]} defects      ground truth
 * @param {object[]} failures     execution failures, each { name, message }
 * @param {object[]} findings     security findings, each { title, evidence, url }
 * @param {string[]} reachedPaths paths discovery actually mapped
 */
export function detect({ defects, failures = [], findings = [], reachedPaths = [] }) {
  const classified = failures.map(failure => ({
    ...failure,
    classification: classifyFailure(failure.message, failure.name)
  }));

  const applicationFailures = classified.filter(f => f.classification.kind === 'applicationFailure');
  const toolErrors = classified.filter(f => f.classification.kind === 'toolError');
  const unreliableTests = classified.filter(f => f.classification.kind === 'unreliableTest');

  const unreliableBreakdown = {};
  for (const failure of unreliableTests) {
    unreliableBreakdown[failure.classification.subkind] ??=
      { count: 0, explain: failure.classification.explain, examples: [] };
    unreliableBreakdown[failure.classification.subkind].count += 1;
    if (unreliableBreakdown[failure.classification.subkind].examples.length < 2) {
      unreliableBreakdown[failure.classification.subkind].examples.push(failure.name ?? '(unnamed)');
    }
  }

  const toolErrorBreakdown = {};
  for (const failure of toolErrors) {
    toolErrorBreakdown[failure.classification.subkind] ??=
      { count: 0, explain: failure.classification.explain, examples: [] };
    toolErrorBreakdown[failure.classification.subkind].count += 1;
    if (toolErrorBreakdown[failure.classification.subkind].examples.length < 2) {
      toolErrorBreakdown[failure.classification.subkind].examples.push(failure.name ?? '(unnamed)');
    }
  }

  // Only an application failure or a security finding can evidence a defect. A tool error
  // evidences nothing about the application, whatever words happen to be in its message.
  // A signal carries its route as a fact where one is known, and its text either way.
  //
  // A form test is named after its form, not its screen, so the screen a failure happened
  // on is simply absent from its words. Placing failures by searching the prose therefore
  // could not see any finding on a form at all: FP_D29 was detected by the test
  // "Adjust MF-1333: carries an anti-forgery token" and scored "possible" on unrelated
  // evidence, because the route that would have joined them was never carried.
  const signals = [
    ...applicationFailures.map(f => ({
      kind: 'execution',
      text: `${f.name ?? ''} ${f.message ?? ''}`,
      route: typeof f.route === 'string' && f.route !== '' ? f.route : undefined
    })),
    ...findings.map(f => ({
      kind: 'security',
      text: `${f.title ?? ''} ${f.evidence ?? ''} ${f.url ?? ''}`,
      route: typeof f.endpoint === 'string' && f.endpoint !== '' ? f.endpoint : undefined
    }))
  ];

  const claims = defects.map(defect => {
    const screen = defect.screen.split('?')[0];
    const keywords = DEFECT_KEYWORDS[defect.id] ?? [];
    const screenReached = reachedPaths.some(path => path === screen || patternMatches(screen, path));

    const namesScreen = signals.filter(signal =>
      onScreen(signal, screen) && !contradicts(signal, defect));
    const onScreenAndSymptom = namesScreen
      .map(signal => ({ signal, specificity: specificity(keywords, signal.text, true) }))
      .filter(candidate => candidate.specificity.matched > 0);
    // Away from the screen, two independent keywords are required.
    const symptomOnly = signals
      .filter(signal => !namesScreen.includes(signal) && !contradicts(signal, defect))
      .map(signal => ({ signal, specificity: specificity(keywords, signal.text, false) }))
      .filter(candidate => candidate.specificity.matched >= 2);

    return { defect, screen, keywords, screenReached, onScreenAndSymptom, symptomOnly };
  });

  // One failure line is evidence of one defect.
  //
  // Without this, a single failure is credited to every planted defect whose screen it
  // names and one of whose keywords it happens to contain. On run accddf2b that counted
  // "Book a shipment: refuses Requested delivery date before Collection date" as finding
  // both FP_D02, which it is, and FP_D15 "going back from step 3 empties step 2", which it
  // is not: the word "step" appeared in the test's name. The same colour-only finding was
  // credited to both FP_D23 and FP_D21. Reported detection was 3 of 32 when the evidence
  // supported 2 — a measurement that flatters the thing it measures, which is worse than
  // no measurement.
  //
  // So each signal is awarded to the defect whose keywords it matches most specifically,
  // and the others must find their own evidence or go unfound.
  const owner = new Map();
  for (const claim of claims) {
    for (const candidate of [...claim.onScreenAndSymptom, ...claim.symptomOnly]) {
      const best = owner.get(candidate.signal);
      if (best === undefined || beats(candidate.specificity, best.specificity)) {
        owner.set(candidate.signal, { id: claim.defect.id, specificity: candidate.specificity });
      }
    }
  }

  // Keyword lists that match nothing anywhere.
  //
  // FP_D25 and FP_D26 were both detected — the rate card is a 980px table at a 390px
  // viewport and the planner is the 1100px div the defect describes — and both scored
  // "missed" because their keywords were 'overflow', 'horizontal scroll' and 'viewport'
  // while the oracle says "the page can be scrolled sideways by 42px in a 1280px-wide
  // window". Three words, none of them in the message, written against wording nobody
  // checked. A list that matches nothing now says so instead of looking like an absence
  // of findings.
  const deadKeywords = claims
    .filter(claim => claim.keywords.length > 0
      && !signals.some(signal => claim.keywords.some(word => mentions(signal.text, word))))
    .map(claim => ({ id: claim.defect.id, keywords: claim.keywords }));

  const verdicts = claims.map(claim => {
    const mine = (candidates) =>
      candidates.filter(candidate => owner.get(candidate.signal)?.id === claim.defect.id);

    const onScreenAndSymptom = mine(claim.onScreenAndSymptom);
    const symptomOnly = mine(claim.symptomOnly);

    // Evidence that exists but belongs to a better match. Recorded rather than dropped:
    // "another defect explains this line" is a different state from "nothing matched".
    const contested = claim.onScreenAndSymptom.length + claim.symptomOnly.length
      - onScreenAndSymptom.length - symptomOnly.length;

    let verdict;
    if (onScreenAndSymptom.length) verdict = 'found';
    else if (symptomOnly.length) verdict = 'possible';
    else if (!claim.screenReached) verdict = 'unreachable';
    else verdict = 'missed';

    return {
      id: claim.defect.id, severity: claim.defect.severity, category: claim.defect.category,
      screen: claim.screen, screenReached: claim.screenReached, verdict,
      contestedEvidence: contested,
      // The most specific signal this defect owns, not the first one the run happened to
      // produce. FP_D06 owned both a percentage-line finding naming the exact figures and
      // an unrelated server-enforcement failure that merely redirected to the same screen;
      // showing the latter made a correct detection read like a coincidence.
      evidence: best(onScreenAndSymptom.length ? onScreenAndSymptom : symptomOnly)
        ?.signal.text?.slice(0, 180) ?? null
    };
  });

  const counts = { found: 0, possible: 0, missed: 0, unreachable: 0 };
  for (const verdict of verdicts) counts[verdict.verdict] += 1;

  return {
    counts,
    verdicts,
    deadKeywords,
    failureAnalysis: {
      total: classified.length,
      applicationFailures: applicationFailures.length,
      toolErrors: toolErrors.length,
      unreliableTests: unreliableTests.length,
      unknown: classified.length - applicationFailures.length - toolErrors.length
             - unreliableTests.length,
      toolErrorBreakdown,
      unreliableBreakdown
    }
  };
}

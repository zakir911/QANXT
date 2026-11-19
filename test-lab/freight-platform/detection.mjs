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
  FP_D25_RATE_TABLE_OVERFLOWS: ['overflow', 'horizontal scroll', 'viewport'],
  FP_D26_PLANNER_FIXED_WIDTH: ['overflow', 'horizontal scroll', 'viewport'],
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
  const signals = [
    ...applicationFailures.map(f => ({ kind: 'execution', text: `${f.name ?? ''} ${f.message ?? ''}` })),
    ...findings.map(f => ({ kind: 'security', text: `${f.title ?? ''} ${f.evidence ?? ''} ${f.url ?? ''}` }))
  ];

  const claims = defects.map(defect => {
    const screen = defect.screen.split('?')[0];
    const keywords = DEFECT_KEYWORDS[defect.id] ?? [];
    const screenReached = reachedPaths.some(path => path === screen || patternMatches(screen, path));

    const namesScreen = signals.filter(signal => signal.text.includes(screen));
    const onScreenAndSymptom = namesScreen
      .map(signal => ({ signal, specificity: specificity(keywords, signal.text, true) }))
      .filter(candidate => candidate.specificity.matched > 0);
    // Away from the screen, two independent keywords are required.
    const symptomOnly = signals
      .filter(signal => !namesScreen.includes(signal))
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
      evidence: (onScreenAndSymptom[0] ?? symptomOnly[0])?.signal.text?.slice(0, 180) ?? null
    };
  });

  const counts = { found: 0, possible: 0, missed: 0, unreachable: 0 };
  for (const verdict of verdicts) counts[verdict.verdict] += 1;

  return {
    counts,
    verdicts,
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

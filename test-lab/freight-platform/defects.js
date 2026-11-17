/**
 * The defects planted in Meridian Freight.
 *
 * ## How this list was written, and why that matters
 *
 * Every defect here was written from what goes wrong in freight and warehouse software:
 * unit confusion between kg and lb, a surcharge applied to the wrong base, a cancellation
 * that leaves an orphan downstream, an authorization check that lives in the UI and not in
 * the handler. The list was written **before** looking at QA NXT's test generators, and
 * nothing in it was adjusted afterwards to make it findable.
 *
 * That is the whole point. The existing labs in this repository were written alongside the
 * checks that find their defects, which is the right way to test a detector and the wrong
 * way to estimate what it will do against an application nobody wrote for it. The security
 * report says so itself, as SECN-003. This lab exists to narrow that gap: some of these
 * defects QA NXT will certainly catch, some it will certainly miss, and the ones it misses
 * are the useful output.
 *
 * ## Defaults
 *
 * Every defect is **on by default**, because a real application you point a test tool at
 * has its bugs switched on. `POST /__faults/reset` returns to that state. To measure false
 * positives, run `node selftest.mjs --clean` or POST every id as false, which produces the
 * corrected application: a scan of that build should report nothing.
 *
 * ## Severity
 *
 * `major` costs money or misstates a record. `minor` degrades the experience. `security`
 * is exploitable. These are the lab author's judgement, recorded so that a report which
 * disagrees can be argued with rather than guessed at.
 */

export const DEFECTS = [
  // ---- Validation and data integrity -------------------------------------
  {
    id: 'FP_D01_NEGATIVE_STOCK_ADJUSTMENT',
    domain: 'warehouse',
    screen: '/warehouse/stock/:id/adjust',
    category: 'validation',
    severity: 'major',
    title: 'A stock adjustment accepts a quantity that drives on-hand below zero',
    detail: 'The form declares min="1" but the handler applies the delta without checking the resulting balance, so an adjustment of -5000 against 12 on hand stores -4988.',
    observable: 'Submit an adjustment larger than the on-hand quantity; the stock row then shows a negative on-hand figure.'
  },
  {
    id: 'FP_D02_DELIVERY_BEFORE_COLLECTION',
    domain: 'shipments',
    screen: '/shipments/new',
    category: 'crossField',
    severity: 'major',
    title: 'A requested delivery date before the collection date is accepted',
    detail: 'The booking wizard validates each date in isolation. No rule compares them, so a delivery date in the past relative to collection is stored and shown on the shipment.',
    observable: 'Book a shipment with collection 2026-04-10 and delivery 2026-04-02; it saves.'
  },
  {
    id: 'FP_D03_WEIGHT_UNIT_IGNORED',
    domain: 'shipments',
    screen: '/shipments/new',
    category: 'validation',
    severity: 'major',
    title: 'The weight unit selector is recorded but never applied',
    detail: 'A weight entered in pounds is stored as kilograms. The rate is then calculated from a number 2.2 times too small, and the vehicle capacity check passes a load it should refuse.',
    observable: 'Book with weight 1000 and unit "lb"; the shipment detail shows 1000 kg.'
  },
  {
    id: 'FP_D04_DUPLICATE_INVOICE_REFERENCE',
    domain: 'billing',
    screen: '/billing/invoices/new',
    category: 'validation',
    severity: 'major',
    title: 'Two invoices can carry the same reference',
    detail: 'The reference is generated from a counter held in memory and never checked for uniqueness before insert.',
    observable: 'Create two invoices quickly; both can be issued with the same INV-2026-xxxx reference.'
  },
  {
    id: 'FP_D05_CREDIT_LIMIT_BYPASSED',
    domain: 'orders',
    screen: '/orders/sales/new',
    category: 'businessRule',
    severity: 'major',
    title: 'The credit limit is checked on the form but not in the handler',
    detail: 'The browser disables submit when the customer is over limit. The POST handler has no equivalent check, so an order placed against a customer on credit hold is accepted.',
    observable: 'POST a sales order for a customer whose status is onHold; it is created.'
  },

  // ---- Calculation --------------------------------------------------------
  {
    id: 'FP_D06_SURCHARGE_ON_GROSS',
    domain: 'billing',
    screen: '/billing/invoices/:id',
    category: 'calculation',
    severity: 'major',
    title: 'The fuel surcharge is applied to the VAT-inclusive total',
    detail: 'The surcharge line is computed as gross x 11.5% instead of net x 11.5%, overcharging every invoice by 2.3% of net.',
    observable: 'On any invoice, the fuel line does not equal 11.5% of the freight line.'
  },
  {
    id: 'FP_D07_RATE_BAND_BOUNDARY',
    domain: 'carriers',
    screen: '/carriers/:id/rates',
    category: 'boundary',
    severity: 'major',
    title: 'A weight exactly on a rate band boundary falls into the cheaper band',
    detail: 'Band selection uses weight < toKg rather than <=, so 50.00 kg is rated in the 0-50 band and 250.00 kg in the 50-250 band. The published card says the boundary belongs to the upper band.',
    observable: 'Quote 50 kg and 50.01 kg; the rate per kg is the same when the card says it should step.'
  },
  {
    id: 'FP_D08_DUTY_EXCLUDES_FREIGHT',
    domain: 'customs',
    screen: '/customs/declarations/:id',
    category: 'calculation',
    severity: 'major',
    title: 'Duty on a CIF shipment is calculated without the freight cost',
    detail: 'Customs value for CIF should include cost, insurance and freight. The declaration uses the goods value alone, understating duty on every CIF consignment.',
    observable: 'A CIF declaration shows dutyGbp = declaredValue x rate, with no freight component.'
  },
  {
    id: 'FP_D09_CREDIT_NOTE_EXCEEDS_INVOICE',
    domain: 'billing',
    screen: '/billing/credit-notes/new',
    category: 'businessRule',
    severity: 'major',
    title: 'A credit note can be raised for more than the invoice it credits',
    detail: 'No comparison against the invoice total. A credit note of GBP 50,000 against a GBP 400 invoice is accepted and applied.',
    observable: 'Raise a credit note above the invoice total; it saves and the customer balance goes negative.'
  },
  {
    id: 'FP_D10_PAGINATION_COUNT_WRONG',
    domain: 'shipments',
    screen: '/shipments',
    category: 'calculation',
    severity: 'minor',
    title: 'The result count is taken before the filter is applied',
    detail: 'The "N shipments" heading and the page count come from the unfiltered collection, so a filter that matches three rows still offers four pages of results.',
    observable: 'Filter by status=exception; the heading still reports the full count.'
  },

  // ---- Authorization ------------------------------------------------------
  {
    id: 'FP_D11_VIEWER_CAN_SETTLE_CLAIM',
    domain: 'claims',
    screen: '/claims/:id/settle',
    category: 'authorization',
    severity: 'security',
    title: 'Claim settlement is hidden from a viewer but not refused',
    detail: 'The settle control is omitted from the page for a role without claim:settle. The POST handler checks only that a session exists, so the same request from a viewer succeeds.',
    observable: 'Sign in as readonly and POST to the settle endpoint; the claim is settled.'
  },
  {
    id: 'FP_D12_SHIPMENT_IDOR',
    domain: 'shipments',
    screen: '/shipments/:id',
    category: 'authorization',
    severity: 'security',
    title: 'Any signed-in user can read any shipment by its identifier',
    detail: 'The detail handler loads by id without checking the shipment belongs to a customer the user is allowed to see. Customer-scoped users can read every other customer\'s consignments, destinations and declared values.',
    observable: 'Request a shipment belonging to a different customer; it renders in full.'
  },
  {
    id: 'FP_D13_LEGACY_API_KEY_FULL_SCOPE',
    domain: 'admin',
    screen: '/admin/api-keys',
    category: 'authorization',
    severity: 'security',
    title: 'A legacy API key holds every scope and has no expiry',
    detail: 'The "Legacy ETL" key carries all 33 permissions including admin:users, was last used 240 days ago, and the screen offers no way to scope or expire it.',
    observable: 'The API keys screen lists a key whose scope column reads "all" with no expiry date.'
  },

  // ---- State and workflow -------------------------------------------------
  {
    id: 'FP_D14_CANCEL_ORPHANS_ROUTE_STOP',
    domain: 'shipments',
    screen: '/shipments/:id/cancel',
    category: 'stateTransition',
    severity: 'major',
    title: 'Cancelling a shipment leaves its route stop active',
    detail: 'The shipment moves to cancelled. The stop on the planned route keeps its status and sequence, so the driver is still dispatched to collect a consignment that no longer exists.',
    observable: 'Cancel a shipment that appears on a route; the route detail still lists the stop as pending.'
  },
  {
    id: 'FP_D15_WIZARD_BACK_LOSES_DATA',
    domain: 'shipments',
    screen: '/shipments/new?step=2',
    category: 'multiStep',
    severity: 'minor',
    title: 'Going back from step 3 of the booking wizard empties step 2',
    detail: 'Step 2 is re-rendered from defaults rather than from the draft, so dimensions and special handling are silently cleared when the user steps back.',
    observable: 'Complete steps 1-3, press Back twice; step 2 fields are blank.'
  },
  {
    id: 'FP_D16_DOUBLE_SUBMIT_BOOKS_TWICE',
    domain: 'shipments',
    screen: '/shipments/new',
    category: 'reliability',
    severity: 'major',
    title: 'Submitting the booking form twice creates two shipments',
    detail: 'No idempotency key and no control disabling. A double click, or a retry after a slow response, produces two consignments and two freight charges.',
    observable: 'POST the final wizard step twice with the same draft; two shipment references are returned.'
  },
  {
    id: 'FP_D17_RELEASE_REJECTED_DECLARATION',
    domain: 'customs',
    screen: '/customs/declarations/:id/release',
    category: 'stateTransition',
    severity: 'major',
    title: 'A rejected declaration can be released',
    detail: 'The release handler does not check the current status, so a declaration customs has rejected can be moved straight to released and the shipment allowed to travel.',
    observable: 'Release a declaration whose status is rejected; it becomes released.'
  },

  // ---- Error handling -----------------------------------------------------
  {
    id: 'FP_D18_LONG_SEARCH_CRASHES',
    domain: 'shipments',
    screen: '/shipments?q=',
    category: 'errorHandling',
    severity: 'major',
    title: 'A search term over 500 characters returns HTTP 500 with a stack trace',
    detail: 'The query is compiled into a regular expression without bounding its length, and the failure is rendered with the Node stack.',
    observable: 'GET /shipments?q=<501 characters>; the response is 500 and contains file paths.'
  },
  {
    id: 'FP_D19_OVERSIZE_UPLOAD_CRASHES',
    domain: 'claims',
    screen: '/claims/:id/evidence',
    category: 'errorHandling',
    severity: 'minor',
    title: 'An oversize evidence upload crashes instead of being refused',
    detail: 'The form declares a 5 MB limit in its hint. The handler reads the whole body first and throws, so the user sees a 500 rather than a validation message.',
    observable: 'Upload a file above the stated limit; the response is 500, not a field error.'
  },
  {
    id: 'FP_D20_MISSING_REFERENCE_CRASHES',
    domain: 'billing',
    screen: '/billing/invoices/:id',
    category: 'errorHandling',
    severity: 'minor',
    title: 'An invoice whose shipment has been removed crashes its detail page',
    detail: 'The detail view dereferences shipment.reference without a guard.',
    observable: 'Open an invoice whose shipmentId no longer resolves; the response is 500.'
  },

  // ---- Accessibility ------------------------------------------------------
  {
    id: 'FP_D21_UNLABELLED_ADJUSTMENT_FIELD',
    domain: 'warehouse',
    screen: '/warehouse/stock/:id/adjust',
    category: 'accessibility',
    severity: 'minor',
    title: 'The adjustment quantity input has no label',
    detail: 'The control carries a placeholder only. A screen reader announces "edit text, blank", and the field is the one that changes stock.',
    observable: 'The input has no label element, no aria-label and no aria-labelledby.'
  },
  {
    id: 'FP_D22_ERROR_NOT_ASSOCIATED',
    domain: 'claims',
    screen: '/claims/new',
    category: 'accessibility',
    severity: 'minor',
    title: 'Claim form errors are not associated with their fields',
    detail: 'Validation messages render as plain text above the form with no aria-describedby and no role="alert", so they are neither announced nor reachable from the field.',
    observable: 'Submit the claim form empty; the messages appear with no programmatic link to the inputs.'
  },
  {
    id: 'FP_D23_STATUS_BY_COLOUR_ONLY',
    domain: 'fleet',
    screen: '/fleet/vehicles',
    category: 'accessibility',
    severity: 'minor',
    title: 'Vehicle availability is conveyed by colour alone',
    detail: 'The status column renders a coloured square with no text and no accessible name. Available, in maintenance and off road are indistinguishable without colour vision.',
    observable: 'The status cell contains a styled span with no text content.'
  },
  {
    id: 'FP_D24_MODAL_NOT_ANNOUNCED',
    domain: 'orders',
    screen: '/orders/sales/:id',
    category: 'accessibility',
    severity: 'minor',
    title: 'The approval modal is not announced and does not trap focus',
    detail: 'The dialog has no aria-modal, focus stays on the trigger behind it, and Tab walks the page underneath.',
    observable: 'Open the approve modal; focus remains on the button that opened it.'
  },

  // ---- Responsive ---------------------------------------------------------
  {
    id: 'FP_D25_RATE_TABLE_OVERFLOWS',
    domain: 'carriers',
    screen: '/carriers/:id/rates',
    category: 'responsive',
    severity: 'minor',
    title: 'The rate card table forces horizontal scrolling on a phone',
    detail: 'The table is given a fixed 980px minimum width and is not wrapped in a scroll container, so the whole page scrolls sideways below about 1000px.',
    observable: 'At 390px wide, document.scrollWidth exceeds the viewport width.'
  },
  {
    id: 'FP_D26_PLANNER_FIXED_WIDTH',
    domain: 'routes',
    screen: '/routes/planner',
    category: 'responsive',
    severity: 'minor',
    title: 'The route planner is fixed at 1100px',
    detail: 'The planner grid uses an absolute width rather than a responsive one, so on a tablet the stop list is cut off with no way to reach it.',
    observable: 'At 768px wide, the planner extends beyond the viewport.'
  },

  // ---- Performance --------------------------------------------------------
  {
    id: 'FP_D27_AUDIT_LOG_SLOW',
    domain: 'admin',
    screen: '/admin/audit',
    category: 'performance',
    severity: 'minor',
    title: 'The audit log takes over three seconds to respond',
    detail: 'Every entry is enriched by scanning the user list for each row rather than by one lookup, and the whole 120-row set is formatted before the page is cut to 25.',
    observable: 'GET /admin/audit takes more than 3000 ms.'
  },

  // ---- Security -----------------------------------------------------------
  {
    id: 'FP_D28_REFLECTED_XSS_IN_SEARCH',
    domain: 'shipments',
    screen: '/shipments?q=',
    category: 'security',
    severity: 'security',
    title: 'The search term is written into the results page unescaped',
    detail: 'The "no results for X" message interpolates the raw query into the HTML, so a crafted term executes in the operator\'s session.',
    observable: 'GET /shipments?q=<script>alert(1)</script> renders the tag rather than its text.'
  },
  {
    id: 'FP_D29_NO_CSRF_ON_ADJUSTMENT',
    domain: 'warehouse',
    screen: '/warehouse/stock/:id/adjust',
    category: 'security',
    severity: 'security',
    title: 'The stock adjustment form carries no anti-forgery token',
    detail: 'Every other write form in the application posts a token. This one does not, and the handler accepts a cross-origin form post that changes inventory.',
    observable: 'The form has no hidden token field and the handler does not require one.'
  },
  {
    id: 'FP_D30_SESSION_COOKIE_FLAGS',
    domain: 'auth',
    screen: '/auth/sign-in',
    category: 'security',
    severity: 'security',
    title: 'The "remember me" path reissues the session cookie without HttpOnly',
    detail: 'The ordinary sign-in sets HttpOnly. The remember-me branch builds the header by hand and omits it, exposing the session token to any script on the page.',
    observable: 'Sign in with remember me ticked; the Set-Cookie header lacks HttpOnly.'
  },
  {
    id: 'FP_D31_STACK_TRACE_LEAKED',
    domain: 'shipments',
    screen: '/api/shipments/:id',
    category: 'security',
    severity: 'security',
    title: 'API errors return the Node stack trace and absolute file paths',
    detail: 'The JSON error handler serialises the whole error object, disclosing the deployment directory layout and dependency versions.',
    observable: 'An API error body contains "at " frames and /home/ paths.'
  },
  {
    id: 'FP_D32_PII_IN_QUERY_STRING',
    domain: 'customers',
    screen: '/customers',
    category: 'security',
    severity: 'security',
    title: 'Customer contact email is passed in the query string',
    detail: 'The contact search submits by GET, so email addresses land in access logs, proxy logs and the browser history of a shared operations terminal.',
    observable: 'Searching contacts produces /customers?contactEmail=someone@example.test in the address bar.'
  }
];

/** The catalogue shape the shared fault engine expects. Everything is on by default. */
export const DEFECT_FAULTS = DEFECTS.map(defect => ({
  id: defect.id,
  description: `${defect.title} (${defect.domain}, ${defect.severity})`,
  defaultEnabled: true
}));

/** Operational faults, off by default, for driving failure-mode tests on demand. */
export const OPERATIONAL_FAULTS = [
  { id: 'FAULT_API_500', description: 'Every JSON API route answers HTTP 500.' },
  { id: 'FAULT_API_TIMEOUT', description: 'JSON API routes never answer.' },
  { id: 'FAULT_NETWORK_ERROR', description: 'The connection is destroyed mid-response.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'The dashboard renders its figures only after a long delay.' },
  { id: 'FAULT_JS_ERROR', description: 'Every page throws an uncaught JavaScript error on load.' },
  { id: 'FAULT_SESSION_DROPPED', description: 'The session is invalidated on the next request.' }
];

export const ALL_FAULTS = [...DEFECT_FAULTS, ...OPERATIONAL_FAULTS];

/** Grouped counts, used by the ground-truth generator and the README. */
export const defectSummary = () => {
  const byCategory = {};
  const byDomain = {};
  const bySeverity = {};
  for (const defect of DEFECTS) {
    byCategory[defect.category] = (byCategory[defect.category] ?? 0) + 1;
    byDomain[defect.domain] = (byDomain[defect.domain] ?? 0) + 1;
    bySeverity[defect.severity] = (bySeverity[defect.severity] ?? 0) + 1;
  }
  return { total: DEFECTS.length, byCategory, byDomain, bySeverity };
};

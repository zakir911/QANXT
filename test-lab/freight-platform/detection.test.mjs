import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from './detection.mjs';

/**
 * Tests for the measurement, not the product.
 *
 * These exist because the analyser over-credited its own subject. Run accddf2b reported
 * "3 of 32 planted defects were detected". Two of those three shared one failure line with
 * another defect: a date-ordering failure on /shipments/new was counted as finding both
 * FP_D02, which it is, and FP_D15 "going back from step 3 empties step 2", which it is
 * not — the word "step" appeared in the test's name and one keyword was enough. A
 * measurement that flatters the thing it measures is worse than no measurement, and it had
 * no tests at all, which is how it stayed wrong.
 */

const DEFECTS = [
  {
    id: 'FP_D02_DELIVERY_BEFORE_COLLECTION', screen: '/shipments/new',
    severity: 'major', category: 'crossField'
  },
  {
    id: 'FP_D15_WIZARD_BACK_LOSES_DATA', screen: '/shipments/new?step=2',
    severity: 'minor', category: 'multiStep'
  }
];

/** The exact failure from the run, which named one defect and was credited to two. */
const DATE_ORDER_FAILURE = {
  name: 'Book a shipment — step 2: refuses Requested delivery date before Collection date',
  message: 'http://127.0.0.1:4400/shipments/new — Expected the submission to be refused, '
    + 'but it was accepted: the form is gone; no field is marked invalid.'
};

const verdictFor = (result, id) => result.verdicts.find(v => v.verdict && v.id === id);

test('one failure line is evidence for one defect, not for every defect it brushes past', () => {
  const result = detect({
    defects: DEFECTS,
    failures: [DATE_ORDER_FAILURE],
    reachedPaths: ['/shipments/new']
  });

  assert.equal(verdictFor(result, 'FP_D02_DELIVERY_BEFORE_COLLECTION').verdict, 'found',
    'the date-ordering failure is what this defect looks like');
  assert.notEqual(verdictFor(result, 'FP_D15_WIZARD_BACK_LOSES_DATA').verdict, 'found',
    'the wizard losing data on Back is not evidenced by a date comparison');
});

test('the defect that loses a contested line is told that is why', () => {
  const result = detect({
    defects: DEFECTS,
    failures: [DATE_ORDER_FAILURE],
    reachedPaths: ['/shipments/new']
  });

  const loser = verdictFor(result, 'FP_D15_WIZARD_BACK_LOSES_DATA');
  assert.equal(loser.verdict, 'missed', 'its screen was reached and nothing reported it');
  assert.ok(loser.contestedEvidence > 0,
    '"another defect explains this line" is not the same state as "nothing matched"');
  assert.equal(loser.evidence, null, 'evidence it does not own must not be shown as its own');
});

test('the more specific keyword match wins, whichever order the defects are listed', () => {
  const forwards = detect({
    defects: DEFECTS, failures: [DATE_ORDER_FAILURE], reachedPaths: ['/shipments/new']
  });
  const backwards = detect({
    defects: [...DEFECTS].reverse(), failures: [DATE_ORDER_FAILURE], reachedPaths: ['/shipments/new']
  });

  assert.equal(verdictFor(forwards, 'FP_D02_DELIVERY_BEFORE_COLLECTION').verdict, 'found');
  assert.equal(verdictFor(backwards, 'FP_D02_DELIVERY_BEFORE_COLLECTION').verdict, 'found');
});

test('two defects on one screen are both found when each has its own failure', () => {
  // The rule must not cap a screen at one detection: it is about evidence, not screens.
  const result = detect({
    defects: DEFECTS,
    failures: [
      DATE_ORDER_FAILURE,
      {
        name: 'Book a shipment: keeps step 2 when you go back',
        message: 'http://127.0.0.1:4400/shipments/new — step 2 was cleared after Back; '
          + 'the wizard lost the dimensions entered earlier.'
      }
    ],
    reachedPaths: ['/shipments/new']
  });

  assert.equal(verdictFor(result, 'FP_D02_DELIVERY_BEFORE_COLLECTION').verdict, 'found');
  assert.equal(verdictFor(result, 'FP_D15_WIZARD_BACK_LOSES_DATA').verdict, 'found');
});

test('a defect on a screen discovery never reached is unreachable, not missed', () => {
  const result = detect({ defects: DEFECTS, failures: [], reachedPaths: [] });

  assert.equal(verdictFor(result, 'FP_D02_DELIVERY_BEFORE_COLLECTION').verdict, 'unreachable',
    'nothing downstream could have found it, so it is not a miss by the generator');
});

test('a tool error is never evidence of anything about the application', () => {
  const result = detect({
    defects: DEFECTS,
    failures: [{
      name: 'Book a shipment — step 2: refuses Requested delivery date before Collection date',
      message: 'http://127.0.0.1:4400/shipments/new — locator.selectOption: Timeout 15000ms '
        + 'exceeded waiting for the select to have options.'
    }],
    reachedPaths: ['/shipments/new']
  });

  assert.equal(verdictFor(result, 'FP_D02_DELIVERY_BEFORE_COLLECTION').verdict, 'missed',
    'a test that could not run says nothing, whatever words are in its message');
});

test('no defect is found when the run reported nothing at all', () => {
  const result = detect({ defects: DEFECTS, failures: [], reachedPaths: ['/shipments/new'] });

  assert.deepEqual(result.verdicts.map(v => v.verdict), ['missed', 'missed']);
});

test('a failure on the defect\'s own screen outranks keyword count elsewhere', () => {
  // The colour-only finding on /fleet/vehicles belongs to the colour-only defect, not to
  // an unlabelled-field defect on another screen that shares accessibility vocabulary.
  const result = detect({
    defects: [
      { id: 'FP_D23_STATUS_BY_COLOUR_ONLY', screen: '/fleet/vehicles', severity: 'minor', category: 'accessibility' },
      { id: 'FP_D21_UNLABELLED_ADJUSTMENT_FIELD', screen: '/warehouse/stock/:id/adjust', severity: 'minor', category: 'accessibility' }
    ],
    failures: [{
      name: 'Vehicles (/fleet/vehicles): does not say anything with colour alone',
      message: 'http://127.0.0.1:4400/fleet/vehicles — Information is carried by colour alone: '
        + 'vehicles-table, column 8 ("Status") uses 3 colours and the cells have no label '
        + 'and no accessible name.'
    }],
    reachedPaths: ['/fleet/vehicles', '/warehouse/stock/st-1/adjust']
  });

  assert.equal(verdictFor(result, 'FP_D23_STATUS_BY_COLOUR_ONLY').verdict, 'found',
    'one keyword on its own screen beats two keywords on somebody else\'s');
  assert.notEqual(verdictFor(result, 'FP_D21_UNLABELLED_ADJUSTMENT_FIELD').verdict, 'found');
});

test('a failure on an instance is placed on its parameterised screen', () => {
  // Ground truth writes screens as templates and failures name instances. A literal
  // substring test could never join the two, so no defect on a /:id route could be scored
  // "found" however precisely an oracle named it — which is what happened to FP_D06.
  const result = detect({
    defects: [{
      id: 'FP_D06_SURCHARGE_ON_GROSS', screen: '/billing/invoices/:id',
      severity: 'major', category: 'calculation'
    }],
    failures: [{
      name: 'Invoice INV-2026-5003 (/billing/invoices/inv-0004): derives each percentage line from a figure above it',
      message: 'A percentage line does not derive from a figure above it: "Fuel surcharge 11.5%" '
        + 'is 526.82, which is 11.5% of "Total" (4581.08) — a figure the page states after it.'
    }],
    reachedPaths: ['/billing/invoices/inv-0004']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
});

test('a parameterised screen is not matched by an unrelated path', () => {
  const result = detect({
    defects: [{
      id: 'FP_D06_SURCHARGE_ON_GROSS', screen: '/billing/invoices/:id',
      severity: 'major', category: 'calculation'
    }],
    failures: [{
      name: 'Surcharges (/billing/surcharges): accepts the form',
      message: 'http://127.0.0.1:4400/billing/surcharges — the fuel surcharge field was rejected.'
    }],
    reachedPaths: ['/billing/surcharges']
  });

  assert.notEqual(result.verdicts[0].verdict, 'found');
});

test('a parameter does not swallow an action segment', () => {
  // /billing/invoices/:id matches /billing/invoices/new as a pattern, and they are
  // different pages: one shows an invoice, the other is the form that makes one.
  const result = detect({
    defects: [{
      id: 'FP_D06_SURCHARGE_ON_GROSS', screen: '/billing/invoices/:id',
      severity: 'major', category: 'calculation'
    }],
    failures: [{
      name: 'Raise an invoice: refuses a value between two of its steps in Net amount',
      message: 'POST http://127.0.0.1:4400/billing/invoices/new accepted the submission: '
        + 'the fuel surcharge total was not checked.'
    }],
    reachedPaths: ['/billing/invoices/new']
  });

  assert.notEqual(result.verdicts[0].verdict, 'found');
});

test('a failure is placed by its route when the prose never names the screen', () => {
  // The real shape: a form test is named after its form, so the screen appears nowhere in
  // its words. FP_D29 was detected by exactly this test and could not be joined to it.
  const result = detect({
    defects: [{
      id: 'FP_D29_NO_CSRF_ON_ADJUSTMENT', screen: '/warehouse/stock/:id/adjust',
      severity: 'security', category: 'security'
    }],
    failures: [{
      name: 'Adjust MF-1333: carries an anti-forgery token',
      message: 'Expected the element to exist on the page, but it does not.',
      route: '/warehouse/stock/stk-dub-sku-010/adjust'
    }],
    reachedPaths: ['/warehouse/stock/stk-dub-sku-010/adjust']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
});

test('a route rules a signal out as well as in', () => {
  // A failure whose route is a different screen must not then be matched on its words.
  // That is how a failure on one screen was credited to a defect on another.
  const result = detect({
    defects: [{
      id: 'FP_D29_NO_CSRF_ON_ADJUSTMENT', screen: '/warehouse/stock/:id/adjust',
      severity: 'security', category: 'security'
    }],
    failures: [{
      name: 'Raise an invoice: carries an anti-forgery token',
      message: 'Expected the element to exist at /warehouse/stock/stk-1/adjust, but it does not.',
      route: '/billing/invoices/new'
    }],
    reachedPaths: ['/billing/invoices/new', '/warehouse/stock/stk-1/adjust']
  });

  assert.notEqual(result.verdicts[0].verdict, 'found');
});

test('a signal with no route still falls back to its text', () => {
  const result = detect({
    defects: [{
      id: 'FP_D23_STATUS_BY_COLOUR_ONLY', screen: '/fleet/vehicles',
      severity: 'minor', category: 'accessibility'
    }],
    failures: [{
      name: 'Vehicles (/fleet/vehicles): does not say anything with colour alone',
      message: 'Information is carried by colour alone: column 8 ("Status") uses 3 colours.'
    }],
    reachedPaths: ['/fleet/vehicles']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
});

test('a defect about over-acceptance is not evidenced by over-strictness', () => {
  // Every test of the credit-note form failed because the form refuses everything, so it
  // cannot be filled at all. FP_D09 is the opposite complaint — a credit note above the
  // invoice total is accepted — and matching them credited a defect nobody had tested.
  const result = detect({
    defects: [{
      id: 'FP_D09_CREDIT_NOTE_EXCEEDS_INVOICE', screen: '/billing/credit-notes/new',
      severity: 'major', category: 'businessRule',
      observable: 'Raise a credit note above the invoice total; it saves and the balance goes negative.'
    }],
    failures: [{
      name: 'Raise a credit note: accepts "INV-2026-5003 — £4,581.08" in Invoice to credit',
      message: 'Expected the submission to be accepted, but the form is still shown; '
        + 'fields marked invalid: invoiceId, amount.',
      route: '/billing/credit-notes/new'
    }],
    reachedPaths: ['/billing/credit-notes/new']
  });

  assert.equal(result.verdicts[0].verdict, 'missed');
});

test('the same defect is found when the application really is too permissive', () => {
  const result = detect({
    defects: [{
      id: 'FP_D09_CREDIT_NOTE_EXCEEDS_INVOICE', screen: '/billing/credit-notes/new',
      severity: 'major', category: 'businessRule',
      observable: 'Raise a credit note above the invoice total; it saves.'
    }],
    failures: [{
      name: 'Raise a credit note: refuses a credit note larger than the invoice',
      message: 'Expected the submission to be refused, but it was accepted: the form is gone.',
      route: '/billing/credit-notes/new'
    }],
    reachedPaths: ['/billing/credit-notes/new']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
});

test('a direction that cannot be read never excludes anything', () => {
  // Accessibility and arithmetic findings have no permissive/strict direction at all, and
  // must not be filtered out by a rule that cannot see one.
  const result = detect({
    defects: [{
      id: 'FP_D29_NO_CSRF_ON_ADJUSTMENT', screen: '/warehouse/stock/:id/adjust',
      severity: 'security', category: 'security',
      observable: 'The form has no hidden anti-forgery field.'
    }],
    failures: [{
      name: 'Adjust MF-1333: carries an anti-forgery token',
      message: 'Expected the element to exist on the page, but it does not.',
      route: '/warehouse/stock/stk-1/adjust'
    }],
    reachedPaths: ['/warehouse/stock/stk-1/adjust']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
});

test('a structural heuristic evidences the defect it asserts', () => {
  // The engine records "Quantity to add or remove has no label tied to it; its placeholder
  // is not a label" on both adjustment pages. That is FP_D21 named exactly, and axe reports
  // nothing on that page because the accessible-name computation accepts a placeholder as a
  // name — so this heuristic is the only thing in the product that finds it.
  const result = detect({
    defects: [{
      id: 'FP_D21_UNLABELLED_ADJUSTMENT_FIELD', screen: '/warehouse/stock/:id/adjust',
      severity: 'minor', category: 'accessibility',
      observable: 'The input has no label element, no aria-label and no aria-labelledby.'
    }],
    structural: [{
      route: '/warehouse/stock/stk-dub-sku-010/adjust', code: 'no-label',
      message: 'Quantity to add or remove has no label tied to it; its placeholder is not a label.',
      fieldKey: 'delta'
    }],
    reachedPaths: ['/warehouse/stock/stk-dub-sku-010/adjust']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
  assert.equal(result.verdicts[0].evidenceKind, 'structural',
    'a reader needs to know this rests on a heuristic, not on a run');
});

test('a heuristic does not evidence a defect its prose merely mentions', () => {
  // "Find by contact email looks like personal data but does not declare autocomplete"
  // contains "personal data", which credited it to FP_D32 — a defect about an email address
  // appearing in a query string. The heuristic asserts no-autocomplete and nothing more.
  const result = detect({
    defects: [{
      id: 'FP_D32_PII_IN_QUERY_STRING', screen: '/customers',
      severity: 'security', category: 'security',
      observable: 'The customer search puts the contact email in the query string.'
    }],
    structural: [{
      route: '/customers', code: 'no-autocomplete',
      message: 'Find by contact email looks like personal data but does not declare autocomplete.',
      fieldKey: 'email'
    }],
    reachedPaths: ['/customers']
  });

  assert.equal(result.verdicts[0].verdict, 'missed');
});

test('an execution failure is still matched on its whole message', () => {
  // The asserts-only rule must apply to heuristics alone: a test failure's message is the
  // observation itself, not prose about one.
  const result = detect({
    defects: [{
      id: 'FP_D23_STATUS_BY_COLOUR_ONLY', screen: '/fleet/vehicles',
      severity: 'minor', category: 'accessibility'
    }],
    failures: [{
      name: 'Vehicles (/fleet/vehicles): does not say anything with colour alone',
      message: 'Information is carried by colour alone: column 8 uses 3 colours.'
    }],
    reachedPaths: ['/fleet/vehicles']
  });

  assert.equal(result.verdicts[0].verdict, 'found');
  assert.equal(result.verdicts[0].evidenceKind, 'execution');
});

test('a defect whose words appear nowhere in the run is unscoreable, not missed', () => {
  // Thirteen of the thirty-two freight defects were in this state and every one was
  // reported as "missed" — a claim about the product resting on the measurement's own blind
  // spot. The dead-keyword report had named them, carrying the warning that this is exactly
  // how FP_D25 and FP_D26 read as missed while both were being detected.
  const result = detect({
    defects: [{ id: 'FP_D04_DUPLICATE_INVOICE_REFERENCE', screen: '/billing/invoices/new',
                severity: 'major', category: 'validation' }],
    failures: [{
      name: 'Raise an invoice: refuses a value between two of its steps of 0.01 in Net amount (GBP)',
      message: 'POST http://127.0.0.1:4400/billing/invoices/new accepted the submission.',
      category: '5', route: '/billing/invoices/new'
    }],
    reachedPaths: ['/billing/invoices/new']
  });

  const verdict = verdictFor(result, 'FP_D04_DUPLICATE_INVOICE_REFERENCE');
  assert.equal(verdict.verdict, 'unscoreable',
    'none of duplicate/unique/already exists appears in the run, so nothing here could '
    + 'have scored it either way');
  assert.ok(result.deadKeywords.some(entry => entry.id === 'FP_D04_DUPLICATE_INVOICE_REFERENCE'));
});

test('an empty run is a miss by the product, not an unscoreable measurement', () => {
  // The opposite reason for the same arithmetic: with no signals at all every keyword list
  // matches nothing, and the product genuinely reported nothing. That belongs to the
  // product. Letting "the measurement cannot say" absorb it would excuse every empty run.
  const result = detect({
    defects: [{ id: 'FP_D04_DUPLICATE_INVOICE_REFERENCE', screen: '/billing/invoices/new',
                severity: 'major', category: 'validation' }],
    failures: [],
    reachedPaths: ['/billing/invoices/new']
  });

  assert.equal(verdictFor(result, 'FP_D04_DUPLICATE_INVOICE_REFERENCE').verdict, 'missed');
  assert.deepEqual(result.deadKeywords, []);
});

test('a performance test failing on a performance defect\'s own screen is evidence enough', () => {
  // FP_D27's keywords were 'slow', 'response time' and 'performance budget'. The product
  // said "Expected the page to load within 3000 ms but it took 3424 ms" — none of those
  // words, the screen named, the symptom given in numbers. Structure both sides recorded
  // independently beats a phrase one side guessed at.
  const result = detect({
    defects: [{ id: 'FP_D27_AUDIT_LOG_SLOW', screen: '/admin/audit', severity: 'minor',
                category: 'performance' }],
    failures: [{
      name: 'Audit log: loads within 3000 ms',
      message: 'Expected the page to load within 3000 ms but it took 3424 ms.',
      category: '14', route: '/admin/audit'
    }],
    reachedPaths: ['/admin/audit']
  });

  assert.equal(verdictFor(result, 'FP_D27_AUDIT_LOG_SLOW').verdict, 'found');
});

test('a validation test failing on a form does not identify which rule broke', () => {
  // The first version of the category rule credited three defects wrongly in one pass. A
  // form carries many validation rules, so "a validation test failed here" cannot say which
  // — and category agreement alone counts only where the category is the whole claim, as
  // for a page that is either slow or not.
  const result = detect({
    defects: [{ id: 'FP_D04_DUPLICATE_INVOICE_REFERENCE', screen: '/billing/invoices/new',
                severity: 'major', category: 'validation' }],
    failures: [{
      name: 'Raise an invoice: refuses a value between two of its steps of 0.01 in Net amount (GBP)',
      message: 'duplicate unique already exists — words present so the list is not dead',
      category: '5', route: '/billing/invoices/new'
    }],
    reachedPaths: ['/billing/invoices/new']
  });

  // The words are there, so it is scoreable and scored on the words, not on the category.
  assert.notEqual(verdictFor(result, 'FP_D04_DUPLICATE_INVOICE_REFERENCE').verdict, 'unscoreable');
});

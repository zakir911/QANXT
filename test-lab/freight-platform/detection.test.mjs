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

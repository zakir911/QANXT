import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findPersonalData, passesLuhn, validIban,
  validNationalInsuranceNumber, validSocialSecurityNumber
} from '../src/personal-data.mjs';

/**
 * Personal data detection, and the arithmetic that keeps it precise.
 *
 * The sensitive-data check looked for credentials and nothing else, so a permit register
 * printing every applicant's national insurance number in full to every signed-in user was
 * clean. Every pattern added here is checked rather than matched, which is the only reason
 * a sixteen-digit invoice reference does not read as a card number.
 */

test('Luhn separates a card number from a long reference', () => {
  assert.equal(passesLuhn('4111111111111111'), true);
  assert.equal(passesLuhn('5500005555555559'), true);
  assert.equal(passesLuhn('4111111111111112'), false, 'one digit out is not a card number');
  assert.equal(passesLuhn('1234567890123456'), false, 'a sequential reference is not a card number');
  assert.equal(passesLuhn('411111111111'), false, 'twelve digits is too short');
});

test('mod-97 separates an IBAN from a reference of the same shape', () => {
  assert.equal(validIban('GB82 WEST 1234 5698 7654 32'), true);
  assert.equal(validIban('GB82WEST12345698765432'), true);
  assert.equal(validIban('GB83 WEST 1234 5698 7654 32'), false, 'wrong check digits');
  assert.equal(validIban('XX00 ABCD 1234 5678 9012 34'), false);
});

test('a national insurance number is recognised by its issuing rules', () => {
  assert.equal(validNationalInsuranceNumber('AB 98 76 54 D'), true);
  assert.equal(validNationalInsuranceNumber('AB987654D'), true);
  // Q, U and V never appear in the prefix; several pairs are never issued.
  assert.equal(validNationalInsuranceNumber('QQ 12 34 56 C'), false);
  assert.equal(validNationalInsuranceNumber('BG 12 34 56 A'), false, 'BG is never issued');
  assert.equal(validNationalInsuranceNumber('AB 98 76 54 E'), false, 'the suffix is A to D');
  assert.equal(validNationalInsuranceNumber('AO 98 76 54 A'), false, 'O never appears second');
});

test('a social security number excludes the ranges never issued', () => {
  assert.equal(validSocialSecurityNumber('123-45-6789'), true);
  assert.equal(validSocialSecurityNumber('000-45-6789'), false);
  assert.equal(validSocialSecurityNumber('666-45-6789'), false);
  assert.equal(validSocialSecurityNumber('900-45-6789'), false);
  assert.equal(validSocialSecurityNumber('123-00-6789'), false);
  assert.equal(validSocialSecurityNumber('123-45-0000'), false);
});

/** The page that went undetected, in the markup the application actually serves. */
test('an identifier printed in a page is found, and the value is not quoted back', () => {
  const page = `<TABLE><TR><TD><FONT SIZE="1">National insurance</FONT></TD>
    <TD><FONT SIZE="1">AB 98 76 54 D</FONT></TD></TR></TABLE>`;
  const [finding] = findPersonalData(page);
  assert.equal(finding.kind, 'national insurance number');
  assert.equal(finding.distinct, 1);
  assert.doesNotMatch(finding.sample, /98 76 54/, 'the sample must not reproduce the value');
});

test('a register of many people is counted as many, not as one', () => {
  const register = ['AB 98 76 54 D', 'CE 11 22 33 A', 'HJ 44 55 66 B']
    .map(value => `<TR><TD>${value}</TD></TR>`).join('');
  const [finding] = findPersonalData(register);
  assert.equal(finding.distinct, 3);
});

test('the same value repeated in a template counts once', () => {
  const page = 'AB 98 76 54 D ... AB987654D ... AB 98 76 54 D';
  const [finding] = findPersonalData(page);
  assert.equal(finding.distinct, 1);
  assert.equal(finding.count, 3);
});

test('a page of ordinary references and dates reports nothing', () => {
  const page = `<p>Reference BP-2026-0002, raised 2026-11-21, total 445.00.
    Order 1234567890123456 for 80.00. Telephone 020 7946 0958.
    Contact permits@example.com about application 12345678.</p>`;
  assert.deepEqual(findPersonalData(page), []);
});

test('an empty or absent body reports nothing rather than throwing', () => {
  assert.deepEqual(findPersonalData(''), []);
  assert.deepEqual(findPersonalData(undefined), []);
  assert.deepEqual(findPersonalData(null), []);
});

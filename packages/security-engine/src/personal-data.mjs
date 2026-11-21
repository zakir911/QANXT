/**
 * Personal data in a response.
 *
 * The sensitive-data check looked for credentials and secrets — password hashes, API keys,
 * JWTs, private keys, connection strings — and nothing else. A permit register printing
 * every applicant's national insurance number in full to every signed-in user was clean by
 * that standard, and so would be a page listing customers' card numbers. Personal data
 * exposure is the finding a regulator asks about first and the scanner could not see it.
 *
 * ## Why these four and not more
 *
 * Every pattern here can be *checked*, not merely matched: Luhn for a card number, mod-97
 * for an IBAN, the real format rules for a national insurance number, the issued ranges for
 * a social security number. That is the whole reason precision holds. A sixteen-digit
 * invoice reference is not a card number, and the arithmetic says so.
 *
 * Email addresses and telephone numbers are deliberately absent. A support address in a
 * footer is not a leak, and a detector that reports one teaches its readers to skim — which
 * costs more than the finding is worth.
 */

/** Luhn, which every payment card number satisfies and almost no other number does. */
export function passesLuhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The ISO 13616 check: move the first four characters to the end, letters to digits, mod 97. */
export function validIban(candidate) {
  const value = candidate.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(value)) return false;
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = character >= 'A' && character <= 'Z'
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * A UK national insurance number.
 *
 * The format rules are restrictive enough to carry the check on their own: the first two
 * letters exclude D, F, I, Q, U and V, the second excludes O as well, several prefixes are
 * never issued, and the suffix is A to D.
 */
export function validNationalInsuranceNumber(candidate) {
  const value = candidate.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(value)) return false;
  return !['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ'].includes(value.slice(0, 2));
}

/**
 * A US social security number.
 *
 * Numbers that were never issued are excluded: area 000, 666 and 900-999, group 00, serial
 * 0000. Without those a date like 123-45-6789 in documentation reads as a leak.
 */
export function validSocialSecurityNumber(candidate) {
  const match = /^(\d{3})-(\d{2})-(\d{4})$/.exec(candidate.trim());
  if (!match) return false;
  const [, area, group, serial] = match;
  const areaNumber = Number(area);
  return areaNumber !== 0 && areaNumber !== 666 && areaNumber < 900
    && Number(group) !== 0 && Number(serial) !== 0;
}

/**
 * Personal data found in `text`, each entry naming what it is and how much of it there is.
 *
 * A count matters as much as a match: one national insurance number on a page about one
 * person may be that person's own record, and eleven of them on one page is a register
 * nobody meant to publish. The caller decides; this reports both.
 *
 * Values are never returned, only how they were recognised and a masked sample, because a
 * finding that quotes the data copies the leak into the report.
 */
export function findPersonalData(text) {
  if (typeof text !== 'string' || text === '') return [];

  const found = [];

  const add = (kind, matches, cwe) => {
    if (matches.length === 0) return;
    found.push({
      kind, count: matches.length, cwe,
      sample: mask(matches[0]),
      // Distinct values, because the same number repeated in a template is one value.
      distinct: new Set(matches.map(m => m.replace(/\s+/g, ''))).size
    });
  };

  add('payment card number',
    [...text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)]
      .map(m => m[0])
      .filter(candidate => passesLuhn(candidate.replace(/[ -]/g, ''))),
    'CWE-311');

  add('IBAN',
    [...text.matchAll(/\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9][ ]?){10,30}\b/g)]
      .map(m => m[0])
      .filter(validIban),
    'CWE-359');

  add('national insurance number',
    [...text.matchAll(/\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi)]
      .map(m => m[0])
      .filter(validNationalInsuranceNumber),
    'CWE-359');

  add('social security number',
    [...text.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)]
      .map(m => m[0])
      .filter(validSocialSecurityNumber),
    'CWE-359');

  return found;
}

/** Enough to recognise the value in a page, not enough to be the value. */
function mask(value) {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${'*'.repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-2)}`;
}

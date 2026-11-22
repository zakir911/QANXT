import { describe, expect, it } from 'vitest';
import { readsAsPermissionRefusal } from '../src/execution/form-oracles.js';

/**
 * A form that is hidden has left the user's screen, whether or not it left the DOM.
 *
 * assertFormAccepted tested !formPresent — the form removed from the document. A modal form
 * that closes on success stays in the document and is hidden, which is the commonest
 * acceptance pattern in a back-office application. It was reported as a silent refusal:
 *
 *   Expected the submission to be accepted, but the form is present but hidden;
 *   no field is marked invalid; no error message is shown.
 *
 * 30 of 275 failures in a measured run against a 137-screen application were that, on
 * submissions the application had accepted. formVisible was already computed beside
 * formPresent and was simply not used.
 *
 * The acceptance rule is replicated here rather than imported because it is a closure inside
 * the oracle. That is a real limitation of this test: it pins the rule's logic, not the
 * oracle's wiring, and a change to the oracle that bypassed the rule would not be caught.
 * The rule is the part that was wrong.
 */
describe('what counts as an accepted submission', () => {
  interface Signals {
    formPresent: boolean; formVisible: boolean;
    invalidFields: string[]; errorTexts: string[]; successTexts: string[];
  }

  const accepted = (s: Signals) => (s.successTexts.length > 0 || !s.formVisible)
    && s.invalidFields.length === 0 && s.errorTexts.length === 0;

  const base: Signals = {
    formPresent: true, formVisible: true,
    invalidFields: [], errorTexts: [], successTexts: []
  };

  it('accepts a modal form that closed but stayed in the document', () => {
    expect(accepted({ ...base, formPresent: true, formVisible: false })).toBe(true);
  });

  it('still accepts a form removed from the document altogether', () => {
    expect(accepted({ ...base, formPresent: false, formVisible: false })).toBe(true);
  });

  it('still accepts a form that stayed put and showed a confirmation', () => {
    expect(accepted({ ...base, successTexts: ['Transfer raised'] })).toBe(true);
  });

  it('does not accept a form that is still in front of the user with nothing said', () => {
    expect(accepted(base)).toBe(false);
  });

  it('does not accept a hidden form while a field is marked invalid', () => {
    // The guard that keeps this honest: hiding the form does not excuse an error.
    expect(accepted({ ...base, formVisible: false, invalidFields: ['quantity'] })).toBe(false);
  });

  it('does not accept a hidden form while an error is shown elsewhere', () => {
    expect(accepted({ ...base, formVisible: false, errorTexts: ['Insufficient stock'] })).toBe(false);
  });
});

/**
 * Which messages read as "you may not do this".
 *
 * The vocabulary is the whole risk. Too narrow and a quarter of a run's failures stay
 * misattributed; too wide and a real validation defect is reported as nothing at all. It is
 * deliberately the same list the diagnosis layer uses, and deliberately excludes "not
 * allowed": an application says "that is not allowed" about a value as readily as about a
 * person.
 */
describe('reading a refusal as a permission wall', () => {
  const refuses = (text: string) => readsAsPermissionRefusal(text);

  it('reads the wordings an application actually uses', () => {
    expect(refuses('You do not have permission to raise credit notes.')).toBe(true);
    expect(refuses('Forbidden')).toBe(true);
    expect(refuses('Access denied')).toBe(true);
    expect(refuses('You are not authorised to approve this.')).toBe(true);
    expect(refuses('Not authorized')).toBe(true);
    expect(refuses('Unauthorised request')).toBe(true);
  });

  it('does not read a validation message as a permission wall', () => {
    // Each of these is a real defect when the submission was valid. Reading one as a
    // permission wall would turn it into a step that reports nothing.
    expect(refuses('That is not allowed.')).toBe(false);
    expect(refuses('Amount must be between 1 and 100,000.')).toBe(false);
    expect(refuses('This field is required.')).toBe(false);
    expect(refuses('Enter a valid email address.')).toBe(false);
    expect(refuses('The reference is already in use.')).toBe(false);
  });

  it('is not fooled by a word that merely contains one of its own', () => {
    expect(refuses('Permissible weights are shown in the table.')).toBe(false);
  });

  it('ignores letter case, as a page is written by a person', () => {
    expect(refuses('PERMISSION REQUIRED')).toBe(true);
    expect(refuses('access Denied')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

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

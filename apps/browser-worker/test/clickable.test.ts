import { describe, expect, it } from 'vitest';
import { decide, looksMutating, type ClickCandidate } from '../src/discovery/clickable.js';

/**
 * The crawler cannot know what a button does before it presses it. These tests are the
 * whole argument for letting it press anything at all on a running application, so they are
 * written from the destructive direction first: the question is not "does it find the nav",
 * it is "what will it refuse to touch".
 */
const candidate = (overrides: Partial<ClickCandidate> = {}): ClickCandidate => ({
  index: 0, tagName: 'button', role: 'button', accessibleName: 'Users', type: '',
  href: '', inForm: false, inNav: false, disabled: false, selector: 'button', ...overrides
});

describe('what the crawler refuses to click', () => {
  const destructive = [
    'Delete', 'Delete user', 'Remove account', 'Destroy', 'Erase all', 'Purge records',
    'Submit', 'Save changes', 'Apply', 'Confirm', 'Approve request', 'Reject',
    'Send invite', 'Email customer', 'Publish', 'Deploy to production',
    'Pay now', 'Purchase', 'Checkout', 'Refund', 'Transfer funds', 'Withdraw',
    'Create user', 'Add payee', 'Update settings', 'Edit profile', 'Rename',
    'Cancel subscription', 'Revoke token', 'Disable account', 'Reset password',
    'Upload document', 'Import CSV', 'Export', 'Sign out', 'Log out'
  ];

  it.each(destructive)('refuses "%s" in interactive mode', name => {
    const decision = decide(candidate({ accessibleName: name }), 'interactive', false);

    expect(decision.click).toBe(false);
    expect(decision.reason).toContain('changes data');
  });

  it('refuses a submit button even when it is named something harmless', () => {
    // The type is a fact; the label is a claim. A submit button labelled "Continue"
    // submits the form.
    const decision = decide(
      candidate({ accessibleName: 'Continue', type: 'submit' }), 'interactive', false);

    expect(decision.click).toBe(false);
    expect(decision.reason).toContain('submit');
  });

  it('refuses a reset button', () => {
    expect(decide(candidate({ accessibleName: 'Start over', type: 'reset' }), 'interactive', false)
      .click).toBe(false);
  });

  it('refuses an unnamed control inside a form', () => {
    // With no label there is nothing to judge it by, and inside a form the most likely
    // thing an unnamed control does is submit it.
    const decision = decide(
      candidate({ accessibleName: '', inForm: true }), 'interactive', false);

    expect(decision.click).toBe(false);
  });

  it('refuses an unnamed control anywhere in interactive mode', () => {
    expect(decide(candidate({ accessibleName: '' }), 'interactive', false).click).toBe(false);
  });

  it('refuses a disabled control', () => {
    expect(decide(candidate({ accessibleName: 'Users', disabled: true }), 'interactive', false)
      .click).toBe(false);
  });

  it('clicks nothing at all in links mode, however safe it looks', () => {
    expect(decide(candidate({ accessibleName: 'Users', inNav: true }), 'links', false).click)
      .toBe(false);
  });
});

describe('what the crawler will click', () => {
  it('clicks a navigation item that is not a link', () => {
    // The case this exists for: an admin sidebar built from buttons that call a router.
    const decision = decide(candidate({ accessibleName: 'Users', inNav: true }), 'navigation', false);

    expect(decision.click).toBe(true);
    expect(decision.reason).toContain('navigation');
  });

  it.each(['link', 'menuitem', 'tab', 'treeitem'])('clicks a role=%s control', role => {
    expect(decide(candidate({ role, accessibleName: 'Reports' }), 'navigation', false).click)
      .toBe(true);
  });

  it('clicks an inert-looking control in interactive mode but not navigation mode', () => {
    const control = candidate({ accessibleName: 'Show details' });

    expect(decide(control, 'navigation', false).click).toBe(false);
    expect(decide(control, 'interactive', false).click).toBe(true);
  });

  it('leaves ordinary links to the link follower rather than clicking them twice', () => {
    const decision = decide(
      candidate({ tagName: 'a', href: 'https://site.test/users', accessibleName: 'Users' }),
      'interactive', false);

    expect(decision.click).toBe(false);
    expect(decision.reason).toContain('already followed');
  });

  it('clicks navigation even inside a form, because nav does live in forms', () => {
    expect(decide(
      candidate({ accessibleName: 'Next page', inForm: true, inNav: true }), 'navigation', false)
      .click).toBe(true);
  });
});

describe('the state-changing escape hatch', () => {
  it('is off by default, so a delete button is refused', () => {
    expect(decide(candidate({ accessibleName: 'Delete user' }), 'interactive', false).click)
      .toBe(false);
  });

  it('permits a submit only when explicitly turned on', () => {
    const submit = candidate({ accessibleName: 'Save', type: 'submit' });

    expect(decide(submit, 'interactive', false).click).toBe(false);
    expect(decide(submit, 'interactive', true).click).toBe(true);
  });

  it('still refuses a disabled control even when state changes are permitted', () => {
    expect(decide(candidate({ accessibleName: 'Delete', disabled: true }), 'interactive', true)
      .click).toBe(false);
  });

  it('still clicks nothing in links mode even when state changes are permitted', () => {
    expect(decide(candidate({ accessibleName: 'Users', inNav: true }), 'links', true).click)
      .toBe(false);
  });
});

describe('matching a verb without catching a noun', () => {
  it.each(['Payments', 'Payees', 'Addresses', 'Editorial', 'Savings accounts', 'Sender report'])(
    'does not treat "%s" as mutating', name => {
      // Substring matching would skip every one of these: "pay" in Payments, "add" in
      // Addresses, "edit" in Editorial, "save" in Savings, "send" in Sender. Those are
      // ordinary nav items on a banking admin and skipping them defeats the point.
      expect(looksMutating(name)).toBe(false);
    });

  it.each(['Pay', 'Pay now', 'Add payee', 'Edit profile', 'Save', 'Send message'])(
    'still catches "%s"', name => {
      expect(looksMutating(name)).toBe(true);
    });

  it('is case insensitive', () => {
    expect(looksMutating('DELETE USER')).toBe(true);
    expect(looksMutating('delete user')).toBe(true);
  });

  it('treats an empty name as not mutating, so emptiness is judged elsewhere', () => {
    expect(looksMutating('')).toBe(false);
    expect(looksMutating('   ')).toBe(false);
  });
});

describe('an unrecognised mode', () => {
  it.each(['', 'LINKS', 'aggressive', 'undefined'])(
    'treats "%s" as links and clicks nothing', mode => {
      // The column was added with a default of "" before it was corrected, and an empty
      // string is not "links". Without this, a migration alone would have upgraded every
      // existing application from following links to clicking controls.
      const decision = decide(
        candidate({ accessibleName: 'Users', inNav: true }),
        mode as never,
        false);

      expect(decision.click).toBe(false);
    });

  it('still clicks nothing on an unrecognised mode even with state changes permitted', () => {
    expect(decide(candidate({ accessibleName: 'Users', inNav: true }), '' as never, true).click)
      .toBe(false);
  });
});

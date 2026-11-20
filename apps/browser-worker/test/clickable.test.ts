import { describe, expect, it } from 'vitest';
import { decide, linkLooksMutating, looksMutating, type ClickCandidate } from '../src/discovery/clickable.js';

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

/**
 * Following a link is not free of consequence on an application that changes state through
 * links. A crawl of a permit register — mapping pages, following links, clicking nothing —
 * approved all three permits in it. `decide` already knew the word "approve"; it handed
 * anchors to link following, and link following tested nothing.
 */
describe('linkLooksMutating', () => {
  const mutating = (name: string, url: string) => linkLooksMutating(name, url);
  const inNav = (name: string, url: string) => linkLooksMutating(name, url, true);

  it('refuses the link that approved every permit in a register', () => {
    expect(mutating('Approve', 'http://127.0.0.1:4700/approve.asp?id=1')).toBe(true);
  });

  it('reads the path when the link has no text of its own', () => {
    expect(mutating('', 'http://host/permits/1/revoke')).toBe(true);
    expect(mutating('', 'http://host/approve.asp?id=2')).toBe(true);
    expect(mutating('', 'http://host/api/v1/orders/9/cancel')).toBe(true);
  });

  it('reads a hyphenated or dotted path as words', () => {
    expect(mutating('', 'http://host/admin/delete-user')).toBe(true);
    expect(mutating('', 'http://host/invoice.remove.do')).toBe(true);
  });

  it('follows an ordinary page whose path merely contains those letters', () => {
    // The word-boundary rule in looksMutating is what makes these safe to follow, and it
    // is the reason this is tested rather than assumed: "payments" contains "pay".
    expect(mutating('Payments', 'http://host/payments')).toBe(false);
    expect(mutating('Saved searches', 'http://host/saved-searches')).toBe(false);
    expect(mutating('Address book', 'http://host/addresses')).toBe(false);
    expect(mutating('Permit register', 'http://host/list.asp')).toBe(false);
  });

  /**
   * A query string carries values, not intent. Refusing on it would stop the crawl reading
   * a filtered list, which is a page like any other.
   */
  it('does not read intent out of a query string', () => {
    expect(mutating('Cancelled orders', 'http://host/orders?status=cancelled')).toBe(false);
    expect(mutating('Search', 'http://host/search.asp?term=delete')).toBe(false);
    expect(mutating('', 'http://host/view.asp?next=/approve.asp')).toBe(false);
  });

  /**
   * The three regressions the word-list versions of this guard caused, kept as tests
   * because each was worse than the bug: applying a button vocabulary to links refused a
   * permit register's "New application", a banking application's "Fund transfer", and five
   * form-lab routes named "Checkout", "Save a draft", "Save a preference", "Transfer
   * money" and an upload. Every one of them only ever opened a form.
   */
  it('follows a link that opens a screen rather than making the change', () => {
    expect(mutating('New application', 'http://host/new.asp')).toBe(false);
    expect(mutating('Fund transfer', 'http://host/app/transfer')).toBe(false);
    expect(mutating('Checkout', 'http://host/checkout')).toBe(false);
    expect(mutating('Save a draft', 'http://host/client-silent-discard')).toBe(false);
    expect(mutating('Transfer money', 'http://host/duplicate-submit')).toBe(false);
    expect(mutating('Upload a document', 'http://host/file-upload')).toBe(false);
  });

  /**
   * What separates the two is not vocabulary, it is whether the link addresses something.
   * A link that performs an act acts on a record and carries its identifier.
   */
  it('refuses the same words once the link names a record', () => {
    expect(mutating('Pay', 'http://host/invoices/5/pay')).toBe(true);
    expect(mutating('Submit', 'http://host/orders/99/submit')).toBe(true);
    expect(mutating('Edit', 'http://host/profile/5/edit')).toBe(true);
    expect(mutating('Upload', 'http://host/permits/upload?id=7')).toBe(true);
  });

  /**
   * And some words complete the act on arrival with nothing to act on. Those are refused
   * whatever the link addresses, because "Clear basket" and "Reset" do it to everything.
   */
  it('refuses a word that acts on arrival even with no record named', () => {
    expect(mutating('Clear basket', 'http://host/cart/clear')).toBe(true);
    expect(mutating('Reset', 'http://host/admin/reset')).toBe(true);
    expect(mutating('Delete all', 'http://host/admin/delete-all')).toBe(true);
    expect(mutating('Archive', 'http://host/mail/archive')).toBe(true);
  });

  it('does not read a page number or a filter as a record', () => {
    expect(mutating('Save', 'http://host/drafts/save?page=2')).toBe(false);
    expect(mutating('Export', 'http://host/reports/export?format=csv&from=2026-01-01')).toBe(false);
  });

  it('refuses a sign-out link, which ends the crawl rather than changing a record', () => {
    expect(mutating('Sign out', 'http://host/auth/sign-out')).toBe(true);
    expect(mutating('', 'http://host/logout')).toBe(true);
  });

  /**
   * The second over-block, and the one that showed a word list cannot settle this: a
   * banking application's navigation carried "Fund transfer", which reads exactly like
   * "Approve" to a matcher and is the name of a screen. Refusing it took the transfer page
   * and its four-field form out of the crawl entirely.
   *
   * A region whose job is to move you around is structural evidence, and it needs no
   * vocabulary at all.
   */
  it('follows a mutating-sounding link that lives in a navigation region', () => {
    // A region whose job is to move you around is a second, independent reason to follow,
    // and it covers the case the structural rule alone does not: a navigation link that
    // does name a record, such as "Edit profile" pointing at /profile/5/edit.
    expect(mutating('Edit profile', 'http://host/profile/5/edit')).toBe(true);
    expect(inNav('Edit profile', 'http://host/profile/5/edit')).toBe(false);
    expect(inNav('Payments and transfers', 'http://host/app/payments')).toBe(false);
  });

  /**
   * Except signing out, which is in navigation on almost every application. It changes no
   * record; it ends the crawl's session, and everything mapped after it is a signed-out
   * shell.
   */
  it('refuses an act-on-arrival link even in a navigation region', () => {
    expect(inNav('Archive', 'http://host/mail/archive')).toBe(true);
    expect(inNav('Clear', 'http://host/cart/clear')).toBe(true);
  });

  it('refuses a sign-out link even in a navigation region', () => {
    expect(inNav('Sign out', 'http://host/auth/sign-out')).toBe(true);
    expect(inNav('Log out', 'http://host/logout')).toBe(true);
    expect(inNav('Unsubscribe', 'http://host/prefs/unsubscribe')).toBe(true);
  });

  it('still refuses a per-record action link outside a navigation region', () => {
    expect(mutating('Approve', 'http://host/approve.asp?id=1')).toBe(true);
    expect(mutating('Delete', 'http://host/permits/1/delete')).toBe(true);
  });

  it('copes with a relative or malformed URL rather than throwing', () => {
    expect(mutating('', '/permits/approve')).toBe(true);
    expect(mutating('', 'not a url at all')).toBe(false);
  });
});

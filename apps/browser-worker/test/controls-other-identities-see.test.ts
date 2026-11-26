import { describe, expect, test } from 'vitest';
import {
  controlsTheSurfaceDoesNotHold, declaredControlsIn, unseenControlGap
} from '../src/security/controls-other-identities-see.js';
import type { SecurityTarget } from '@qa-nxt/shared-types';

/**
 * Discovery maps an application as one identity. A security scan is given several, because
 * every authorization check compares two. So the surface is whatever the crawling identity
 * could see, while the scan holds credentials that would have shown it more.
 *
 * Measured on freight: the claim detail page renders its settle control only for a role
 * holding `claim:settle`, `ops.lead` holds none, and `GET /claims/clm-0001/settle` answers
 * **403** to that identity. Verified by hand — as `ops.lead` the control is absent; as
 * `admin` and as `finance` it is there. Behind the address is a planted defect:
 * the `readonly` account settled a £5,953.11 claim for £1.00.
 */
const target = (identifier: string, kind: 'page' | 'endpoint' = 'page') =>
  ({ kind, identifier, requiresAuthentication: true, parameters: [], checks: [] }) as SecurityTarget;

describe('declaredControlsIn', () => {
  test('reads a destination off a button, which is how a role-gated control is written', () => {
    const html = '<button type="button" data-route="/claims/clm-0001/settle" '
      + 'data-testid="settle-claim">Settle</button>';

    expect(declaredControlsIn(html)).toEqual([
      { address: '/claims/clm-0001/settle', name: 'Settle' }
    ]);
  });

  test('reads a form action, which is just as likely to be gated', () => {
    const html = '<form method="post" action="/claims/clm-0001/settle"><input name="a"></form>';

    expect(declaredControlsIn(html).map(c => c.address)).toEqual(['/claims/clm-0001/settle']);
  });

  test('ignores an anchor, whose destination is already followed', () => {
    expect(declaredControlsIn('<a href="/about" data-route="/about">About</a>')).toEqual([]);
  });

  test('ignores a route inside a script, which is not a control the page renders', () => {
    // Freight ships error markup and route tables in inline scripts on every page.
    const html = '<script>const routes = { settle: "/claims/x/settle" };'
      + 'el.innerHTML = \'<button data-route="/admin/danger">x</button>\';</script>';

    expect(declaredControlsIn(html)).toEqual([]);
  });

  test('ignores a style block and a comment', () => {
    expect(declaredControlsIn('<style>[data-route="/x"]{color:red}</style>')).toEqual([]);
    expect(declaredControlsIn('<!-- <button data-route="/x">x</button> -->')).toEqual([]);
  });

  test('takes an app-relative address only, never an absolute one off-site', () => {
    const html = '<button data-route="https://elsewhere.invalid/x">x</button>'
      + '<button data-url="/orders/new">New</button>';

    expect(declaredControlsIn(html).map(c => c.address)).toEqual(['/orders/new']);
  });

  test('the common routing attributes are all read', () => {
    for (const attribute of ['data-route', 'data-href', 'data-url', 'data-link', 'data-to',
                             'data-path', 'data-navigate', 'routerlink', 'ng-href']) {
      const html = `<button ${attribute}="/x/y">Go</button>`;
      expect(declaredControlsIn(html).map(c => c.address), attribute).toEqual(['/x/y']);
    }
  });

  test('an address declared twice is reported once', () => {
    const html = '<button data-route="/x">a</button><button data-route="/x">b</button>';

    expect(declaredControlsIn(html)).toHaveLength(1);
  });

  test('nothing in, nothing out', () => {
    expect(declaredControlsIn('')).toEqual([]);
    expect(declaredControlsIn(null)).toEqual([]);
  });
});

describe('controlsTheSurfaceDoesNotHold', () => {
  test('an address the surface lacks is reported, with the page that declared it', () => {
    const unseen = controlsTheSurfaceDoesNotHold(
      '/claims/clm-0001',
      [{ address: '/claims/clm-0001/settle', name: 'Settle' }],
      [target('/claims'), target('/claims/clm-0001')]
    );

    expect(unseen).toEqual([
      { address: '/claims/clm-0001/settle', declaredOn: '/claims/clm-0001', name: 'Settle' }
    ]);
  });

  test('an address the surface already holds is not reported', () => {
    const unseen = controlsTheSurfaceDoesNotHold(
      '/claims/clm-0001',
      [{ address: '/claims/clm-0001/settle', name: 'Settle' }],
      [target('/claims/clm-0001/settle', 'endpoint')]
    );

    expect(unseen).toEqual([]);
  });

  test('a record identifier does not make a known route look new', () => {
    // The surface holds /claims/clm-0001/settle; the page declares it for a different claim.
    const unseen = controlsTheSurfaceDoesNotHold(
      '/claims/clm-0009',
      [{ address: '/claims/clm-0009/settle', name: 'Settle' }],
      [target('/claims/clm-0001/settle', 'endpoint')]
    );

    expect(unseen).toEqual([]);
  });

  test('a sampleUrl counts as held, since that is the address a check would issue', () => {
    const withSample = {
      ...target('/approve.asp', 'endpoint'), sampleUrl: '/approve.asp?id=1'
    } as SecurityTarget;

    const unseen = controlsTheSurfaceDoesNotHold(
      '/list.asp', [{ address: '/approve.asp?id=1', name: 'Approve' }], [withSample]);

    expect(unseen).toEqual([]);
  });

  test('two routes are two gaps, and one route twice is one gap', () => {
    const unseen = controlsTheSurfaceDoesNotHold('/claims', [
      { address: '/claims/clm-0001/settle', name: 'Settle' },
      { address: '/claims/clm-0002/settle', name: 'Settle' },
      { address: '/claims/clm-0001/reject', name: 'Reject' }
    ], [target('/claims')]);

    expect(unseen.map(u => u.address)).toEqual([
      '/claims/clm-0001/settle', '/claims/clm-0001/reject'
    ]);
  });
});

describe('unseenControlGap', () => {
  test('names the address, the control and the identity that could see it', () => {
    const sentence = unseenControlGap(
      { address: '/claims/clm-0001/settle', declaredOn: '/claims/clm-0001', name: 'Settle' },
      'administrator');

    expect(sentence).toContain('/claims/clm-0001/settle');
    expect(sentence).toContain('"Settle"');
    expect(sentence).toContain('administrator');
    expect(sentence).toContain('/claims/clm-0001');
    // And says why, because a gap nobody can act on is noise.
    expect(sentence).toContain('maps an application as one identity');
  });

  test('reads sensibly when the control carries no name', () => {
    const sentence = unseenControlGap(
      { address: '/x/y', declaredOn: '/x', name: null }, 'administrator');

    expect(sentence).toContain('/x/y');
    expect(sentence).not.toContain('("");');
  });
});

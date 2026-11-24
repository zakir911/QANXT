import { describe, expect, it } from 'vitest';
import {
  byRole, owner, intruder, privileged, readOnly,
  type ScanContext, type SignedInIdentity
} from '../src/security/security-handler.js';
import { Logger } from '../src/util/logger.js';

/**
 * Which identity plays which part in a comparison.
 *
 * Two of the four resolvers went by position rather than by the role the caller declared.
 * `privileged` and `readOnly` matched on role — one of them had already been fixed once for
 * only recognising "admin" when the documentation said "privileged" — and `owner` and
 * `intruder` were left taking whatever came first and second.
 *
 * The freight launcher sends privileged, owner, readonly in that order, which is the order
 * its own documentation uses. So `owner` returned the administrator, and authz.vertical, which
 * asks for the privileged identity and a lesser one, got the administrator twice. It compared
 * him with himself across five targets and said "both reach this route" — inconclusive,
 * plausible, and incapable of ever failing.
 *
 * These tests use that exact role list, because a fixture with roles in a convenient order
 * would not have caught it.
 */
const identity = (label: string, role?: string): SignedInIdentity => ({
  label, username: label, password: 'pw', role,
  headers: { cookie: `session=${label}` }, cookie: `session=${label}`, csrf: null
});

/** The identities the freight launcher declares, in the order it declares them. */
const asDeclared = (...people: SignedInIdentity[]): ScanContext => ({
  baseUrl: 'http://127.0.0.1:4400',
  identities: new Map(people.map(p => [p.label, p])),
  logger: new Logger('error', {}, () => {}),
  browser: null
});

const freight = () => asDeclared(
  identity('administrator', 'privileged'),
  identity('operations', 'owner'),
  identity('audit viewer', 'readonly'));

describe('resolving an identity by the role the caller declared', () => {
  it('the owner is the identity declared as the owner, not the first one sent', () => {
    expect(owner(freight())?.label).toBe('operations');
  });

  it('the privileged identity and the lesser one are never the same person', () => {
    const context = freight();
    expect(privileged(context)?.label).toBe('administrator');
    expect(owner(context)?.label).not.toBe(privileged(context)?.label);
  });

  it('the intruder is somebody other than the owner', () => {
    const context = freight();
    const first = owner(context);
    const second = intruder(context);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it('the read-only identity is found by any of its spellings', () => {
    expect(readOnly(asDeclared(identity('a', 'read-only')))?.label).toBe('a');
    expect(readOnly(asDeclared(identity('b', 'viewer')))?.label).toBe('b');
    expect(readOnly(asDeclared(identity('c', 'readonly')))?.label).toBe('c');
  });

  it('the privileged identity is found by any of its spellings', () => {
    expect(privileged(asDeclared(identity('a', 'admin')))?.label).toBe('a');
    expect(privileged(asDeclared(identity('b', 'administrator')))?.label).toBe('b');
    expect(privileged(asDeclared(identity('c', 'privileged')))?.label).toBe('c');
  });

  it('falls back to position when no role is declared at all', () => {
    // Callers that send bare credentials must keep working; the roles are a refinement, not a
    // new requirement.
    const context = asDeclared(identity('first'), identity('second'));
    expect(owner(context)?.label).toBe('first');
    expect(intruder(context)?.label).toBe('second');
  });

  it('a single identity yields no second one to compare against', () => {
    const context = asDeclared(identity('only', 'owner'));
    expect(owner(context)?.label).toBe('only');
    expect(intruder(context)).toBeUndefined();
  });

  it('byRole ignores an identity whose role was never set', () => {
    const context = asDeclared(identity('nameless'), identity('known', 'owner'));
    expect(byRole(context, 'owner')?.label).toBe('known');
  });
});

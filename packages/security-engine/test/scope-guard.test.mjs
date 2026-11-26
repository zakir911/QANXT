import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DENIAL, SECURITY_PROFILE, SECURITY_RISK, evaluateScope, labScope, matchesAllowlist, pathMatches
} from '../src/scope-guard.mjs';

/**
 * The guard that decides whether a probe may be issued at all.
 *
 * Nothing else in this product matters if this is wrong. It is what stands between a check
 * that wants to send a DELETE and somebody's live data, and it is the rule the whole product
 * is built around: a verb may *raise* the risk a check declared and never lower it, and
 * destructive testing happens only on an authorisation somebody actually gave.
 *
 * It had **no test file of its own**. Its 31.6% line coverage came incidentally, from other
 * tests happening to call `authorize()` on their way to something else, so the suite was
 * green while two thirds of the ladder had never been exercised. Every safety claim made for
 * this product rested on that.
 *
 * These tests walk the ladder rung by rung, and each one asserts a *refusal* as well as a
 * permission — a guard that cannot be shown to say no is not a guard.
 */

/** A scope that permits as much as a scope can, so each test can take one thing away. */
const permissive = (overrides = {}) => ({
  enabled: true,
  authorizationNote: 'Signed off by the application owner on 2026-11-26.',
  allowedDomains: ['app.test'],
  allowedApiDomains: [],
  allowedPaths: [],
  blockedPaths: [],
  allowActiveTesting: true,
  allowDestructiveTesting: true,
  allowProduction: false,
  maxRequestsPerSecond: 0,
  maxConcurrentRequests: 0,
  maxScanDurationMinutes: 0,
  ...overrides
});

const ask = (scope, request = {}, context = {}) => evaluateScope(scope, {
  url: 'https://app.test/orders', method: 'GET',
  risk: SECURITY_RISK.PASSIVE, profile: SECURITY_PROFILE.STANDARD,
  ...request
}, context);

// ---- authorisation -------------------------------------------------------------------

test('no scope at all is a refusal: the absence of a restriction is not permission', () => {
  const outcome = evaluateScope(null, { url: 'https://app.test/x', method: 'GET' });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.SCOPE_MISSING);
  assert.match(outcome.explanation, /not permission/);
});

test('a scope that exists but is switched off permits nothing', () => {
  const outcome = ask(permissive({ enabled: false }));

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.SCOPE_DISABLED);
});

test('a scope with no written authorisation permits nothing, however else it is configured', () => {
  const outcome = ask(permissive({ authorizationNote: '' }));

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.SCOPE_MISSING);
  assert.match(outcome.explanation, /no written authorization/);
});

test('nothing is reported as passed when the refusal comes before the first rung', () => {
  assert.deepEqual(ask(permissive({ enabled: false })).checksPassed, []);
});

// ---- what is never a target ----------------------------------------------------------

test('a URL that is not absolute is refused rather than guessed at', () => {
  const outcome = ask(permissive(), { url: '/orders' });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.DOMAIN_NOT_ALLOWED);
  assert.match(outcome.explanation, /not absolute/);
});

test('only http and https are addresses this will issue a request to', () => {
  for (const url of ['file:///etc/passwd', 'ftp://app.test/x', 'gopher://app.test/']) {
    const outcome = ask(permissive(), { url });
    assert.equal(outcome.allowed, false, url);
    assert.equal(outcome.reason, DENIAL.DOMAIN_NOT_ALLOWED, url);
  }
});

test('the cloud metadata addresses are never a target, whatever the scope says', () => {
  // A scanner that quietly pulls credentials out of an instance profile has done real harm
  // in the course of proving it could. No allowlist opens these.
  for (const host of ['169.254.169.254', 'metadata.google.internal', 'metadata.goog',
                      'instance-data']) {
    const outcome = ask(permissive({ allowedDomains: [host] }), { url: `http://${host}/latest/` });
    assert.equal(outcome.allowed, false, host);
    assert.equal(outcome.reason, DENIAL.DOMAIN_NOT_ALLOWED, host);
    assert.match(outcome.explanation, /never a legitimate target/, host);
  }
});

test('the whole 169.254 link-local range is refused, not only the one famous address', () => {
  const outcome = ask(permissive({ allowedDomains: ['169.254.1.1'] }),
                      { url: 'http://169.254.1.1/' });

  assert.equal(outcome.allowed, false);
  assert.match(outcome.explanation, /never a legitimate target/);
});

// ---- the host allowlist --------------------------------------------------------------

test('an empty allowlist permits nothing, which is the opposite of permitting everything', () => {
  const outcome = ask(permissive({ allowedDomains: [] }));

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.DOMAIN_NOT_ALLOWED);
  assert.match(outcome.explanation, /permits nothing/);
});

test('a host not on the list is refused and the refusal names it', () => {
  const outcome = ask(permissive(), { url: 'https://elsewhere.test/orders' });

  assert.equal(outcome.allowed, false);
  assert.match(outcome.explanation, /elsewhere\.test/);
});

test('an api request uses the api allowlist when the scope names one', () => {
  const scope = permissive({ allowedDomains: ['app.test'], allowedApiDomains: ['api.test'] });

  assert.equal(ask(scope, { url: 'https://api.test/v1/orders', isApiRequest: true }).allowed, true);
  // And the page allowlist does not quietly cover the API host, nor the reverse.
  assert.equal(ask(scope, { url: 'https://app.test/x', isApiRequest: true }).allowed, false);
});

test('an api request falls back to the page allowlist when no api list is given', () => {
  const scope = permissive({ allowedDomains: ['app.test'], allowedApiDomains: [] });

  assert.equal(ask(scope, { url: 'https://app.test/api/orders', isApiRequest: true }).allowed, true);
});

test('matchesAllowlist: a leading dot covers subdomains and the bare domain, nothing else', () => {
  assert.equal(matchesAllowlist('shop.app.test', ['.app.test']), true);
  assert.equal(matchesAllowlist('app.test', ['.app.test']), true);
  assert.equal(matchesAllowlist('app.test.evil.test', ['.app.test']), false);
  // Not a suffix match on an unrelated name that merely ends the same way.
  assert.equal(matchesAllowlist('notapp.test', ['app.test']), false);
});

test('matchesAllowlist ignores case and blank entries, and an empty list matches nothing', () => {
  assert.equal(matchesAllowlist('APP.test', ['app.TEST']), true);
  assert.equal(matchesAllowlist('app.test', ['', '  ', 'app.test']), true);
  assert.equal(matchesAllowlist('app.test', []), false);
  assert.equal(matchesAllowlist('app.test', undefined), false);
});

// ---- paths ----------------------------------------------------------------------------

test('a blocked path is refused even when everything else permits it', () => {
  const outcome = ask(permissive({ blockedPaths: ['/admin/*'] }),
                      { url: 'https://app.test/admin/users' });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PATH_BLOCKED);
  assert.match(outcome.explanation, /\/admin\/\*/);
});

test('blocked wins over allowed, so a path on both lists is refused', () => {
  const outcome = ask(permissive({ allowedPaths: ['/*'], blockedPaths: ['/admin/*'] }),
                      { url: 'https://app.test/admin/users' });

  assert.equal(outcome.reason, DENIAL.PATH_BLOCKED);
});

test('an allowed-path list, once given, excludes everything it does not name', () => {
  const scope = permissive({ allowedPaths: ['/orders'] });

  assert.equal(ask(scope, { url: 'https://app.test/orders' }).allowed, true);
  assert.equal(ask(scope, { url: 'https://app.test/admin' }).reason, DENIAL.PATH_NOT_ALLOWED);
});

test('pathMatches: a bare pattern covers the path and what sits under it', () => {
  assert.equal(pathMatches('/orders', '/orders'), true);
  assert.equal(pathMatches('/orders/42', '/orders'), true);
  // Not a different route that merely starts with the same letters.
  assert.equal(pathMatches('/ordersummary', '/orders'), false);
});

test('pathMatches: the wildcard forms behave as a reader would expect', () => {
  assert.equal(pathMatches('/anything', '*'), true);
  assert.equal(pathMatches('/anything', '/*'), true);
  assert.equal(pathMatches('/admin', '/admin/*'), true);
  assert.equal(pathMatches('/admin/users', '/admin/*'), true);
  assert.equal(pathMatches('/administration', '/admin/*'), false);
  assert.equal(pathMatches('/admin-tools', '/admin*'), true);
});

test('pathMatches: an empty pattern matches nothing rather than everything', () => {
  // The dangerous default. A blank entry in a blocklist must not block the application, and
  // a blank entry in an allowlist must not open it.
  assert.equal(pathMatches('/orders', ''), false);
  assert.equal(pathMatches('/orders', '   '), false);
  assert.equal(pathMatches('/orders', null), false);
  assert.equal(pathMatches('/orders', undefined), false);
});

test('pathMatches ignores case, because a URL path on many servers does', () => {
  assert.equal(pathMatches('/Orders/42', '/orders'), true);
});

// ---- the verb may raise the risk, never lower it --------------------------------------

test('a request with no method is refused', () => {
  const outcome = ask(permissive(), { method: '  ' });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.METHOD_NOT_ALLOWED);
});

test('a POST is state-changing however passively the check described itself', () => {
  // The rule the product is built around. A check that declares its request merely passive
  // while sending a POST is describing a mutation, and the guard must not wave it through on
  // an authorisation nobody gave.
  const outcome = ask(permissive({ allowActiveTesting: false }),
                      { method: 'POST', risk: SECURITY_RISK.PASSIVE });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.ACTIVE_NOT_ALLOWED);
});

test('a DELETE is destructive however passively the check described itself', () => {
  // On a profile that would otherwise permit it, so the rung being tested is the scope's
  // destructive switch rather than the profile's ceiling.
  const outcome = ask(permissive({ allowDestructiveTesting: false }),
                      { method: 'DELETE', risk: SECURITY_RISK.PASSIVE,
                        profile: SECURITY_PROFILE.DEEP });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.DESTRUCTIVE_NOT_ALLOWED);
  assert.match(outcome.explanation, /DELETE/);
});

test('the profile ceiling is consulted before the scope switch, so standard refuses first', () => {
  // Worth pinning because the two refusals mean different things to whoever reads the report:
  // "your profile does not run this" is a setting on the scan, and "the scope does not permit
  // it" is an authorisation the application's owner has to give. A DELETE on the standard
  // profile is the first, not the second, even with destructive testing switched off.
  const outcome = ask(permissive({ allowDestructiveTesting: false }),
                      { method: 'DELETE', profile: SECURITY_PROFILE.STANDARD });

  assert.equal(outcome.reason, DENIAL.PROFILE_DOES_NOT_PERMIT);
});

test('every mutating verb raises the risk to state-changing at least', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const outcome = ask(permissive({ allowActiveTesting: false }),
                        { method, risk: SECURITY_RISK.PASSIVE });
    assert.equal(outcome.allowed, false, method);
  }
});

test('a GET does not raise the risk, so a declared passive read stays passive', () => {
  assert.equal(ask(permissive({ allowActiveTesting: false }),
                   { method: 'GET', risk: SECURITY_RISK.PASSIVE }).allowed, true);
});

test('a high declared risk is not lowered by a safe verb', () => {
  // The other half of the rule. A check that knows its GET is destructive - because of what
  // the address does rather than the verb - is believed. permits-legacy approves a permit
  // through a GET, which is exactly this case.
  const outcome = ask(permissive({ allowDestructiveTesting: false }),
                      { method: 'GET', risk: SECURITY_RISK.DESTRUCTIVE,
                        profile: SECURITY_PROFILE.DEEP });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.DESTRUCTIVE_NOT_ALLOWED);
});

// ---- profiles -------------------------------------------------------------------------

test('the passive profile runs passive requests and refuses everything above them', () => {
  const scope = permissive();
  assert.equal(ask(scope, { profile: SECURITY_PROFILE.PASSIVE, risk: SECURITY_RISK.PASSIVE }).allowed, true);
  for (const risk of [SECURITY_RISK.ACTIVE, SECURITY_RISK.STATE_CHANGING, SECURITY_RISK.DESTRUCTIVE]) {
    const outcome = ask(scope, { profile: SECURITY_PROFILE.PASSIVE, risk });
    assert.equal(outcome.reason, DENIAL.PROFILE_DOES_NOT_PERMIT, String(risk));
  }
});

test('standard and regression stop below destructive', () => {
  for (const profile of [SECURITY_PROFILE.STANDARD, SECURITY_PROFILE.REGRESSION]) {
    assert.equal(ask(permissive(), { profile, risk: SECURITY_RISK.STATE_CHANGING }).allowed, true, profile);
    assert.equal(ask(permissive(), { profile, risk: SECURITY_RISK.DESTRUCTIVE }).reason,
                 DENIAL.PROFILE_DOES_NOT_PERMIT, profile);
  }
});

test('deep and custom permit every risk level the scope itself allows', () => {
  for (const profile of [SECURITY_PROFILE.DEEP, SECURITY_PROFILE.CUSTOM]) {
    assert.equal(ask(permissive(), { profile, risk: SECURITY_RISK.DESTRUCTIVE }).allowed, true, profile);
  }
});

test('a profile nobody recognises permits nothing', () => {
  // Deny by default: a typo in a profile name must not open the ladder.
  const outcome = ask(permissive(), { profile: 'thorough', risk: SECURITY_RISK.PASSIVE });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PROFILE_DOES_NOT_PERMIT);
});

// ---- who is asking --------------------------------------------------------------------

test('an account permitted only passive scans cannot run an active one', () => {
  const outcome = ask(permissive(), { risk: SECURITY_RISK.ACTIVE },
                      { callerMayRunActiveScans: false });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PERMISSION_DENIED);
});

test('an account not permitted destructive scans cannot run one, scope or no scope', () => {
  const outcome = ask(permissive(), { risk: SECURITY_RISK.DESTRUCTIVE, profile: SECURITY_PROFILE.DEEP },
                      { callerMayRunDestructiveScans: false });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PERMISSION_DENIED);
});

test('an unstated permission is not a refusal, because absent is not false here', () => {
  // The context comes from the platform; a caller that says nothing about permissions is not
  // the same as one that says no.
  assert.equal(ask(permissive(), { risk: SECURITY_RISK.ACTIVE }, {}).allowed, true);
});

// ---- environments ---------------------------------------------------------------------

test('a scan naming a different environment from the authorised one is refused', () => {
  const outcome = ask(permissive({ environmentId: 'staging' }), { environmentId: 'production' });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PRODUCTION_NOT_AUTHORIZED);
});

test('production is refused unless the scope authorises it', () => {
  const outcome = ask(permissive({ allowProduction: false }), {}, { isProductionEnvironment: true });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PRODUCTION_NOT_AUTHORIZED);
});

test('production needs the environment authorised too, not only the scope', () => {
  const outcome = ask(permissive({ allowProduction: true }), {},
                      { isProductionEnvironment: true, productionTestingAuthorized: false });

  assert.equal(outcome.allowed, false);
  assert.match(outcome.explanation, /environment itself/);
});

test('a state-changing test is never run against production, whatever is authorised', () => {
  // The one rung with no override. Both switches on, the account permitted, and it is still
  // refused.
  const outcome = ask(permissive({ allowProduction: true }),
                      { risk: SECURITY_RISK.STATE_CHANGING },
                      { isProductionEnvironment: true, productionTestingAuthorized: true });

  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, DENIAL.PRODUCTION_NOT_AUTHORIZED);
  assert.match(outcome.explanation, /never run against production/);
});

test('a passive read of production is permitted once both authorisations are in place', () => {
  const outcome = ask(permissive({ allowProduction: true }), { risk: SECURITY_RISK.PASSIVE },
                      { isProductionEnvironment: true, productionTestingAuthorized: true });

  assert.equal(outcome.allowed, true);
});

// ---- the limits that stop a scan becoming a load test ---------------------------------

test('the per-second limit refuses at the limit, not one request past it', () => {
  const scope = permissive({ maxRequestsPerSecond: 5 });

  assert.equal(ask(scope, {}, { requestsInLastSecond: 4 }).allowed, true);
  assert.equal(ask(scope, {}, { requestsInLastSecond: 5 }).reason, DENIAL.RATE_LIMIT);
});

test('the concurrency limit refuses at the limit', () => {
  const scope = permissive({ maxConcurrentRequests: 2 });

  assert.equal(ask(scope, {}, { requestsInFlight: 1 }).allowed, true);
  assert.equal(ask(scope, {}, { requestsInFlight: 2 }).reason, DENIAL.CONCURRENCY_LIMIT);
});

test('the duration limit ends the scan at the limit', () => {
  const scope = permissive({ maxScanDurationMinutes: 30 });

  assert.equal(ask(scope, {}, { scanElapsedMinutes: 29 }).allowed, true);
  assert.equal(ask(scope, {}, { scanElapsedMinutes: 30 }).reason, DENIAL.DURATION_EXCEEDED);
});

test('a zero limit means no limit, and an absent count is treated as none', () => {
  const scope = permissive({ maxRequestsPerSecond: 0, maxConcurrentRequests: 0,
                             maxScanDurationMinutes: 0 });

  assert.equal(ask(scope, {}, { requestsInLastSecond: 9999, requestsInFlight: 99,
                                scanElapsedMinutes: 9999 }).allowed, true);
  assert.equal(ask(permissive({ maxRequestsPerSecond: 5 }), {}, {}).allowed, true);
});

// ---- the ladder itself ----------------------------------------------------------------

test('a permitted request reports every rung it passed, in order', () => {
  // The order is the contract this implementation shares with the platform's own guard. A
  // change to one that is not made to the other should fail a test rather than quietly widen
  // what the engine will do.
  const outcome = ask(permissive());

  assert.equal(outcome.allowed, true);
  assert.equal(outcome.reason, DENIAL.NONE);
  assert.deepEqual(outcome.checksPassed,
    ['authorization', 'target-policy', 'domain', 'path', 'method', 'risk', 'environment', 'rate']);
});

test('a refusal reports the rungs it did pass, so a reader can see where it stopped', () => {
  const outcome = ask(permissive({ blockedPaths: ['/admin'] }), { url: 'https://app.test/admin' });

  assert.deepEqual(outcome.checksPassed, ['authorization', 'target-policy', 'domain']);
});

// ---- the lab scope --------------------------------------------------------------------

test('the lab scope names the hosts it needs and nothing else', () => {
  const scope = labScope();

  assert.equal(scope.enabled, true);
  assert.ok(scope.authorizationNote);
  assert.deepEqual(scope.allowedDomains, ['127.0.0.1', 'localhost']);
  assert.equal(matchesAllowlist('example.test', scope.allowedDomains), false);
});

test('the lab scope honours an override, which it once silently swallowed', () => {
  // It briefly took an unused first argument, so labScope({ allowDestructiveTesting: true })
  // returned the default and the caller got a refusal it could not account for.
  assert.equal(labScope({ allowDestructiveTesting: true }).allowDestructiveTesting, true);
  assert.equal(labScope().allowDestructiveTesting, false);
});

/**
 * The security engine's public surface.
 *
 * A barrel exists so consumers name the engine rather than its files: the worker imports
 * `@aira/security-engine`, the golden suites import the same modules by path, and neither
 * depends on where a particular check happens to live today.
 */
export { SecurityScanner } from './engine.mjs';
export {
  DENIAL, SECURITY_PROFILE, SECURITY_RISK,
  evaluateScope, labScope, matchesAllowlist, pathMatches
} from './scope-guard.mjs';
export { MAX_SCORE, SEVERITY_BANDS, CONFIDENCE_LEVELS, SeverityFactors, confidenceFrom } from './severity.mjs';
export {
  REDACTED, redactBody, redactHeaders, redactText, writeFindingEvidence
} from './evidence.mjs';
export {
  CONFIDENCE_ORDER, DEFAULT_POLICY, OUTCOME, OUTCOME_NAME, SEVERITY_ORDER,
  evaluateSecurityGate
} from './gate.mjs';
export {
  TRIAGE_STATUSES, compareToBaseline, fingerprint, suppressionApplies, triage
} from './regression.mjs';

export * as authz from './checks-authz.mjs';
export * as auth from './checks-auth.mjs';
export * as api from './checks-api.mjs';
export * as xss from './checks-xss.mjs';
export * as injection from './checks-injection.mjs';
export * as request from './checks-request.mjs';
export * as passive from './checks-passive.mjs';

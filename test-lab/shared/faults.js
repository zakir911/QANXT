/**
 * The fault engine every lab application shares.
 *
 * A fault is a named, independently settable deviation from correct behaviour. Nothing in
 * an application's source is edited to produce one: the application asks this engine what
 * is currently enabled and behaves accordingly, so the same build serves both the healthy
 * and the broken case. That matters because a verification run must be able to prove that
 * a defect was injected into the *same* application that passed a moment earlier.
 *
 * Three ways to set a fault, in ascending precedence:
 *   1. environment   FAULT_LOGIN_BUTTON_RENAMED=true node server.js
 *   2. admin API     POST /__faults {"FAULT_LOGIN_BUTTON_RENAMED": true}
 *   3. reset         POST /__faults/reset            (everything back to false)
 *
 * `GET /__faults` returns the whole registry, which is how a test discovers what can be
 * broken rather than keeping its own list. A hard-coded list silently stops covering a
 * fault the moment one is added, and a leftover fault contaminates the next test in a way
 * that looks exactly like a product defect.
 */

/** Faults understood by more than one application. */
export const COMMON_FAULTS = [
  { id: 'FAULT_LOGIN_BUTTON_RENAMED', description: 'The sign-in control is relabelled "Sign In" and its test id changes.' },
  { id: 'FAULT_LOGIN_BUTTON_REMOVED', description: 'The sign-in control is not rendered at all.' },
  { id: 'FAULT_API_500', description: 'The sign-in API answers HTTP 500.' },
  { id: 'FAULT_API_TIMEOUT', description: 'The sign-in API never answers within a reasonable timeout.' },
  { id: 'FAULT_WRONG_BALANCE', description: 'The dashboard renders a balance that does not match the accounts.' },
  { id: 'FAULT_STATEMENT_FAILURE', description: 'Statement generation fails.' },
  { id: 'FAULT_INVALID_VALIDATION', description: 'A validation message states a rule the form does not apply.' },
  { id: 'FAULT_DYNAMIC_LOCATOR', description: 'Element test ids are regenerated per session.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'A key element appears only after a long delay.' },
  { id: 'FAULT_JS_ERROR', description: 'The page throws an uncaught JavaScript error.' },
  { id: 'FAULT_NETWORK_ERROR', description: 'A request is destroyed at the network layer.' }
];

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function createFaultEngine(catalogue, options = {}) {
  const registry = new Map();
  for (const entry of catalogue) {
    const fromEnvironment = process.env[entry.id];
    registry.set(entry.id, {
      ...entry,
      enabled: fromEnvironment === undefined ? false : TRUTHY.has(String(fromEnvironment).toLowerCase())
    });
  }

  /** Numeric knobs a fault needs (a delay, a status code), settable the same way. */
  const parameters = { slowElementMs: 6000, apiTimeoutMs: 30_000, ...options.parameters };

  const engine = {
    /** True when the named fault is active. Unknown ids are false, never an error. */
    on(id) {
      return registry.get(id)?.enabled === true;
    },
    parameter(name) {
      return parameters[name];
    },
    list() {
      return [...registry.values()].map(({ id, description, enabled }) => ({ id, description, enabled }));
    },
    state() {
      return Object.fromEntries([...registry.values()].map(entry => [entry.id, entry.enabled]));
    },
    /** Applies a patch. Unknown ids are reported rather than silently ignored. */
    set(patch) {
      const applied = [];
      const unknown = [];
      for (const [key, value] of Object.entries(patch ?? {})) {
        if (key in parameters) {
          parameters[key] = Number(value);
          applied.push(key);
          continue;
        }
        const entry = registry.get(key);
        if (!entry) { unknown.push(key); continue; }
        entry.enabled = value === true || TRUTHY.has(String(value).toLowerCase());
        applied.push(key);
      }
      return { applied, unknown };
    },
    reset() {
      for (const entry of registry.values()) entry.enabled = false;
      parameters.slowElementMs = 6000;
      parameters.apiTimeoutMs = 30_000;
      return engine.state();
    }
  };

  return engine;
}

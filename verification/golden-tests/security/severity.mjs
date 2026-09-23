/**
 * The severity model, in JavaScript.
 *
 * Mirrors `SeverityFactors` in the Application layer, including the weights and the band
 * boundaries, so a finding produced by a golden suite and one produced by the platform read
 * the same. The C# side has the thirteen tests that pin real vulnerability classes; the
 * parity test in the security suite asserts these two agree, which is what stops them
 * drifting into two different opinions wearing the same word.
 */
const EXPLOITABILITY = { theoretical: 0, difficult: 1, straightforward: 2, trivial: 3 };
const IMPACT = { minimal: 0, limited: 1, serious: 2, severe: 3 };
const PRIVILEGE = { administrator: 0, authenticatedUser: 1, none: 2 };
const DATA = { none: 0, nonSensitive: 1, personalData: 2, credentials: 3 };
const EXPOSURE = { internalOnly: 0, authenticatedUsers: 1, public: 2 };

/** 3×2 + 3×2 + 2 + 3 + 2. Named because getting it wrong once already moved every band. */
export const MAX_SCORE = 19;

export class SeverityFactors {
  constructor(exploitability, impact, privilegeRequired, affectedData, exposure,
              requiresUnusualConditions = false) {
    for (const [name, value, table] of [
      ['exploitability', exploitability, EXPLOITABILITY], ['impact', impact, IMPACT],
      ['privilegeRequired', privilegeRequired, PRIVILEGE], ['affectedData', affectedData, DATA],
      ['exposure', exposure, EXPOSURE]
    ]) {
      if (!(value in table)) {
        throw new Error(`${name}="${value}" is not one of ${Object.keys(table).join(', ')}`);
      }
    }
    this.exploitability = exploitability;
    this.impact = impact;
    this.privilegeRequired = privilegeRequired;
    this.affectedData = affectedData;
    this.exposure = exposure;
    this.requiresUnusualConditions = requiresUnusualConditions;
  }

  get score() {
    const score = EXPLOITABILITY[this.exploitability] * 2
                + IMPACT[this.impact] * 2
                + PRIVILEGE[this.privilegeRequired]
                + DATA[this.affectedData]
                + EXPOSURE[this.exposure]
                - (this.requiresUnusualConditions ? 3 : 0);
    return Math.max(0, score);
  }

  get severity() {
    const s = this.score;
    if (s >= 16) return 'Critical';
    if (s >= 12) return 'High';
    if (s >= 8) return 'Medium';
    if (s >= 4) return 'Low';
    return 'Informational';
  }

  explain() {
    const privilege = { none: 'no account needed', authenticatedUser: 'any signed-in user', administrator: 'administrator only' }[this.privilegeRequired];
    const data = { none: 'no data', nonSensitive: 'non-sensitive data', personalData: 'personal data', credentials: 'credentials' }[this.affectedData];
    const exposure = { public: 'publicly reachable', authenticatedUsers: 'reachable by signed-in users', internalOnly: 'internal only' }[this.exposure];
    return `${this.severity} (${this.score}/${MAX_SCORE}): ${this.exploitability} to exploit, `
      + `${this.impact} impact, ${privilege}, reaches ${data}, ${exposure}`
      + (this.requiresUnusualConditions ? ', but needs conditions the attacker does not control' : '')
      + '.';
  }

  toJSON() {
    return {
      exploitability: this.exploitability, impact: this.impact,
      privilegeRequired: this.privilegeRequired, affectedData: this.affectedData,
      exposure: this.exposure, requiresUnusualConditions: this.requiresUnusualConditions,
      score: this.score, maxScore: MAX_SCORE, severity: this.severity, explanation: this.explain()
    };
  }
}

/**
 * Confidence, which is a different question from severity and is computed from different
 * things: was it reproduced, did a second signal agree, does the evidence admit another
 * reading. A single unreproduced indicator is Low however alarming it looks.
 */
export function confidenceFrom({ reproduced = false, corroborated = false, unambiguous = false }) {
  if (reproduced && unambiguous) return 'High';
  if (reproduced || corroborated) return 'Medium';
  return 'Low';
}

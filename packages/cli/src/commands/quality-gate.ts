import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';
import type { QualityGateResult } from '../types.js';

export const QUALITY_GATE_FLAGS = ['run-id', 'json'] as const;

export const QUALITY_GATE_HELP = `
${bold('qanxt quality-gate')} — evaluate a finished run against its project's gate

  qanxt quality-gate --run-id <id>
  qanxt quality-gate <id>

  --run-id <id>          The run to evaluate (or the first positional argument)
  --json                 Emit the gate result on stdout

Exit status: 0 PASS · 2 FAIL · 7 REVIEW
A run whose tests failed is still reported here by its gate outcome; use "qanxt run" or
"qanxt status" if you want the test verdict to decide the status instead.
`;

/**
 * Asks the platform for a gate decision and turns it into an exit status.
 *
 * The decision is the platform's, not the CLI's: the same rules, metrics and outcome a
 * report or the console would show. That matters for reproducibility — a gate that decided
 * one thing in a pipeline and another in the console would be worthless.
 */
export async function qualityGateCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, QUALITY_GATE_FLAGS);

  const runId = flag(args, 'run-id') ?? args.positionals[0];
  if (!runId) {
    throw usage('A run id is required.', 'qanxt quality-gate --run-id <id>');
  }

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token')
  });
  const api = new ApiClient(context.apiUrl, context.token);

  const gate = await api.get<QualityGateResult>(`/api/v1/testruns/${runId}/quality-gate`);

  if (boolFlag(args, 'json')) {
    out(JSON.stringify(gate, null, 2));
  } else {
    printGate(gate);
  }

  const outcome = gate.outcome ?? (gate.passed ? 'pass' : 'fail');
  if (outcome === 'fail') return ExitCode.QualityGateFailure;
  if (outcome === 'review') return ExitCode.HumanReviewRequired;
  return ExitCode.Success;
}

function printGate(gate: QualityGateResult): void {
  const outcome = gate.outcome ?? (gate.passed ? 'pass' : 'fail');
  const label = outcome === 'pass' ? green('PASS') : outcome === 'review' ? yellow('REVIEW') : red('FAIL');

  note(`\n${bold('Quality gate')} ${label}`);
  note(gate.summary);

  if (gate.rules.length > 0) {
    note('');
    for (const rule of gate.rules) {
      const mark = rule.passed ? green('✓') : rule.action === 'review' ? yellow('?') : red('✗');
      note(`  ${mark} ${rule.name}`);
      note(`    ${dim(rule.explanation)}`);
    }
  }

  // Printed even when the outcome is PASS: a healed test that a policy lets through still
  // has to be visible, which is the whole point of separating REVIEW from FAIL.
  if (gate.reviewReasons && gate.reviewReasons.length > 0) {
    note(`\n${bold('Needs a person to look at')}`);
    for (const reason of gate.reviewReasons) note(`  · ${reason}`);
  }
}

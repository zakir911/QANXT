import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';

export const SECURITY_FLAGS = [
  'application-id', 'scan-id', 'status', 'take', 'json', 'finding-id', 'reason'
] as const;

export const SECURITY_HELP = `
${bold('aira security')} — security scopes, scans and findings

  aira security scope --application-id <id>
  aira security scans --application-id <id> [--take 10]
  aira security findings --application-id <id> [--status confirmed]
  aira security gate --scan-id <id>
  aira security triage --finding-id <id> --status <status> --reason "<why>"

  --application-id <id>  The application
  --scan-id <id>         A recorded scan
  --finding-id <id>      A finding
  --status <status>      potential | confirmed | falsePositive | needsReview
                         | resolved | regressed | accepted
  --reason "<text>"      Why. Required to mark a finding false positive,
                         accepted or resolved, and it has to say something
  --take <n>             How many scans to list (default 10)
  --json                 Emit the raw result on stdout

Exit status: 0 PASS · 2 FAIL · 6 SECURITY_POLICY_VIOLATION · 7 REVIEW

${dim('"aira security gate" is the one a pipeline runs. It exits 2 when the gate blocks and 7')}
${dim('when a person has to look — and a build that was never scanned is 7, never 0. "No scan')}
${dim('ran" is not the same as "a scan ran and found nothing", and this will not report it as')}
${dim('though it were.')}
`;

interface SecurityGateRule { name: string; passed: boolean; measured: boolean; explanation: string; }
interface SecurityGateResult {
  outcome: string; summary: string; blocked: boolean;
  rules: SecurityGateRule[]; reasons: string[];
}
interface SecurityFinding {
  id: string; reference: string; category: string; title: string;
  severity: string; confidence: string; status: string;
  cwe?: string | null; owaspWebCategory?: string | null;
  endpoint?: string | null; isNew: boolean; isRegression: boolean;
  dispositionNote?: string | null;
}
interface SecurityScan {
  id: string; reference: string; profile: string; status: string;
  requestsIssued: number; requestsBlocked: number;
  testsExecuted: number; testsSkipped: number;
  startedAt: string; findings: SecurityFinding[]; gate: SecurityGateResult;
}

export async function securityCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, SECURITY_FLAGS);

  const action = args.positionals[0];
  if (!action) {
    throw usage('A security subcommand is required.',
      'aira security scope | scans | findings | gate | triage');
  }

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token')
  });
  const api = new ApiClient(context.apiUrl, context.token);
  const json = boolFlag(args, 'json');

  switch (action) {
    case 'scope': return scope(api, args, json);
    case 'scans': return scans(api, args, json);
    case 'findings': return findings(api, args, json);
    case 'gate': return gate(api, args, json);
    case 'triage': return triage(api, args, json);
    default:
      throw usage(`Unknown security subcommand "${action}".`,
        'aira security scope | scans | findings | gate | triage');
  }
}

function requireApplicationId(args: ParsedArgs): string {
  const id = flag(args, 'application-id') ?? args.positionals[1];
  if (!id) throw usage('An application id is required.', 'aira security scope --application-id <id>');
  return id;
}

async function scope(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const applicationId = requireApplicationId(args);
  const result = await api.get<Record<string, unknown>>(
    `/api/v1/security/applications/${applicationId}/scope`);

  if (json) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }

  note(`\n${bold('Security scope')} ${result.enabled ? green('enabled') : red('disabled')}`);
  note(`  Authorized by   ${result.authorizedByUserId ?? dim('nobody')} `
     + `${result.authorizedAt ? dim(String(result.authorizedAt)) : ''}`);
  note(`  Note            ${result.authorizationNote ?? dim('none')}`);
  note(`  Domains         ${result.allowedDomains || dim('none — an empty allowlist permits nothing')}`);
  note(`  Active testing  ${result.allowActiveTesting ? 'permitted' : 'not permitted'}`);
  note(`  Destructive     ${result.allowDestructiveTesting ? red('permitted') : 'not permitted'}`);
  note(`  Production      ${result.allowProduction ? red('permitted') : 'not permitted'}`);
  return ExitCode.Success;
}

async function scans(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const applicationId = flag(args, 'application-id') ?? args.positionals[1];
  const take = Number(flag(args, 'take') ?? 10);
  const query = new URLSearchParams({ take: String(take) });
  if (applicationId) query.set('applicationId', applicationId);

  const result = await api.get<SecurityScan[]>(`/api/v1/security/scans?${query}`);
  if (json) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }

  if (result.length === 0) {
    note(`\n${yellow('No security scans have been recorded for this application.')}`);
    note(dim('That is not a clean result. Nothing has been tested.'));
    return ExitCode.Success;
  }

  note(`\n${bold('Security scans')}`);
  for (const scan of result) {
    note(`  ${scan.reference}  ${dim(scan.startedAt)}  ${scan.profile}  `
       + `${outcomeLabel(scan.gate.outcome)}  ${scan.findings.length} finding(s), `
       + `${scan.requestsBlocked} refused`);
  }
  return ExitCode.Success;
}

async function findings(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const applicationId = flag(args, 'application-id') ?? args.positionals[1];
  const status = flag(args, 'status');
  const query = new URLSearchParams();
  if (applicationId) query.set('applicationId', applicationId);
  if (status) query.set('status', status);

  const result = await api.get<SecurityFinding[]>(`/api/v1/security/findings?${query}`);
  if (json) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }

  if (result.length === 0) {
    // The wording matters. "No findings" invites the reader to hear "secure", and this
    // command has no idea whether anything was ever scanned.
    note(`\n${dim('No stored findings match. This says nothing about whether the application')}`);
    note(dim('has been scanned, or about what any scan covered.'));
    return ExitCode.Success;
  }

  note(`\n${bold('Security findings')}`);
  for (const finding of result) {
    note(`  ${severityLabel(finding.severity)}  ${finding.reference}  ${finding.category}`
       + `${finding.cwe ? dim(` ${finding.cwe}`) : ''}  ${statusLabel(finding.status)}`
       + `${finding.isRegression ? red(' REGRESSION') : ''}`);
    note(`      ${dim(finding.title)}`);
    if (finding.endpoint) note(`      ${dim(finding.endpoint)}`);
  }
  return ExitCode.Success;
}

/**
 * The pipeline-facing one.
 *
 * Exits on the gate's outcome, and a missing scan is REVIEW rather than success. A CLI that
 * exited 0 because it could not find a scan would produce exactly the green build this whole
 * capability exists to prevent.
 */
async function gate(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const scanId = flag(args, 'scan-id') ?? args.positionals[1];
  if (!scanId) throw usage('A scan id is required.', 'aira security gate --scan-id <id>');

  const scan = await api.get<SecurityScan>(`/api/v1/security/scans/${scanId}`);
  const result = scan.gate;

  if (json) { out(JSON.stringify(result, null, 2)); return exitFor(result.outcome); }

  note(`\n${bold('Security gate')} ${outcomeLabel(result.outcome)}`);
  note(result.summary);
  note('');
  for (const rule of result.rules) {
    const mark = !rule.measured ? yellow('?') : rule.passed ? green('✓') : red('✗');
    note(`  ${mark} ${rule.name}`);
    note(`      ${dim(rule.explanation)}`);
  }
  if (result.reasons.length > 0) {
    note('');
    for (const reason of result.reasons) note(`  ${yellow('•')} ${reason}`);
  }
  return exitFor(result.outcome);
}

async function triage(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const findingId = flag(args, 'finding-id') ?? args.positionals[1];
  const status = flag(args, 'status');
  const reason = flag(args, 'reason');

  if (!findingId) throw usage('A finding id is required.', 'aira security triage --finding-id <id> --status <status>');
  if (!status) throw usage('A status is required.', '--status falsePositive|accepted|resolved|needsReview|confirmed');

  // Refused here as well as by the API. A pipeline operator should find out that a
  // suppression needs a reason before the request goes out, not from a 400.
  const needsAReason = ['falsePositive', 'accepted', 'resolved'].includes(status);
  if (needsAReason && (reason ?? '').trim().length < 20) {
    throw usage(
      `Marking a finding ${status} requires --reason saying what was checked and what it showed.`,
      'A suppression with no stated reason is indistinguishable from turning the check off.');
  }

  const result = await api.post<SecurityFinding>(
    `/api/v1/security/findings/${findingId}/triage`, { status, justification: reason ?? null });

  if (json) { out(JSON.stringify(result, null, 2)); return ExitCode.Success; }
  note(`\n${result.reference} (${result.category}) is now ${statusLabel(result.status)}.`);
  if (result.dispositionNote) note(dim(`  ${result.dispositionNote}`));
  return ExitCode.Success;
}

const exitFor = (outcome: string): number =>
  outcome === 'fail' ? ExitCode.QualityGateFailure
    : outcome === 'review' ? ExitCode.HumanReviewRequired
      : ExitCode.Success;

const outcomeLabel = (outcome: string): string =>
  outcome === 'pass' ? green('PASS') : outcome === 'review' ? yellow('REVIEW') : red('FAIL');

const severityLabel = (severity: string): string => {
  const padded = severity.toUpperCase().padEnd(13);
  if (severity === 'critical' || severity === 'high') return red(padded);
  if (severity === 'medium') return yellow(padded);
  return dim(padded);
};

const statusLabel = (status: string): string =>
  status === 'confirmed' || status === 'regressed' ? red(status)
    : status === 'falsePositive' || status === 'resolved' ? dim(status)
      : yellow(status);

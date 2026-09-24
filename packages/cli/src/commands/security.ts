import { ApiClient } from '../api.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { ExitCode, usage } from '../exit-codes.js';
import { bold, dim, green, note, out, red, yellow } from '../output.js';

export const SECURITY_FLAGS = [
  'application-id', 'scan-id', 'status', 'take', 'json', 'finding-id', 'reason',
  'checks', 'wait', 'timeout', 'project-id', 'changed', 'commit', 'branch'
] as const;

export const SECURITY_HELP = `
${bold('aira security')} — security scopes, scans and findings

  aira security scope --application-id <id>
  aira security scan --application-id <id> [--checks a,b] [--wait]
  aira security impact --application-id <id> --project-id <id> --changed <paths>
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
  --checks <a,b>         Narrow a scan to these checks. The full implied set is
                         still the denominator, so a narrowed run reports as
                         partial coverage and cannot pass the gate on it
  --wait                 Wait for the worker to report, then exit on the gate
  --timeout <seconds>    How long to wait (default 600)
  --project-id <id>      The project, for impact analysis
  --changed <paths>      Changed paths, comma separated, as git diff --name-only
                         reports them. Use "-" to read them from stdin
  --commit <sha>         The commit the change belongs to
  --branch <name>        The branch it is on
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
interface StartedScan {
  securityScanId: string; reference: string; queue: string; jobId: string;
  targets: number; checksToRun: number; checksConfigured: number; summary: string;
}
interface CheckSelection {
  check: string; surface: string; reason: string;
  becauseOfChange: boolean; becauseOfOpenFinding: boolean;
}
interface ImpactResult {
  applicationId: string;
  selection: {
    selected: CheckSelection[]; checksImplied: string[]; notSelected: string[];
    isNarrowed: boolean; notes: string[]; summary: string;
  };
  caveats: string[];
}
interface SecurityScan {
  id: string; reference: string; profile: string; status: string;
  requestsIssued: number; requestsBlocked: number;
  testsExecuted: number; testsSkipped: number;
  startedAt: string; findings: SecurityFinding[]; gate: SecurityGateResult;
  errorMessage?: string | null;
}

export async function securityCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, SECURITY_FLAGS);

  const action = args.positionals[0];
  if (!action) {
    throw usage('A security subcommand is required.',
      'aira security scope | scan | impact | scans | findings | gate | triage');
  }

  const context = await resolveContext({
    apiUrl: flag(args, 'api-url'),
    token: flag(args, 'token')
  });
  const api = new ApiClient(context.apiUrl, context.token);
  const json = boolFlag(args, 'json');

  switch (action) {
    case 'scope': return scope(api, args, json);
    case 'scan': return startScan(api, args, json);
    case 'impact': return impact(api, args, json);
    case 'scans': return scans(api, args, json);
    case 'findings': return findings(api, args, json);
    case 'gate': return gate(api, args, json);
    case 'triage': return triage(api, args, json);
    default:
      throw usage(`Unknown security subcommand "${action}".`,
        'aira security scope | scan | impact | scans | findings | gate | triage');
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
 * Asks AIRA to run a scan.
 *
 * Without `--wait` this returns as soon as the job is queued, and the scan it names has not run
 * yet — which is why it exits REVIEW rather than success. A pipeline step that exited 0 on
 * "a scan has been queued" would be reporting a build as security-tested at the moment nothing
 * had been tested at all.
 *
 * With `--wait` it waits for the worker and then exits on the gate, exactly as `gate` does.
 */
async function startScan(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const applicationId = flag(args, 'application-id') ?? args.positionals[1];
  if (!applicationId) {
    throw usage('An application id is required.', 'aira security scan --application-id <id>');
  }

  const checks = (flag(args, 'checks') ?? '')
    .split(',').map(c => c.trim()).filter(Boolean);

  const started = await api.post<StartedScan>('/api/v1/security/scans/start', {
    applicationId,
    ...(checks.length > 0 ? { checksToRun: checks } : {})
  });

  if (!boolFlag(args, 'wait')) {
    if (json) { out(JSON.stringify(started, null, 2)); return ExitCode.HumanReviewRequired; }
    note(`\n${bold('Queued')} ${started.reference} on ${started.queue}`);
    note(started.summary);
    note('');
    note(dim('This scan has not run yet. Nothing about this application\'s security has been'));
    note(dim('established by queueing it, which is why this exits REVIEW rather than success.'));
    note(dim(`Run "aira security gate --scan-id ${started.securityScanId}" once it reports.`));
    return ExitCode.HumanReviewRequired;
  }

  const timeoutSeconds = Number(flag(args, 'timeout') ?? 600);
  const deadline = Date.now() + timeoutSeconds * 1000;
  if (!json) note(`\n${bold('Queued')} ${started.reference}; waiting for a worker to report it.`);

  let scan: SecurityScan | null = null;
  while (Date.now() < deadline) {
    scan = await api.get<SecurityScan>(`/api/v1/security/scans/${started.securityScanId}`);
    if (scan.status !== 'queued') break;
    await new Promise(resolve => setTimeout(resolve, 3000));
    scan = null;
  }

  if (scan === null) {
    // Not a pass, and not silent. A scan nobody finished is a scan nobody ran.
    if (json) { out(JSON.stringify({ ...started, status: 'timeout' }, null, 2)); }
    else {
      note(`\n${yellow('The scan did not report within')} ${timeoutSeconds}s.`);
      note(dim(`It is still ${bold('queued')}, which is not the same as having been tested and`));
      note(dim('found clean. Nothing here should be read as a result.'));
    }
    return ExitCode.HumanReviewRequired;
  }

  if (json) { out(JSON.stringify(scan, null, 2)); return exitFor(scan.gate.outcome); }

  if (scan.status !== 'completed') {
    // The platform stopped waiting. Reported as REVIEW rather than a gate outcome, because
    // nothing was established and the gate's verdict on a scan that never ran is not a result.
    note(`\n${bold(scan.reference)} ${yellow(scan.status.toUpperCase())}`);
    note(scan.errorMessage ?? 'This scan produced no result.');
    return ExitCode.HumanReviewRequired;
  }

  note(`\n${bold(scan.reference)} ${outcomeLabel(scan.gate.outcome)}`);
  note(scan.gate.summary);
  note('');
  note(`  ${scan.requestsIssued} request(s) issued, ${scan.requestsBlocked} refused by the scope`);
  note(`  ${scan.testsExecuted} check(s) executed, ${scan.testsSkipped} not`);
  note(`  ${scan.findings.length} finding(s)`);
  return exitFor(scan.gate.outcome);
}

/**
 * Which security checks a change calls for.
 *
 * Built for a pipeline, which is the only place the changed paths exist. It prints what was
 * selected and — the part that matters — what was not, by name rather than as a percentage.
 * A narrowed scan is genuinely useful and is also how coverage quietly disappears, so the
 * two have to be equally easy to read.
 *
 * Exits REVIEW when the selection is narrowed, because a narrowed run cannot pass the gate on
 * coverage and a pipeline should find that out here rather than after it has run the scan.
 */
async function impact(api: ApiClient, args: ParsedArgs, json: boolean): Promise<number> {
  const applicationId = flag(args, 'application-id');
  const projectId = flag(args, 'project-id');
  if (!applicationId || !projectId) {
    throw usage('An application id and a project id are required.',
      'aira security impact --application-id <id> --project-id <id> --changed <paths>');
  }

  const raw = flag(args, 'changed') ?? '';
  // "-" reads the diff from stdin, which is how a pipeline has it: git diff --name-only | aira …
  const text = raw === '-' ? await readStdin() : raw;
  const changedPaths = text.split(/[,\n]/).map(p => p.trim()).filter(Boolean);

  if (changedPaths.length === 0) {
    throw usage('No changed paths were given.',
      'Pass --changed a/b.cs,c/d.ts, or pipe git diff --name-only and use --changed -');
  }

  const result = await api.post<ImpactResult>('/api/v1/security/impact', {
    projectId, applicationId, changedPaths,
    commitSha: flag(args, 'commit') ?? null,
    branch: flag(args, 'branch') ?? null
  });

  if (json) { out(JSON.stringify(result, null, 2)); return exitFor(result.selection.isNarrowed ? 'review' : 'pass'); }

  const { selection } = result;
  note(`\n${bold('Security impact')} ${selection.isNarrowed ? yellow('NARROWED') : green('FULL')}`);
  note(selection.summary);

  if (selection.selected.length > 0) {
    note(`\n  ${bold('Selected')}`);
    for (const item of selection.selected) {
      const why = [item.becauseOfChange ? 'changed' : null,
                   item.becauseOfOpenFinding ? 'open finding' : null]
        .filter(Boolean).join(', ');
      note(`    ${item.check.padEnd(26)} ${dim(`${item.surface} — ${item.reason}${why ? ` (${why})` : ''}`)}`);
    }
  }

  // Named, not counted. A reader who sees "62% selected" cannot tell whether the missing
  // third is the part that matters.
  if (selection.notSelected.length > 0) {
    note(`\n  ${bold('Not selected')} ${dim('— implied by the surface and not run by this selection')}`);
    for (const check of selection.notSelected) note(`    ${yellow(check)}`);
  }

  for (const line of selection.notes) note(`\n  ${dim(line)}`);
  for (const caveat of result.caveats) note(`  ${yellow('•')} ${dim(caveat)}`);

  return exitFor(selection.isNarrowed ? 'review' : 'pass');
}

/** Reads the whole of stdin, for the pipeline that pipes its diff in. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
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

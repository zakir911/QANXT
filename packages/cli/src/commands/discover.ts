import { ApiClient } from '../api.js';
import { boolFlag, flag, intFlag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { resolveContext } from '../config.js';
import { CliError, ExitCode, usage } from '../exit-codes.js';
import { bold, dim, note, out, red, yellow } from '../output.js';

export const DISCOVER_FLAGS = [
  'application', 'browser', 'max-depth', 'max-pages', 'timeout', 'poll', 'no-wait', 'json'
] as const;

export const DISCOVER_HELP = `
${bold('qanxt discover')} — crawl an application and refresh its knowledge graph

  qanxt discover --application <id>

  --application <id>     The registered application to explore
  --browser <name>       chromium | firefox | webkit
  --max-depth <n>        How far from the entry point to crawl
  --max-pages <n>        Stop after this many pages
  --timeout <seconds>    Give up waiting (default 1800)
  --poll <seconds>       How often to check progress (default 5)
  --no-wait              Queue the crawl and exit without waiting
  --json                 Emit the discovery result on stdout

Exit status: 0 discovery completed · 4 it failed or could not be started · 5 timed out.
`;

interface DiscoveryRun {
  id: string;
  applicationId: string;
  applicationName: string;
  status: string;
  pagesDiscovered: number;
  elementsDiscovered: number;
  apiEndpointsDiscovered: number;
  consoleErrorCount: number;
  pagesBlockedByPolicy: number;
  errorMessage?: string | null;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'partial', 'timedOut']);

export async function discoverCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, DISCOVER_FLAGS);

  const applicationId = flag(args, 'application') ?? process.env.QANXT_APPLICATION_ID;
  if (!applicationId) {
    throw usage('An application is required.', 'Pass --application <id>, or set QANXT_APPLICATION_ID.');
  }

  const context = await resolveContext({ apiUrl: flag(args, 'api-url'), token: flag(args, 'token') });
  const api = new ApiClient(context.apiUrl, context.token);

  const started = await api.post<DiscoveryRun>('/api/v1/discovery/runs', {
    applicationId,
    browser: flag(args, 'browser'),
    maxDepth: intFlag(args, 'max-depth'),
    maxPages: intFlag(args, 'max-pages'),
    timeoutSeconds: intFlag(args, 'timeout')
  });

  note(`${bold('Discovery queued')} for ${started.applicationName} ${dim(started.id)}`);

  if (boolFlag(args, 'no-wait')) {
    out(started.id);
    return ExitCode.Success;
  }

  const timeoutMs = (intFlag(args, 'timeout') ?? 1800) * 1000;
  const pollMs = (intFlag(args, 'poll') ?? 5) * 1000;
  const deadline = Date.now() + timeoutMs;

  let run = started;
  let lastLine = '';
  while (!TERMINAL.has(run.status)) {
    if (Date.now() > deadline) {
      throw new CliError(
        `Discovery did not finish within ${Math.round(timeoutMs / 1000)}s (last status: ${run.status}).`,
        ExitCode.InfrastructureError,
        `It may still be running. Check with "qanxt discover" again once it settles.`);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const detail = await api.get<{ summary: DiscoveryRun }>(`/api/v1/discovery/runs/${run.id}`);
    run = detail.summary;

    const line = `  ${run.status} — ${run.pagesDiscovered} page(s), ${run.elementsDiscovered} element(s)`;
    if (line !== lastLine) { note(dim(line)); lastLine = line; }
  }

  if (boolFlag(args, 'json')) out(JSON.stringify(run, null, 2));

  note('');
  note(`  ${run.pagesDiscovered} page(s) · ${run.elementsDiscovered} element(s) `
    + `· ${run.apiEndpointsDiscovered} API endpoint(s)`);

  // A crawl that was cut short by policy still "completed"; saying so prevents someone
  // concluding the application is smaller than it is.
  if (run.pagesBlockedByPolicy > 0) {
    note(yellow(`  ${run.pagesBlockedByPolicy} page(s) were not visited because they fall outside `
      + `the application's allowed domains.`));
  }
  if (run.consoleErrorCount > 0) {
    note(yellow(`  The application logged ${run.consoleErrorCount} console error(s) while being crawled.`));
  }

  if (run.status !== 'completed' && run.status !== 'partial') {
    note(red(`\n  Discovery ended as "${run.status}". ${run.errorMessage ?? ''}`.trimEnd()));
    return ExitCode.InfrastructureError;
  }

  return ExitCode.Success;
}

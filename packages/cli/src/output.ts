/**
 * Terminal output.
 *
 * Progress and diagnostics go to stderr, results to stdout, so `qanxt status --json | jq`
 * works without the progress lines corrupting the stream. Colour is used only when the
 * output is a terminal and NO_COLOR is unset, and never as the only carrier of meaning.
 */

const useColour = (): boolean =>
  process.stderr.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (code: string, value: string): string => useColour() ? `\u001b[${code}m${value}\u001b[0m` : value;

export const green = (v: string): string => wrap('32', v);
export const red = (v: string): string => wrap('31', v);
export const yellow = (v: string): string => wrap('33', v);
export const dim = (v: string): string => wrap('2', v);
export const bold = (v: string): string => wrap('1', v);

let quiet = false;
export const setQuiet = (value: boolean): void => { quiet = value; };

/** Progress: suppressed by --quiet, always stderr. */
export const note = (message: string): void => { if (!quiet) process.stderr.write(`${message}\n`); };

/** Results: never suppressed, always stdout. */
export const out = (message: string): void => { process.stdout.write(`${message}\n`); };

export const warn = (message: string): void => { process.stderr.write(`${yellow('warning')} ${message}\n`); };

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Turns a wire enum into the words the console uses for it.
 *
 * The audit trail printed `testRunStarted` and `aiGeneration` where the console says "Test
 * run started" and "Ai generation". The same record should not read differently depending on
 * which surface you opened it in, least of all the one people quote in a review.
 */
export function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

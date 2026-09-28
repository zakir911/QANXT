import type { PageKind } from '@qa-nxt/shared-types';
import type { RawPageCapture } from './page-extractor.js';

/**
 * Classifies a page from what was observed on it.
 *
 * This is deliberately rule-based rather than a model call: it runs on every page of
 * every crawl, the signals are unambiguous, and spending tokens to decide that a page
 * with a password field is a login page would be indefensible. The AI's job starts where
 * these rules stop.
 */
export function classifyPage(capture: RawPageCapture): PageKind {
  const url = capture.url.toLowerCase();
  const title = capture.title.toLowerCase();
  const text = capture.visibleTextExcerpt.toLowerCase();

  if (capture.hasPasswordField && capture.formCount > 0) return 'login';
  if (/\b(sign in|log in|login)\b/.test(title) && capture.formCount > 0) return 'login';

  if (/\/(error|404|500|not-found|oops)\b/.test(url)) return 'error';
  if (capture.errorMessages.length > 0 && capture.elements.length < 10) return 'error';

  if (/\/(settings|preferences|profile|account-settings)\b/.test(url)) return 'settings';
  if (/\/(dashboard|home|overview|summary)\b/.test(url)) return 'dashboard';
  if (/\b(dashboard|overview)\b/.test(title)) return 'dashboard';

  if (/\/(report|statement|analytics|insights)\b/.test(url)) return 'report';

  const tables = capture.elements.filter(e => e.kind === 'table').length;
  const inputs = capture.elements.filter(e =>
    ['textInput', 'passwordInput', 'numberInput', 'dateInput', 'select', 'textArea', 'checkbox', 'radio'].includes(e.kind)).length;

  // A page dominated by inputs is a form; one dominated by a table is a list; a page with
  // a detail-shaped URL and neither is a record view.
  if (inputs >= 4 && capture.formCount > 0 && tables === 0) return 'form';
  if (tables > 0 && inputs < 4) return 'list';
  if (/\/[^/]+\/(\d+|[0-9a-f-]{36})(\/|$)/.test(url)) return 'detail';
  if (tables > 0) return 'list';
  if (capture.formCount > 0) return 'form';

  if (text.length > 0 && capture.headings.length > 0) return 'detail';
  return 'unknown';
}

/** A page is treated as behind authentication if reaching it required a session. */
export function inferRequiresAuthentication(capture: RawPageCapture, wasAuthenticated: boolean): boolean {
  if (!wasAuthenticated) return false;
  return !capture.hasPasswordField;
}

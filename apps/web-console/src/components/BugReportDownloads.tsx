import { useState } from 'react';
import { apiDownload } from '../api/client';

type Format = 'html' | 'zip';

/**
 * Downloads a finished run's bug report, to hand to developers as it is.
 *
 * The HTML report is one file with the screenshots inside it; the evidence pack adds the
 * Markdown and JSON copies, the Playwright traces, videos and page snapshots.
 */
export function BugReportDownloads({ runId }: { runId: string }) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (format: Format) => {
    setBusy(format);
    setError(null);
    try {
      await apiDownload(`/api/v1/testruns/${runId}/bug-report?format=${format}`, `qanxt-bug-report.${format}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void download('html')}
              title="One HTML file with every bug, its steps, data, requests and screenshots">
        {busy === 'html' ? 'Preparing…' : 'Bug report'}
      </button>
      <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void download('zip')}
              title="The report plus Markdown, JSON, Playwright traces, videos and page snapshots">
        {busy === 'zip' ? 'Preparing…' : 'Evidence pack (.zip)'}
      </button>
      {error && <span role="alert" className="text-sm text-bad">{error}</span>}
    </div>
  );
}

import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiDownload = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiDownload: (path: string, name: string) => apiDownload(path, name) };
});

const { BugReportDownloads } = await import('./BugReportDownloads');

afterEach(() => apiDownload.mockReset());

describe('BugReportDownloads', () => {
  test('downloads the HTML report and the evidence pack for the run', async () => {
    apiDownload.mockResolvedValue('report');
    render(<BugReportDownloads runId="run-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Bug report' }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/v1/testruns/run-1/bug-report?format=html', 'qanxt-bug-report.html'));

    fireEvent.click(await screen.findByRole('button', { name: 'Evidence pack (.zip)' }));
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith('/api/v1/testruns/run-1/bug-report?format=zip', 'qanxt-bug-report.zip'));
  });

  test('a failed download says why instead of doing nothing', async () => {
    apiDownload.mockRejectedValue(new Error('The test run was not found.'));
    render(<BugReportDownloads runId="missing" />);
    fireEvent.click(screen.getByRole('button', { name: 'Bug report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The test run was not found.');
  });
});

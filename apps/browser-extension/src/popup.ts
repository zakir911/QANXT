import { describeLocator } from './locator.js';
import type { PopupToBackground, RecordedJourney, RecordingState } from './messages.js';

/**
 * The recorder's control surface.
 *
 * All state lives in the service worker, so the popup is a view: it reads state, sends
 * intents, and re-renders. That matters because a popup is destroyed every time it closes,
 * and a recording that lived here would not survive someone clicking away.
 */

const SETTINGS_KEY = 'qanxt.settings';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`The popup is missing #${id}.`);
  return element as T;
};

const ask = <T>(message: PopupToBackground): Promise<T> =>
  new Promise(resolve => chrome.runtime.sendMessage(message, resolve));

function notice(text: string, kind: 'ok' | 'error'): void {
  const element = $('notice');
  element.innerHTML = `<div class="notice ${kind}">${escapeHtml(text)}</div>`;
  if (kind === 'ok') setTimeout(() => { element.innerHTML = ''; }, 4000);
}

function render(state: RecordingState): void {
  const active = state.recording;
  $('setup').hidden = active;
  $('controls').hidden = !active;
  ($('pause') as HTMLButtonElement).hidden = state.paused;
  ($('resume') as HTMLButtonElement).hidden = !state.paused;

  const status = $('status');
  status.className = active && !state.paused ? 'status live' : 'status';
  status.textContent = !active
    ? state.steps.length > 0
      ? `Stopped. ${state.steps.length} step(s) recorded.`
      : 'Not recording.'
    : state.paused
      ? `Paused. ${state.steps.length} step(s) so far.`
      : `Recording “${state.name}” — ${state.steps.length} step(s).`;

  const list = $('steps');
  if (state.steps.length === 0) {
    list.innerHTML = '<li class="empty">Nothing recorded yet. Interact with the page and the steps appear here.</li>';
    return;
  }

  list.innerHTML = state.steps.map(step => `
    <li>
      <button class="remove" data-order="${step.order}" title="Remove this step" aria-label="Remove step ${step.order}">×</button>
      <span class="action">${escapeHtml(step.action)}</span>
      <span>${escapeHtml(step.description)}</span>
      ${step.target ? `<div class="locator">${escapeHtml(describeLocator(step.target))}</div>` : ''}
      ${step.value ? `<div class="locator">value: ${escapeHtml(step.value)}</div>` : ''}
    </li>
  `).join('');

  for (const button of list.querySelectorAll<HTMLButtonElement>('.remove')) {
    button.addEventListener('click', async () => {
      render(await ask<RecordingState>({ kind: 'removeStep', order: Number(button.dataset.order) }));
    });
  }
}

async function refresh(): Promise<void> {
  render(await ask<RecordingState>({ kind: 'getState' }));
}

$('start').addEventListener('click', async () => {
  const name = ($('journey-name') as HTMLInputElement).value.trim() || 'Recorded journey';
  const result = await ask<RecordingState & { error?: string }>({ kind: 'start', name });
  if (result.error) return notice(result.error, 'error');
  render(result);
});

$('pause').addEventListener('click', async () => render(await ask<RecordingState>({ kind: 'pause' })));
$('resume').addEventListener('click', async () => render(await ask<RecordingState>({ kind: 'resume' })));
$('stop').addEventListener('click', async () => render(await ask<RecordingState>({ kind: 'stop' })));
$('clear').addEventListener('click', async () => render(await ask<RecordingState>({ kind: 'clear' })));

$('inspect').addEventListener('click', async () => {
  await ask({ kind: 'inspect' });
  notice('Click an element on the page to inspect its locator.', 'ok');
  window.close();
});

$('assert').addEventListener('click', async () => {
  await ask({ kind: 'assert' });
  notice('Click the element you want to assert on.', 'ok');
  window.close();
});

$('download').addEventListener('click', async () => {
  const journey = await ask<RecordedJourney>({ kind: 'export' });
  if (journey.steps.length === 0) return notice('There is nothing recorded to download.', 'error');

  const blob = new Blob([JSON.stringify(journey, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${journey.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.journey.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('send').addEventListener('click', async () => {
  const apiUrl = ($('api-url') as HTMLInputElement).value.trim();
  const token = ($('token') as HTMLInputElement).value.trim();
  const projectId = ($('project-id') as HTMLInputElement).value.trim();
  const applicationId = ($('application-id') as HTMLInputElement).value.trim();

  if (!apiUrl || !token || !projectId || !applicationId) {
    return notice('Fill in the platform URL, token, project id and application id.', 'error');
  }

  // The token is not stored; the rest is, so the panel does not have to be refilled.
  await chrome.storage.local.set({ [SETTINGS_KEY]: { apiUrl, projectId, applicationId } });

  const result = await ask<{ ok?: boolean; error?: string; body?: { testCaseId?: string } }>(
    { kind: 'send', apiUrl, token, projectId, applicationId });

  if (result.error) return notice(result.error, 'error');
  notice(result.body?.testCaseId
    ? 'Journey imported and a test case was generated from it.'
    : 'Journey imported.', 'ok');
});

void (async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY] as { apiUrl?: string; projectId?: string; applicationId?: string } | undefined;
  if (settings?.apiUrl) ($('api-url') as HTMLInputElement).value = settings.apiUrl;
  if (settings?.projectId) ($('project-id') as HTMLInputElement).value = settings.projectId;
  if (settings?.applicationId) ($('application-id') as HTMLInputElement).value = settings.applicationId;
  await refresh();
})();

// The popup stays in step with a recording that is still collecting steps behind it.
setInterval(() => void refresh(), 1000);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

import type {
  BackgroundToContent, ContentToBackground, PopupToBackground,
  RecordedJourney, RecordedStep, RecordingState
} from './messages.js';
import { RECORDER_VERSION } from './messages.js';

/**
 * The extension's service worker: the one place that owns the recording.
 *
 * MV3 terminates a service worker aggressively, so nothing may live only in memory. The
 * recording is written to session storage on every change, which means a recording
 * survives the worker being shut down mid-journey — the failure mode that would otherwise
 * lose someone twenty minutes of careful clicking.
 */

const STORAGE_KEY = 'qanxt.recording';

const EMPTY_STATE: RecordingState = {
  recording: false,
  paused: false,
  name: 'Recorded journey',
  steps: []
};

async function readState(): Promise<RecordingState> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as RecordingState | undefined) ?? { ...EMPTY_STATE };
}

async function writeState(state: RecordingState): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: state });
  await updateBadge(state);
}

async function updateBadge(state: RecordingState): Promise<void> {
  const text = state.recording ? String(state.steps.length) : '';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#b26b00' : '#c02626' });
}

async function tell(tabId: number, message: BackgroundToContent): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The content script may not be injected yet (a fresh tab, a restricted page). The
    // popup reports this rather than the worker failing silently.
  }
}

/**
 * Compares two locators by what they describe rather than by how they serialise.
 *
 * The previous step comes back out of `chrome.storage.session`, which returns an object's
 * keys in sorted order rather than the order they were written; the step that has just
 * arrived is in insertion order. Comparing their `JSON.stringify` output therefore never
 * matched, for any step — see verification/failures/BUG-0006. A canonical form makes the
 * comparison independent of a storage backend's habits.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

/** Two steps merge only if both name the same element; a step with no locator never merges. */
function sameTarget(a: RecordedStep['target'], b: RecordedStep['target']): boolean {
  if (!a || !b) return false;
  return canonical(a) === canonical(b);
}

/**
 * Runs the stored-state handlers one at a time.
 *
 * Every handler below is a read-modify-write over a single stored recording, and MV3
 * delivers messages concurrently. Two steps that arrive within the same millisecond — a
 * username being filled and then a password — would otherwise both read the recording
 * before either wrote it back, and the later write would silently drop the earlier step.
 * Serialising the handlers makes each one see the previous one's result.
 */
let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const result = pending.then(work, work);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

chrome.runtime.onMessage.addListener((
  message: ContentToBackground | PopupToBackground,
  sender,
  sendResponse
) => {
  void serialize(async () => {
    const state = await readState();

    // ---- From the content script ------------------------------------------
    if ('kind' in message && message.kind === 'step') {
      if (!state.recording || state.paused) return sendResponse({ ok: false });

      const step: RecordedStep = { ...message.step, order: state.steps.length + 1 };

      // Consecutive edits to the same field are one step: a person filling a box does not
      // think of it as one action per keystroke, and neither should the generated test.
      const previous = state.steps[state.steps.length - 1];
      if (previous && previous.action === 'fill' && step.action === 'fill'
        && sameTarget(previous.target, step.target)) {
        state.steps[state.steps.length - 1] = { ...step, order: previous.order };
      } else {
        state.steps.push(step);
      }

      await writeState(state);
      return sendResponse({ ok: true, count: state.steps.length });
    }

    if ('kind' in message && message.kind === 'inspected') {
      await chrome.storage.session.set({ 'qanxt.lastInspected': message });
      return sendResponse({ ok: true });
    }

    if ('kind' in message && message.kind === 'ready') {
      if (state.recording && !state.paused && sender.tab?.id) {
        // A page that reloaded mid-recording needs telling that recording is still on.
        await tell(sender.tab.id, { kind: 'startRecording' });
      }
      return sendResponse({ ok: true });
    }

    // ---- From the popup ----------------------------------------------------
    switch (message.kind) {
      case 'getState':
        return sendResponse(state);

      case 'start': {
        const tab = await resolveRecordableTab();
        if (!tab?.id || !tab.url) {
          return sendResponse({ error: 'No http or https page is open to record.' });
        }

        const next: RecordingState = {
          recording: true,
          paused: false,
          tabId: tab.id,
          startUrl: tab.url,
          name: message.name || 'Recorded journey',
          startedAt: new Date().toISOString(),
          steps: [{
            order: 1,
            action: 'navigate',
            description: `Go to ${new URL(tab.url).pathname}`,
            url: tab.url,
            timestampMs: Date.now()
          }]
        };
        await writeState(next);
        await tell(tab.id, { kind: 'startRecording' });
        return sendResponse(next);
      }

      case 'pause':
        state.paused = true;
        await writeState(state);
        if (state.tabId) await tell(state.tabId, { kind: 'stopRecording' });
        return sendResponse(state);

      case 'resume':
        state.paused = false;
        await writeState(state);
        if (state.tabId) await tell(state.tabId, { kind: 'startRecording' });
        return sendResponse(state);

      case 'stop':
        state.recording = false;
        state.paused = false;
        await writeState(state);
        if (state.tabId) await tell(state.tabId, { kind: 'stopRecording' });
        return sendResponse(state);

      case 'clear':
        await writeState({ ...EMPTY_STATE });
        return sendResponse({ ...EMPTY_STATE });

      case 'removeStep':
        state.steps = state.steps
          .filter(step => step.order !== message.order)
          .map((step, index) => ({ ...step, order: index + 1 }));
        await writeState(state);
        return sendResponse(state);

      case 'annotateStep':
        state.steps = state.steps.map(step =>
          step.order === message.order ? { ...step, annotation: message.annotation } : step);
        await writeState(state);
        return sendResponse(state);

      case 'inspect':
      case 'assert': {
        const tab = await resolveRecordableTab();
        if (!tab?.id) return sendResponse({ error: 'No http or https page is open.' });
        await tell(tab.id, { kind: message.kind === 'inspect' ? 'startInspecting' : 'startAsserting' });
        return sendResponse({ ok: true });
      }

      case 'export':
        return sendResponse(toJourney(state));

      case 'send': {
        const journey = toJourney(state);
        if (journey.steps.length === 0) {
          return sendResponse({ error: 'There is nothing recorded to send.' });
        }
        try {
          const response = await fetch(
            `${message.apiUrl.replace(/\/+$/, '')}/api/v1/journeys/import`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${message.token}`
              },
              body: JSON.stringify({
                projectId: message.projectId,
                applicationId: message.applicationId,
                journey
              })
            });

          const text = await response.text();
          if (!response.ok) {
            return sendResponse({ error: `The platform refused the journey (${response.status}): ${text.slice(0, 300)}` });
          }
          return sendResponse({ ok: true, body: text ? JSON.parse(text) : null });
        } catch (error) {
          return sendResponse({ error: `The platform could not be reached: ${String(error)}` });
        }
      }

      default:
        return sendResponse({ error: 'Unknown message.' });
    }
  });

  // Keeps the message channel open for the async work above.
  return true;
});

/**
 * Finds the page to record.
 *
 * The active tab is the right answer almost always, but not when the extension's own page
 * is what is focused — which happens when the popup is opened in a tab, and would
 * otherwise produce a confusing "only http pages can be recorded" for a user who has a
 * perfectly good page open behind it.
 */
async function resolveRecordableTab(): Promise<chrome.tabs.Tab | undefined> {
  const isRecordable = (tab: chrome.tabs.Tab): boolean => Boolean(tab.id && tab.url && /^https?:/.test(tab.url));

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isRecordable(active)) return active;

  const candidates = (await chrome.tabs.query({ currentWindow: true })).filter(isRecordable);
  // Most recently used first, so the page the person was just on wins.
  candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return candidates[0];
}

function toJourney(state: RecordingState): RecordedJourney {
  return {
    schemaVersion: 1,
    name: state.name,
    startUrl: state.startUrl ?? '',
    recordedAt: state.startedAt ?? new Date().toISOString(),
    recorderVersion: RECORDER_VERSION,
    steps: state.steps
  };
}

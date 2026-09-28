import { buildCandidates, describeLocator, preferredLocator, textOf } from './locator.js';
import type { BackgroundToContent, ContentToBackground, RecordedStep } from './messages.js';

/**
 * The recorder that runs inside the page.
 *
 * Two rules shape everything here. First, it must not change what it is recording: no
 * preventDefault, no stopPropagation, listeners in the capture phase only, so a page
 * behaves exactly as it would without the extension. Second, it must never capture a
 * secret: a password field's value is replaced with a secret reference at the moment it is
 * read, not filtered out later.
 */

const RECORDING_ATTRIBUTE = 'data-qanxt-recorder';
if (!document.documentElement.hasAttribute(RECORDING_ATTRIBUTE)) {
  document.documentElement.setAttribute(RECORDING_ATTRIBUTE, 'active');
  install();
}

function install(): void {
  let recording = false;
  let inspecting = false;
  let asserting = false;
  let lastUrl = location.href;
  let highlight: HTMLElement | null = null;

  const send = (message: ContentToBackground): void => {
    try {
      chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
    } catch {
      // The extension can be reloaded while a page is open; a dead channel is not the
      // page's problem and must not surface as an error in the application under test.
    }
  };

  const emit = (step: Omit<RecordedStep, 'order'>): void => send({ kind: 'step', step });

  chrome.runtime.onMessage.addListener((message: BackgroundToContent) => {
    switch (message.kind) {
      case 'startRecording': recording = true; break;
      case 'stopRecording': recording = false; stopOverlay(); break;
      case 'startInspecting': inspecting = true; asserting = false; startOverlay(); break;
      case 'startAsserting': asserting = true; inspecting = false; startOverlay(); break;
      case 'stopInspecting': inspecting = false; asserting = false; stopOverlay(); break;
    }
  });

  // ---- Recording ---------------------------------------------------------

  document.addEventListener('click', event => {
    if (inspecting || asserting) { handleOverlayClick(event); return; }
    if (!recording) return;

    const target = resolveTarget(event.target);
    if (!target) return;

    const locator = preferredLocator(target);
    emit({
      action: 'click',
      description: `Click ${describeForHuman(target)}`,
      target: locator,
      candidates: buildCandidates(target).slice(0, 5),
      url: location.href,
      timestampMs: Date.now()
    });
  }, true);

  document.addEventListener('change', event => {
    if (!recording) return;

    const target = resolveTarget(event.target);
    if (!target) return;

    const tag = target.tagName.toLowerCase();
    const locator = preferredLocator(target);
    const candidates = buildCandidates(target).slice(0, 5);

    if (tag === 'select') {
      const select = target as HTMLSelectElement;
      emit({
        action: 'select',
        description: `Select "${select.selectedOptions[0]?.textContent?.trim() ?? select.value}" in ${describeForHuman(target)}`,
        target: locator, candidates, value: select.value, url: location.href, timestampMs: Date.now()
      });
      return;
    }

    if (tag === 'input') {
      const input = target as HTMLInputElement;

      if (input.type === 'checkbox' || input.type === 'radio') {
        emit({
          action: input.checked ? 'check' : 'uncheck',
          description: `${input.checked ? 'Check' : 'Clear'} ${describeForHuman(target)}`,
          target: locator, candidates, url: location.href, timestampMs: Date.now()
        });
        return;
      }

      // A password is never read. The step records a reference the platform resolves from
      // encrypted storage at run time.
      const isSecret = input.type === 'password' || /password|secret|token|cvv|pin/i.test(input.name || input.id || '');
      emit({
        action: 'fill',
        description: `Enter ${isSecret ? 'the password' : `"${truncate(input.value, 40)}"`} in ${describeForHuman(target)}`,
        target: locator, candidates,
        value: isSecret ? '${secret:app_password}' : input.value,
        url: location.href, timestampMs: Date.now()
      });
      return;
    }

    if (tag === 'textarea') {
      emit({
        action: 'fill',
        description: `Enter text in ${describeForHuman(target)}`,
        target: locator, candidates,
        value: (target as HTMLTextAreaElement).value,
        url: location.href, timestampMs: Date.now()
      });
    }
  }, true);

  document.addEventListener('keydown', event => {
    if (!recording) return;
    // Only keys that mean something on their own: recording every keystroke would produce
    // a step per character.
    if (!['Enter', 'Escape', 'Tab'].includes(event.key)) return;

    const target = resolveTarget(event.target);
    emit({
      action: 'press',
      description: `Press ${event.key}${target ? ` in ${describeForHuman(target)}` : ''}`,
      target: target ? preferredLocator(target) : undefined,
      value: event.key,
      url: location.href,
      timestampMs: Date.now()
    });
  }, true);

  // Single-page applications change the URL without a navigation event, so the address is
  // polled; a journey that silently loses its page changes is not reproducible.
  setInterval(() => {
    if (!recording) return;
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    emit({
      action: 'navigate',
      description: `Go to ${location.pathname}`,
      url: location.href,
      timestampMs: Date.now()
    });
  }, 400);

  // ---- Inspect and assert -------------------------------------------------

  function startOverlay(): void {
    if (highlight) return;
    highlight = document.createElement('div');
    Object.assign(highlight.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
      border: '2px solid #0b5fff', background: 'rgba(11,95,255,0.12)',
      borderRadius: '3px', transition: 'all 60ms linear'
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(highlight);
    document.addEventListener('mousemove', moveHighlight, true);
  }

  function stopOverlay(): void {
    document.removeEventListener('mousemove', moveHighlight, true);
    highlight?.remove();
    highlight = null;
  }

  function moveHighlight(event: MouseEvent): void {
    if (!highlight) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === highlight) return;
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.style, {
      top: `${rect.top}px`, left: `${rect.left}px`,
      width: `${rect.width}px`, height: `${rect.height}px`
    });
  }

  function handleOverlayClick(event: Event): void {
    const target = resolveTarget(event.target);
    if (!target) return;

    // The click is consumed here, and only here: picking an element must not also activate it.
    event.preventDefault();
    event.stopPropagation();

    const locator = preferredLocator(target);
    const candidates = buildCandidates(target).slice(0, 5);

    if (asserting) {
      const text = textOf(target);
      emit({
        action: text ? 'assertText' : 'assertVisible',
        description: text
          ? `Confirm ${describeForHuman(target)} reads "${truncate(text, 60)}"`
          : `Confirm ${describeForHuman(target)} is visible`,
        target: locator, candidates,
        expected: text ? truncate(text, 200) : undefined,
        url: location.href, timestampMs: Date.now()
      });
    } else {
      send({ kind: 'inspected', locator, candidates, description: describeLocator(locator) });
    }

    asserting = false;
    inspecting = false;
    stopOverlay();
  }

  send({ kind: 'ready' });
}

/** The nearest element a person would say they clicked, not the text node inside it. */
function resolveTarget(raw: EventTarget | null): Element | null {
  if (!(raw instanceof Element)) return null;
  const interactive = raw.closest(
    'a, button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="tab"], [onclick]'
  );
  return interactive ?? raw;
}

function describeForHuman(element: Element): string {
  const name = element.getAttribute('aria-label')
    ?? textOf(element).slice(0, 40)
    ?? element.getAttribute('placeholder')
    ?? element.getAttribute('name');
  const tag = element.tagName.toLowerCase();
  return name ? `"${name}"` : `the ${tag}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

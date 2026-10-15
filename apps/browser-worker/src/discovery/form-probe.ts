import type { Page } from 'playwright';
import type { FormDependency, LocatorDescriptor } from '@qa-nxt/shared-types';
import { buildLocator } from '../browser/locator-resolver.js';
import { snapshotFormState, type RawForm, type RawFormField } from './form-extractor.js';

/**
 * Finds what a form's answers change, without submitting it.
 *
 * Conditional fields and dependent option lists are invisible to a static read: the
 * company-name field exists but is hidden, the region list holds one country's regions.
 * The only way to know what an answer changes is to give it and look, so this changes each
 * select, checkbox and radio group in turn and records which fields appeared, vanished or
 * became required, and which other selects were repopulated.
 *
 * Bounded, and careful about what it touches. Nothing is typed and nothing is submitted.
 * Probing stops on a page the moment an interaction navigates or sends anything other than
 * a GET, because a control that saves on change is a control whose probing changes data.
 */

export interface ProbeResult {
  dependencies: FormDependency[];
  interactions: number;
  stoppedBecause?: string;
}

const MAX_OPTIONS_PER_TRIGGER = 8;
const SETTLE_MS = 150;

type Snapshot = ReturnType<typeof snapshotFormState>;

function isTrigger(field: RawFormField): boolean {
  if (!field.visible || field.disabled || field.readOnly) return false;
  return ['select', 'checkbox', 'switch', 'radio'].includes(field.controlType);
}

function diff(before: Snapshot, after: Snapshot): Omit<FormDependency, 'trigger' | 'triggerLabel' | 'triggerValue'> {
  const shows: string[] = [];
  const hides: string[] = [];
  const becomesRequired: string[] = [];
  const optionsOf: Record<string, string[]> = {};
  for (const [key, now] of Object.entries(after)) {
    const was = before[key];
    if (!was) { if (now.visible) shows.push(key); continue; }
    if (now.visible && !was.visible) shows.push(key);
    if (!now.visible && was.visible) hides.push(key);
    if (now.required && !was.required) becomesRequired.push(key);
    if (now.options.join('\u0001') !== was.options.join('\u0001')) optionsOf[key] = now.options;
  }
  return { shows, hides, becomesRequired, optionsOf };
}

export async function probeForm(page: Page, form: RawForm, maxInteractions: number): Promise<ProbeResult> {
  const dependencies: FormDependency[] = [];
  let interactions = 0;
  const startUrl = page.url();
  let unsafe: string | undefined;
  // The probe's own reload between triggers is a navigation too, and must not count.
  let restoring = false;
  const onRequest = (request: { method(): string; url(): string; isNavigationRequest(): boolean }) => {
    if (restoring) return;
    if (request.method() !== 'GET') unsafe = `changing a control sent a ${request.method()} to ${request.url()}`;
    else if (request.isNavigationRequest()) unsafe = 'changing a control navigated the page';
  };
  page.on('request', onRequest);

  try {
    const baseline = await page.evaluate(snapshotFormState, form.domIndex);

    for (const field of form.fields.filter(isTrigger)) {
      if (interactions >= maxInteractions || unsafe) break;
      const fieldKey = field.name ?? field.key;

      const values: { value: string; label: string }[] = field.controlType === 'select'
        ? field.options.filter(o => o.value !== '' && !o.disabled).slice(0, MAX_OPTIONS_PER_TRIGGER)
            .map(o => ({ value: o.value, label: o.label }))
        : field.controlType === 'radio'
          ? field.options.filter(o => !o.disabled).slice(0, MAX_OPTIONS_PER_TRIGGER).map(o => ({ value: o.value, label: o.label }))
          : [{ value: field.checked ? 'off' : 'on', label: field.checked ? 'unchecked' : 'checked' }];

      for (const option of values) {
        if (interactions >= maxInteractions || unsafe) break;
        interactions += 1;
        try {
          if (field.controlType === 'select') {
            await buildLocator(page, field.locator).first().selectOption(option.value, { timeout: 2000 });
          } else if (field.controlType === 'radio') {
            await page.locator(`${field.locator.value}[value="${option.value.replace(/"/g, '\\"')}"]`).first().check({ timeout: 2000 });
          } else {
            await buildLocator(page, field.locator).first().setChecked(option.value === 'on', { timeout: 2000 });
          }
        } catch {
          continue;
        }
        await page.waitForTimeout(SETTLE_MS);
        if (unsafe || page.url() !== startUrl) { unsafe ??= 'changing a control navigated the page'; break; }

        const after = await page.evaluate(snapshotFormState, form.domIndex);
        const change = diff(baseline, after);
        // The trigger's own entry changes with its own value; that is not a dependency.
        delete change.optionsOf[fieldKey];
        if (change.shows.length || change.hides.length || change.becomesRequired.length || Object.keys(change.optionsOf).length) {
          dependencies.push({ trigger: fieldKey, triggerLabel: field.label ?? fieldKey, triggerValue: option.value, ...change });
        }
      }

      // Put the form back the way it was, so the next trigger is measured from the same
      // starting point and not from the state the last one left.
      if (!unsafe) {
        restoring = true;
        await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        restoring = false;
        interactions += 1;
      }
    }
  } finally {
    page.off('request', onRequest);
  }

  return { dependencies, interactions, stoppedBecause: unsafe };
}

// ---- Forms that are hidden until something opens them --------------------------------

export interface FormOpener {
  label: string;
  locator: LocatorDescriptor;
}

const MAX_OPENER_CANDIDATES = 8;
/** Never pressed while looking for an opener: these act, they do not reveal. */
const DESTRUCTIVE = /\b(log ?out|sign ?out|delete|remove|pay|buy|purchase|checkout|order|unsubscribe|cancel|deactivate|close account|reset)\b/i;

/** Whether any of the form's fields is visible right now. */
export async function formIsVisible(page: Page, form: RawForm): Promise<boolean> {
  const state = await page.evaluate(snapshotFormState, form.domIndex).catch(() => ({} as Snapshot));
  return Object.values(state).some(field => field.visible);
}

/**
 * Finds the control that reveals a form hidden at load — a contact form in a dialog behind
 * "Contact us", a sign-up drawer behind "Get started".
 *
 * Without this every test of such a form waits for a field nobody can see and times out,
 * and the timeouts read as a slow application. Each visible button on the page, and each
 * link that stays on the page, is pressed in turn; the first one after which the form's
 * fields are visible is the opener. The same rules as the dependency probe apply: anything
 * that navigates or sends more than a GET stops the search, and controls whose label says
 * they act (pay, delete, sign out) are never pressed.
 */
export async function findOpener(page: Page, form: RawForm): Promise<{ opener?: FormOpener; stoppedBecause?: string }> {
  const startUrl = page.url();
  let unsafe: string | undefined;
  let restoring = false;
  const onRequest = (request: { method(): string; url(): string; isNavigationRequest(): boolean }) => {
    if (restoring) return;
    if (request.method() !== 'GET') unsafe = `pressing a control sent a ${request.method()} to ${request.url()}`;
    else if (request.isNavigationRequest() && request.url().split('#')[0] !== startUrl.split('#')[0]) unsafe = 'pressing a control navigated the page';
  };
  page.on('request', onRequest);
  try {
    const candidates = await page.evaluate(({ domIndex, limit }) => {
      const target = domIndex >= 0 ? document.querySelectorAll('form')[domIndex] : null;
      const visible = (el: Element) => {
        const style = getComputedStyle(el);
        const box = (el as HTMLElement).getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      };
      const out: { label: string; testId: string | null; kind: 'button' | 'link' }[] = [];
      for (const el of Array.from(document.querySelectorAll('button, [role="button"], a'))) {
        if (target && target.contains(el)) continue;
        if (el.closest('form') && el.closest('form') !== target) continue;
        if (!visible(el)) continue;
        const href = el.tagName === 'A' ? (el.getAttribute('href') ?? '') : '';
        if (el.tagName === 'A' && href && !href.startsWith('#') && !href.startsWith('javascript:')) continue;
        const label = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ');
        if (!label || label.length > 60) continue;
        const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id') ?? el.getAttribute('data-test');
        out.push({ label, testId, kind: el.tagName === 'A' ? 'link' : 'button' });
        if (out.length >= limit * 3) break;
      }
      return out;
    }, { domIndex: form.domIndex, limit: MAX_OPENER_CANDIDATES });

    // Labels that name the form's purpose first: "Contact us" for a contact form.
    const words = new Set(`${form.name} ${form.fields.map(f => f.label ?? '').join(' ')}`.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const ranked = candidates.filter(c => !DESTRUCTIVE.test(c.label))
      .map(c => ({ ...c, score: c.label.toLowerCase().split(/\W+/).filter(w => words.has(w)).length + (/contact|open|start|get started|apply|request|enquir|sign ?up|register|feedback|book/i.test(c.label) ? 1 : 0) }))
      .sort((a, b) => b.score - a.score).slice(0, MAX_OPENER_CANDIDATES);

    for (const candidate of ranked) {
      if (unsafe) break;
      const locator: LocatorDescriptor = candidate.testId
        ? { strategy: 'testId', value: candidate.testId }
        : { strategy: 'role', value: candidate.kind, name: candidate.label, exact: true };
      try {
        await buildLocator(page, locator).first().click({ timeout: 2000 });
      } catch {
        continue;
      }
      await page.waitForTimeout(SETTLE_MS * 2);
      if (!unsafe && await formIsVisible(page, form)) return { opener: { label: candidate.label, locator } };
      restoring = true;
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      restoring = false;
    }
    return { stoppedBecause: unsafe };
  } finally {
    page.off('request', onRequest);
    if (page.url() !== startUrl || unsafe === undefined) {
      restoring = true;
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
  }
}

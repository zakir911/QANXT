import type { Page } from 'playwright';
import type { FormDependency } from '@qa-nxt/shared-types';
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

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from 'playwright';
import type { DiscoveredForm, DiscoveredPage } from '@qa-nxt/shared-types';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Crawler } from '../src/discovery/crawler.js';
import { Logger } from '../src/util/logger.js';

/**
 * Form discovery, measured against the golden form lab's ground truth.
 *
 * The lab's ground truth is generated from the same declarations its server renders from,
 * so every expectation below is a statement about a real page in a real browser: the form
 * was found on its route, every declared field was found with the attributes it declares,
 * and the answers that change the form were observed to change it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LAB = resolve(here, '../../../test-lab/form-lab');

interface TruthField {
  name: string; type: string; required: boolean; options: string[] | null;
  constraints: Record<string, string>; conditional: { field: string; equals: string } | null; step: number | null;
}
interface TruthForm {
  id: string; route: string; multiStep: boolean; hasCsrfToken: boolean; fields: TruthField[];
  dependentOptions: { parent: string; child: string } | null;
}

/** How the lab's declared type appears once a browser has rendered it. */
const RENDERED_TYPE: Record<string, string> = { 'datetime-local': 'datetime' };
const TEXT_REFINEMENTS = ['cardNumber', 'numericText', 'decimal', 'otp', 'autocomplete'];

describe('discovering forms', () => {
  let lab: ChildProcess;
  let baseUrl: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  let artifactDir: string;
  let truth: { forms: TruthForm[] };
  let pages: DiscoveredPage[];
  const logger = new Logger('error', {}, () => {});

  const formOn = (route: string): DiscoveredForm | undefined =>
    pages.find(p => new URL(p.url).pathname === route)?.forms?.[0];

  beforeAll(async () => {
    const port = 4900 + Math.floor(Math.random() * 90);
    baseUrl = `http://127.0.0.1:${port}`;
    lab = spawn(process.execPath, [join(LAB, 'server.js')], { env: { ...process.env, FORM_LAB_PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      const ok = await fetch(`${baseUrl}/health`).then(r => r.ok).catch(() => false);
      if (ok) break;
      await new Promise(r => setTimeout(r, 100));
    }
    truth = await (await fetch(`${baseUrl}/__ground-truth`)).json();

    artifactDir = await mkdtemp(join(tmpdir(), 'qanxt-forms-'));
    pool = new BrowserPool(true, logger);
    context = await pool.createContext('chromium', { defaultTimeoutMs: 8000, navigationTimeoutMs: 15_000 });

    const crawler = new Crawler(context, {
      baseUrl: `${baseUrl}/`,
      artifactDir,
      navigationTimeoutMs: 15_000,
      auth: { strategy: 'none' },
      budget: {
        allowedHosts: ['127.0.0.1'], excludedPathPrefixes: ['/__'], maxDepth: 2, maxPages: 40, maxActions: 400,
        maxInstancesPerRouteShape: 3, timeoutSeconds: 240, allowPrivateNetworks: true, respectRobotsTxt: false,
        interactionMode: 'links', allowStateChangingClicks: false, seedUrls: [], useSitemap: false
      } as never
    }, logger);
    const report = await crawler.run('form-discovery', 'worker-test');
    pages = report.pages;
  }, 300_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close().catch(() => undefined);
    lab?.kill();
    if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
  });

  test('every form is found on its own route', () => {
    const missing = truth.forms.filter(form => !formOn(form.route)).map(form => form.route);
    expect(missing).toEqual([]);
  });

  test('every declared field is found, with its type, requiredness and constraints', () => {
    const problems: string[] = [];
    for (const form of truth.forms) {
      const found = formOn(form.route);
      if (!found) continue;
      for (const field of form.fields) {
        const discovered = found.fields.find(f => f.name === field.name);
        if (!discovered) { problems.push(`${form.id}.${field.name}: not found`); continue; }
        const expectedType = RENDERED_TYPE[field.type] ?? field.type;
        // A text input that declares itself more precisely (inputmode, autocomplete) is
        // reported as what it declares: a card number is not a free-text field.
        const refined = field.type === 'text' && TEXT_REFINEMENTS.includes(discovered.controlType);
        if (discovered.controlType !== expectedType && !refined) problems.push(`${form.id}.${field.name}: type ${discovered.controlType}, expected ${expectedType}`);
        if (discovered.required !== field.required) problems.push(`${form.id}.${field.name}: required=${discovered.required}`);
        for (const [key, value] of Object.entries(field.constraints)) {
          if (discovered.constraints[key] !== value) problems.push(`${form.id}.${field.name}: ${key}=${discovered.constraints[key]}, expected ${value}`);
        }
        if (field.options && field.type !== 'select') {
          const labels = discovered.options.map(o => o.label);
          if (!field.options.every(o => labels.includes(o))) problems.push(`${form.id}.${field.name}: options ${labels.join('|')}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('a field that appears only for some answers is found, with the answer that shows it', () => {
    const problems: string[] = [];
    for (const form of truth.forms) {
      for (const field of form.fields.filter(f => f.conditional)) {
        const found = formOn(form.route);
        const hit = found?.dependencies.find(d => d.trigger === field.conditional!.field && d.shows.includes(field.name));
        if (!hit) problems.push(`${form.id}.${field.name} shown by ${field.conditional!.field}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('a select whose options depend on another is found to depend on it', () => {
    const form = truth.forms.find(f => f.dependentOptions)!;
    const found = formOn(form.route)!;
    const hit = found.dependencies.filter(d => d.trigger === form.dependentOptions!.parent && d.optionsOf[form.dependentOptions!.child]);
    // One observation per country that changes the region list.
    expect(hit.length).toBeGreaterThanOrEqual(2);
    expect(hit.some(d => d.optionsOf[form.dependentOptions!.child]!.includes('Ontario'))).toBe(true);
  });

  test('a wizard is recognised as one, with its later steps', () => {
    for (const form of truth.forms.filter(f => f.multiStep)) {
      const found = formOn(form.route)!;
      expect(found.isMultiStep).toBe(true);
      expect(found.groupCount).toBe(new Set(form.fields.map(f => f.step)).size);
      const hidden = found.fields.filter(f => !f.visible).map(f => f.name);
      expect(hidden).toEqual(form.fields.filter(f => f.step !== 1).map(f => f.name));
    }
    // And a form with no steps is not mistaken for one.
    expect(formOn('/registration')!.isMultiStep).toBe(false);
  });

  test('a form in a closed dialog is found with its opener, and its fields as they are once it is open', () => {
    const form = formOn('/contact-modal')!;
    expect(form.hiddenAtLoad).toBe(true);
    expect(form.opener?.label).toBe('Contact us');
    // Once open every field shows; none is mistaken for a conditional field.
    expect(form.fields.every(field => field.visible)).toBe(true);
    expect(formOn('/registration')!.hiddenAtLoad).toBe(false);
  });

  test('an anti-forgery token is reported only where there is one', () => {
    const wrong = truth.forms
      .filter(form => formOn(form.route))
      .filter(form => formOn(form.route)!.hasCsrfToken !== form.hasCsrfToken)
      .map(form => form.id);
    expect(wrong).toEqual([]);
  });

  test('probing never submits a form', async () => {
    const records = await (await fetch(`${baseUrl}/api/records`)).json() as { records: unknown[] };
    expect(records.records).toEqual([]);
  });
});

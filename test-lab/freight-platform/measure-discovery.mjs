/**
 * Runs QA NXT's real discovery crawler against Meridian Freight and reports what it
 * reached, against ground truth, broken down by navigation shape.
 *
 * This drives `apps/browser-worker/src/discovery/crawler.ts` directly — the same class the
 * worker runs when the control plane queues a discovery job — in a real Chromium, against
 * the real application, signed in as a real user. Nothing is simulated.
 *
 * It is run three times, once per interaction mode, because the mode is the setting that
 * decides whether a crawl can see a routed screen at all, and the difference between the
 * three is the finding:
 *
 *   links        follows <a href> only
 *   navigation   additionally clicks navigation-shaped controls
 *   interactive  clicks every enabled control that is not shaped like a state change
 *
 * Usage, from apps/browser-worker so the worker's own imports resolve:
 *
 *   npx tsx ../../test-lab/freight-platform/measure-discovery.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { BrowserPool } from '../../apps/browser-worker/dist/browser/browser-pool.js';
import { Crawler } from '../../apps/browser-worker/dist/discovery/crawler.js';
import { Logger } from '../../apps/browser-worker/dist/util/logger.js';

const BASE = process.env.LAB_URL ?? 'http://127.0.0.1:4400';
const MODES = ['links', 'navigation', 'interactive'];

const groundTruth = JSON.parse(await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));

/** Every path the application declares, normalised for comparison. */
const declared = groundTruth.screens.list.map(screen => ({
  path: screen.path,
  sample: screen.sample,
  domain: screen.domain,
  shape: screen.shape,
  kind: screen.kind,
  requiresSignIn: screen.requiresSignIn
}));

/**
 * A crawled URL matches a declared screen when it equals the sample, or when it fits the
 * declared pattern. `/shipments/shp-0004` matches `/shipments/:id`.
 */
const patternMatches = (pattern, path) => {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${source}$`).test(path);
};

const logger = new Logger('error', {}, () => {});

const runs = [];

for (const mode of MODES) {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Discovery in "${mode}" mode`);
  console.log('─'.repeat(72));

  const artifactDir = await mkdtemp(join(tmpdir(), `meridian-${mode}-`));
  const pool = new BrowserPool(true, logger);
  const context = await pool.createContext('chromium', {
    defaultTimeoutMs: 15_000,
    navigationTimeoutMs: 30_000
  });

  const started = Date.now();
  let report;
  try {
    const crawler = new Crawler(context, {
      baseUrl: `${BASE}/dashboard`,
      artifactDir,
      navigationTimeoutMs: 30_000,
      auth: {
        strategy: 'formLogin',
        loginUrl: `${BASE}/auth/sign-in`,
        username: 'admin',
        password: 'Freight!2026',
        successUrlContains: '/dashboard'
      },
      budget: {
        allowedHosts: ['127.0.0.1'],
        excludedPathPrefixes: ['/auth/sign-out', '/__faults'],
        maxDepth: 6,
        // Generous on purpose: the question is what the crawler can REACH, not what a
        // budget let it finish. A budget that stopped the crawl would confound the two.
        maxPages: 300,
        maxActions: 4000,
        maxInstancesPerRouteShape: 3,
        timeoutSeconds: 900,
        allowPrivateNetworks: true,
        respectRobotsTxt: false,
        seedUrls: [],
        useSitemap: false,
        interactionMode: mode,
        allowStateChangingClicks: false
      },
      onProgress: (message, visited, queued) => {
        if (visited % 20 === 0) console.log(`  … ${visited} pages mapped, ${queued} queued`);
      }
    }, logger);

    report = await crawler.run(`measure-${mode}`, 'measure-worker');
  } finally {
    await context.close().catch(() => undefined);
    await pool.close().catch(() => undefined);
  }

  const elapsedSeconds = Math.round((Date.now() - started) / 1000);
  const reachedPaths = [...new Set(report.pages.map(page => new URL(page.url).pathname))];

  // Which declared screens were reached.
  const reached = declared.filter(screen =>
    reachedPaths.some(path => path === screen.sample || patternMatches(screen.path, path)));
  const missed = declared.filter(screen => !reached.includes(screen));

  const byShape = {};
  for (const shape of ['linked', 'routed']) {
    const total = declared.filter(s => s.shape === shape).length;
    const found = reached.filter(s => s.shape === shape).length;
    byShape[shape] = { total, reached: found, percent: total ? Math.round((found / total) * 1000) / 10 : null };
  }

  const byDomain = {};
  for (const domain of [...new Set(declared.map(s => s.domain))].sort()) {
    const total = declared.filter(s => s.domain === domain).length;
    const found = reached.filter(s => s.domain === domain).length;
    byDomain[domain] = { total, reached: found, shape: groundTruth.screens.navShape[domain] ?? 'linked' };
  }

  const elements = report.pages.reduce((sum, page) => sum + page.elements.length, 0);

  console.log(`\n  status            ${report.status}${report.errorMessage ? ` (${report.errorMessage})` : ''}`);
  console.log(`  took              ${elapsedSeconds}s`);
  console.log(`  pages mapped      ${report.pages.length}`);
  console.log(`  distinct paths    ${reachedPaths.length}`);
  console.log(`  elements captured ${elements}`);
  console.log(`  transitions       ${report.transitions.length}`);
  console.log(`\n  declared screens reached: ${reached.length} of ${declared.length} (${Math.round((reached.length / declared.length) * 1000) / 10}%)`);
  for (const [shape, figures] of Object.entries(byShape)) {
    console.log(`    ${shape.padEnd(8)} ${String(figures.reached).padStart(3)} of ${String(figures.total).padEnd(4)} ${figures.percent}%`);
  }
  console.log('\n  by domain:');
  for (const [domain, figures] of Object.entries(byDomain)) {
    const bar = figures.total ? '█'.repeat(Math.round((figures.reached / figures.total) * 20)).padEnd(20, '·') : ''.padEnd(20, '·');
    console.log(`    ${domain.padEnd(11)} ${bar} ${String(figures.reached).padStart(3)}/${String(figures.total).padEnd(3)} (${figures.shape})`);
  }

  runs.push({
    mode, status: report.status, elapsedSeconds,
    pagesMapped: report.pages.length,
    distinctPaths: reachedPaths.length,
    elementsCaptured: elements,
    transitions: report.transitions.length,
    declaredTotal: declared.length,
    declaredReached: reached.length,
    byShape, byDomain,
    reachedPaths: reachedPaths.sort(),
    missedScreens: missed.map(s => ({ path: s.path, domain: s.domain, shape: s.shape })),
    progressLog: report.progressLog ?? ''
  });

  await rm(artifactDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(72)}`);
console.log('SUMMARY');
console.log('═'.repeat(72));
console.log(`\n  Ground truth: ${declared.length} screens (${groundTruth.screens.byShape.linked} linked, ${groundTruth.screens.byShape.routed} routed)`);
console.log(`                plus ${groundTruth.enclosedSurfaces.length} enclosed surfaces with no URL at all\n`);
console.log('  mode          reached   linked        routed        time');
console.log('  ' + '-'.repeat(60));
for (const run of runs) {
  console.log(`  ${run.mode.padEnd(13)} ${String(run.declaredReached).padStart(3)}/${run.declaredTotal}   `
    + `${String(run.byShape.linked.reached).padStart(3)}/${String(run.byShape.linked.total).padEnd(3)} ${String(run.byShape.linked.percent + '%').padEnd(6)} `
    + `${String(run.byShape.routed.reached).padStart(3)}/${String(run.byShape.routed.total).padEnd(3)} ${String(run.byShape.routed.percent + '%').padEnd(6)} `
    + `${run.elapsedSeconds}s`);
}

const outputPath = new URL('./discovery-measurement.json', import.meta.url);
await writeFile(outputPath, JSON.stringify({
  measuredAt: new Date().toISOString(),
  application: 'Meridian Freight',
  baseUrl: BASE,
  crawler: 'apps/browser-worker/src/discovery/crawler.ts',
  groundTruth: {
    screens: groundTruth.screens.total,
    byShape: groundTruth.screens.byShape,
    enclosedSurfaces: groundTruth.enclosedSurfaces.length
  },
  runs
}, null, 2) + '\n');

console.log(`\n  Written to ${outputPath.pathname}\n`);

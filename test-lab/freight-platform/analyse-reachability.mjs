/**
 * Joins the discovery measurement to the defect ground truth.
 *
 * ## Why this number matters more than a detection rate
 *
 * Everything downstream of discovery works from the model discovery built. Test generation
 * plans against discovered pages and elements; execution drives what generation planned;
 * the security scanner attacks the discovered surface. So a defect sitting on a screen
 * discovery never reached is invisible to every one of those stages, however good they
 * are. No amount of generator quality recovers it.
 *
 * That makes "defects on unreached screens" a ceiling: the best possible detection rate
 * this platform could achieve on this application, before a single test is written. It is
 * computable without running generation or execution at all, which matters here because
 * the .NET control plane cannot run in this container.
 *
 *   node analyse-reachability.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';

const groundTruth = JSON.parse(await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const measurement = JSON.parse(await readFile(new URL('./discovery-measurement.json', import.meta.url), 'utf8'));

const patternMatches = (pattern, path) => {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${source}$`).test(path);
};

/** A defect's screen, as the catalogue records it, stripped of any query string. */
const screenOf = (defect) => defect.screen.split('?')[0];

const analysis = measurement.runs.map(run => {
  const reached = new Set(run.reachedPaths);

  const rows = groundTruth.defects.list.map(defect => {
    const screen = screenOf(defect);
    const screenReached = [...reached].some(path => path === screen || patternMatches(screen, path));
    const declaredScreen = groundTruth.screens.list.find(candidate => candidate.path === screen);
    return {
      id: defect.id,
      title: defect.title,
      domain: defect.domain,
      category: defect.category,
      severity: defect.severity,
      screen,
      shape: declaredScreen?.shape ?? 'enclosed-or-api',
      screenReached
    };
  });

  const reachable = rows.filter(row => row.screenReached);
  const unreachable = rows.filter(row => !row.screenReached);

  const byCategory = {};
  for (const row of rows) {
    byCategory[row.category] ??= { total: 0, reachable: 0 };
    byCategory[row.category].total += 1;
    if (row.screenReached) byCategory[row.category].reachable += 1;
  }

  const bySeverity = {};
  for (const row of rows) {
    bySeverity[row.severity] ??= { total: 0, reachable: 0 };
    bySeverity[row.severity].total += 1;
    if (row.screenReached) bySeverity[row.severity].reachable += 1;
  }

  return {
    mode: run.mode,
    screensReached: run.declaredReached,
    screensTotal: run.declaredTotal,
    defectsOnReachedScreens: reachable.length,
    defectsOnUnreachedScreens: unreachable.length,
    detectionCeilingPercent: Math.round((reachable.length / rows.length) * 1000) / 10,
    byCategory, bySeverity,
    rows
  };
});

// ---------------------------------------------------------------------------

console.log(`\n${'═'.repeat(76)}`);
console.log('DETECTION CEILING — how many planted defects discovery could even see');
console.log('═'.repeat(76));
console.log(`\n  ${groundTruth.defects.total} defects planted across ${Object.keys(groundTruth.defects.byDomain).length} domains.`);
console.log('  A defect on a screen discovery never reached cannot be found by generation,');
console.log('  execution or the security scanner, because all three work from the model.\n');

console.log('  mode          screens      defects reachable   ceiling');
console.log('  ' + '-'.repeat(60));
for (const run of analysis) {
  console.log(`  ${run.mode.padEnd(13)} ${String(run.screensReached).padStart(3)}/${String(run.screensTotal).padEnd(5)} `
    + `${String(run.defectsOnReachedScreens).padStart(9)}/${String(groundTruth.defects.total).padEnd(8)} `
    + `${run.detectionCeilingPercent}%`);
}

for (const run of analysis) {
  console.log(`\n${'─'.repeat(76)}`);
  console.log(`  "${run.mode}" mode — ${run.defectsOnUnreachedScreens} defect(s) out of reach:\n`);
  const unreachable = run.rows.filter(row => !row.screenReached);
  if (!unreachable.length) {
    console.log('    none — every planted defect sits on a screen discovery reached');
  } else {
    for (const row of unreachable) {
      console.log(`    ${row.id}`);
      console.log(`      ${row.title}`);
      console.log(`      ${row.screen}  [${row.shape}, ${row.severity}]`);
    }
  }
  console.log('\n  by severity:');
  for (const [severity, figures] of Object.entries(run.bySeverity)) {
    console.log(`    ${severity.padEnd(9)} ${figures.reachable}/${figures.total} reachable`);
  }
}

const outputPath = new URL('./reachability-analysis.json', import.meta.url);
await writeFile(outputPath, JSON.stringify({
  analysedAt: new Date().toISOString(),
  note: 'A detection ceiling, not a detection rate. It says how many planted defects sit on screens discovery reached; whether the platform would then FIND them needs generation and execution, which this container cannot run.',
  defectsTotal: groundTruth.defects.total,
  runs: analysis
}, null, 2) + '\n');

console.log(`\n  Written to ${outputPath.pathname}\n`);

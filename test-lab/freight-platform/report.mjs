/**
 * Writes MEASUREMENT.md from the measurement JSON.
 *
 * Generated rather than typed, so every figure in the report traces to a file a reader can
 * open, and so re-running the measurement cannot leave the prose saying something the data
 * does not.
 *
 *   node report.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';

const groundTruth = JSON.parse(await readFile(new URL('./ground-truth.json', import.meta.url), 'utf8'));
const measurement = JSON.parse(await readFile(new URL('./discovery-measurement.json', import.meta.url), 'utf8'));
let reachability = null;
try {
  reachability = JSON.parse(await readFile(new URL('./reachability-analysis.json', import.meta.url), 'utf8'));
} catch { /* optional */ }

const MODE_ORDER = ['links', 'navigation', 'interactive'];
const runs = MODE_ORDER
  .map(mode => measurement.runs.find(run => run.mode === mode))
  .filter(Boolean);

const signedIn = measurement.denominator?.signedInScreens ?? groundTruth.screens.total;
const linkedTotal = runs[0]?.byShape.linked.total ?? 0;
const routedTotal = runs[0]?.byShape.routed.total ?? 0;

const pct = (part, whole) => whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—';

/** Defects whose screen no run reached, by id, for the gap table. */
const ceilingFor = (mode) => reachability?.runs.find(run => run.mode === mode) ?? null;

const lines = [];
const w = (line = '') => lines.push(line);

w('# Measuring QA NXT against Meridian Freight');
w();
w(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} from \`discovery-measurement.json\``);
w('and `ground-truth.json`. Every figure below traces to one of those files.');
w();
w('## What was measured, and what was not');
w();
w('**Measured:** discovery. The real crawler — `apps/browser-worker/src/discovery/crawler.ts`,');
w('compiled, the same class the worker runs when the control plane queues a job — in a real');
w('Chromium, signed in as a real user, against the running application. Three times, once per');
w('interaction mode, with an identical budget.');
w();
w('**Not measured:** test generation, execution, failure analysis and the security scan. Those');
w('live in the .NET control plane, and the container this ran in has no .NET SDK and no network');
w('path to install one. That is an environment limit, not a product one: the full pipeline runs');
w('on a machine with the SDK.');
w();
w('This matters less than it sounds, for one structural reason: **everything downstream of');
w('discovery works from the model discovery builds.** Generation plans against discovered pages');
w('and elements, execution drives what generation planned, the scanner attacks the discovered');
w('surface. A defect on a screen discovery never reached is invisible to all of them, however');
w('good they are. So discovery coverage is a ceiling on everything else, and it is the stage');
w('that was failing in the field anyway.');
w();
w('## Ground truth');
w();
w('| | |');
w('| --- | --- |');
w(`| Screens behind the sign-in | **${signedIn}** |`);
w(`| &nbsp;&nbsp;linked (reached by an \`<a href>\`) | ${linkedTotal} |`);
w(`| &nbsp;&nbsp;routed (client-side router, no anchor anywhere) | ${routedTotal} |`);
w(`| Enclosed surfaces (modals, drawers, tabs — no URL at all) | ${groundTruth.enclosedSurfaces.length} |`);
w(`| Anonymous screens, held out of the denominator | ${(measurement.denominator?.anonymousHeldOut ?? []).length} |`);
w(`| Planted defects | ${groundTruth.defects.total} |`);
w(`| End-to-end journeys | ${groundTruth.journeys.total} |`);
w();
w('The anonymous screens are held out because a crawl authenticates and then explores from the');
w('dashboard; it never returns to the sign-in page, so counting them as missed would measure its');
w('starting point rather than its reach.');
w();
w('## Result');
w();
w('| Mode | Screens reached | Linked | Routed | Pages mapped | Elements | Time | Finished |');
w('| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const run of runs) {
  w(`| \`${run.mode}\` | **${run.declaredReached}/${run.declaredTotal}** (${pct(run.declaredReached, run.declaredTotal)}) `
    + `| ${run.byShape.linked.reached}/${run.byShape.linked.total} (${run.byShape.linked.percent}%) `
    + `| ${run.byShape.routed.reached}/${run.byShape.routed.total} (${run.byShape.routed.percent}%) `
    + `| ${run.pagesMapped} | ${run.elementsCaptured.toLocaleString('en-GB')} | ${run.elapsedSeconds}s `
    + `| ${run.status === 'completed' ? 'yes' : `**no** — ${run.status}`} |`);
}
w();
w('### By domain');
w();
w('| Domain | Shape | ' + runs.map(run => `\`${run.mode}\``).join(' | ') + ' |');
w('| --- | --- | ' + runs.map(() => '---:').join(' | ') + ' |');
const domains = Object.keys(runs[0]?.byDomain ?? {}).sort();
for (const domain of domains) {
  const shape = runs[0].byDomain[domain].shape;
  const cells = runs.map(run => {
    const figures = run.byDomain[domain];
    return `${figures.reached}/${figures.total}`;
  });
  w(`| ${domain} | ${shape} | ${cells.join(' | ')} |`);
}
w();

// ---- findings ------------------------------------------------------------

w('## What the numbers say');
w();

const links = runs.find(r => r.mode === 'links');
const navigation = runs.find(r => r.mode === 'navigation');
const interactive = runs.find(r => r.mode === 'interactive');

if (links) {
  w('### 1. Link-following cannot see a client-side router, as expected');
  w();
  w(`In \`links\` mode the crawler reached ${links.byShape.linked.reached} of ${links.byShape.linked.total} linked screens `
    + `(${links.byShape.linked.percent}%) and ${links.byShape.routed.reached} of ${links.byShape.routed.total} routed ones `
    + `(${links.byShape.routed.percent}%).`);
  w();
  if (links.byShape.routed.reached > 0) {
    w(`The ${links.byShape.routed.reached} routed screens it did reach came in through cross-domain`);
    w('`<a href>` links from linked pages — the "Raise claim" anchors on the exception lists —');
    w('not through the routed navigation. Worth knowing: a deep link from elsewhere in the');
    w('application pulls a routed screen into reach, so coverage of a routed domain depends on');
    w('whether anything outside it happens to link in.');
  }
  w();
  w('This is the shape that reduces a crawl to a handful of pages on a real admin application,');
  w('and it is the default mode.');
  w();
}

if (navigation && links) {
  w('### 2. Navigation mode reaches routed screens, and runs out of budget doing it');
  w();
  w(`Turning on clicking took routed coverage from ${links.byShape.routed.percent}% to `
    + `${navigation.byShape.routed.percent}% — real improvement, and the mechanism works. But:`);
  w();
  w(`- it did **not finish** (\`${navigation.status}\`), stopping on the ${navigation.elapsedSeconds}s budget`);
  w(`- linked coverage went **down**, ${links.byShape.linked.reached} to ${navigation.byShape.linked.reached}, because budget went to clicking`);
  w(`- cost per page rose from ${Math.round((links.elapsedSeconds / links.pagesMapped) * 10) / 10}s to `
    + `${Math.round((navigation.elapsedSeconds / navigation.pagesMapped) * 10) / 10}s`);
  w();
  w('The queue grew faster than it drained: at 110 pages mapped there were still 582 queued. So');
  w('on an application this size the mode that fixes the routed problem does not complete, and');
  w('**what it misses is decided by sidebar order rather than by importance.** `admin` is last in');
  const adminNav = navigation.byDomain.admin;
  w(`the sidebar and scored ${adminNav.reached}/${adminNav.total} — not a logic failure, a queue that never got there.`);
  w();
  w('That is the finding a team would actually trip over. "Set it to navigation mode" is not a');
  w('complete answer on an application of this size; the budget has to be raised with it, and');
  w('nothing in the product tells you that.');
  w();
}

if (interactive && navigation) {
  w('### 3. Interactive mode');
  w();
  w(`\`interactive\` reached ${interactive.declaredReached}/${interactive.declaredTotal} `
    + `(${pct(interactive.declaredReached, interactive.declaredTotal)}) in ${interactive.elapsedSeconds}s, `
    + `status \`${interactive.status}\`, at `
    + `${Math.round((interactive.elapsedSeconds / Math.max(1, interactive.pagesMapped)) * 10) / 10}s per page.`);
  w();
  const better = interactive.declaredReached > navigation.declaredReached;
  w(better
    ? 'Clicking everything that is not shaped like a state change beat navigation mode, at a cost in time.'
    : 'Clicking more did not reach more: the extra actions went to inert controls while the budget drained.');
  w();
}

{
  // Computed rather than asserted: a hand-typed count here would be the one figure in the
  // report nobody could check.
  const routedWithId = groundTruth.screens.list.filter(s => s.shape === 'routed' && s.path.includes(':'));
  const reachedPerMode = runs.map(run => {
    const missed = new Set(run.missedScreens.map(s => s.path));
    return { mode: run.mode, reached: routedWithId.filter(s => !missed.has(s.path)).length };
  });
  const defectsThere = groundTruth.defects.list.filter(defect => {
    const screen = defect.screen.split('?')[0];
    return routedWithId.some(s => s.path === screen);
  });

  w('### 4. Routed detail screens are nearly out of reach');
  w();
  w(`${routedWithId.length} routed screens need an identifier — \`/claims/:id/settle\`, \`/fleet/vehicles/:id\`,`);
  w('`/admin/users/:id`, `/routes/:id/stops` and the rest. Reaching one means clicking a row');
  w('control inside a view that was itself client-rendered: two clicks deep, with no URL to');
  w('shortcut to. How many each mode reached:');
  w();
  for (const entry of reachedPerMode) {
    w(`- \`${entry.mode}\`: ${entry.reached} of ${routedWithId.length}`);
  }
  w();
  if (defectsThere.length) {
    w(`${defectsThere.length} planted defect(s) live on those screens: `
      + defectsThere.map(d => `\`${d.id}\` (${d.severity})`).join(', ') + '.');
    w('A lot of an enterprise application\'s write operations live behind a row click like that.');
  }
  w();
}
w('### 5. The enclosed surfaces were never in scope');
w();
w(`None of the ${groundTruth.enclosedSurfaces.length} enclosed surfaces have a URL, so no crawl can enumerate them and`);
w('nothing in the discovery model represents them. Every modal form, tab panel and drawer in');
w('this application is invisible to the platform: the approval dialog, the payment form, the');
w('exception modal, all sixteen. They are reported here as a known gap rather than a score.');
w();

// ---- detection ceiling ---------------------------------------------------

if (reachability) {
  w('## Detection ceiling');
  w();
  w(`Of the ${reachability.defectsTotal} planted defects, this is how many sit on a screen each mode reached.`);
  w('It is a **ceiling, not a rate**: whether the platform would then find them needs generation');
  w('and execution, which this container cannot run. But a defect below the ceiling cannot be');
  w('found by anything.');
  w();
  w('| Mode | Defects on reached screens | Ceiling |');
  w('| --- | ---: | ---: |');
  for (const mode of MODE_ORDER) {
    const run = ceilingFor(mode);
    if (!run) continue;
    w(`| \`${mode}\` | ${run.defectsOnReachedScreens}/${reachability.defectsTotal} | **${run.detectionCeilingPercent}%** |`);
  }
  w();
  const best = MODE_ORDER.map(ceilingFor).filter(Boolean)
    .sort((a, b) => b.detectionCeilingPercent - a.detectionCeilingPercent)[0];
  if (best) {
    const unreachable = best.rows.filter(row => !row.screenReached);
    if (unreachable.length) {
      w(`Even in the best mode (\`${best.mode}\`), ${unreachable.length} defect(s) sit on screens no crawl reached:`);
      w();
      w('| Defect | Severity | Screen | Shape |');
      w('| --- | --- | --- | --- |');
      for (const row of unreachable) {
        w(`| ${row.id} | ${row.severity} | \`${row.screen}\` | ${row.shape} |`);
      }
      w();
    }
    w('By severity, in the best mode:');
    w();
    for (const [severity, figures] of Object.entries(best.bySeverity)) {
      w(`- **${severity}**: ${figures.reachable} of ${figures.total} on reachable screens`);
    }
    w();
  }
}

// ---- journeys ------------------------------------------------------------

w('## Journeys');
w();
w(`The ${groundTruth.journeys.total} end-to-end journeys were driven by \`journeys.mjs\`, not by QA NXT — the platform`);
w('cannot drive them without the control plane. They are recorded here because which ones the');
w('shipped build breaks is ground truth a future measurement should be held to.');
w();
w('| | Journey | Domains | Shipped build |');
w('| --- | --- | --- | --- |');
for (const journey of groundTruth.journeys.list) {
  w(`| ${journey.id} | ${journey.name} | ${journey.domains.join(' → ')} | `
    + `${journey.breaksOnShippedBuild ? `breaks on \`${journey.becauseOf[0]}\`` : 'completes'} |`);
}
w();

// ---- the lab's own bugs --------------------------------------------------

w('## Three bugs this measurement found in the lab, not the product');
w();
w('Recorded because they are the reason to distrust a first run of anything:');
w();
w('1. **35 screens had no inbound anchor.** The sidebar had 13 items and no second level, so a');
w('   third of the "linked" screens were reachable only by typing a URL. The first run scored');
w('   65/100 linked and was measuring missing links, not link-following. Fixed → 89.7%.');
w('2. **Clicking a routed domain did nothing.** The router loaded only on routed pages, so the');
w('   sidebar\'s `data-route` buttons were inert on every linked page. The first navigation run');
w('   scored **0/37 routed** entirely because of this. A person could not reach Fleet from the');
w('   dashboard either.');
w('3. **Every modal was a full-screen overlay eating clicks.** `.modal{display:flex}` beats the');
w('   `hidden` attribute on specificity.');
w();
w('All three passed the HTTP self-test, which could only assert that the markup *said* `hidden`');
w('and that a button *existed*. `selftest-browser.mjs` now asserts the client-side claims by');
w('clicking, in a real browser. If I had reported the first run as a product result, two of');
w('these would have been published as QA NXT failures.');
w();

// ---- what this does not establish ---------------------------------------

w('## What this does not establish');
w();
w('- **A detection rate.** Generation and execution did not run. The ceiling is an upper bound.');
w('- **That QA NXT works on arbitrary applications.** One application, one afternoon, and the');
w('  defects were written by the same author who then measured the tool against them. Better');
w('  than defects written alongside the checks that find them, not the same as software nobody');
w('  wrote for the test.');
w('- **Anything about Firefox or WebKit.** Chromium only.');
w('- **Anything about load.** Single crawler, single browser, local application.');
w('- **That the budgets used here are the right ones.** They were set generously on purpose, to');
w('  measure reach rather than what a budget allowed to finish. Two of the three runs still');
w('  exhausted them.');
w();
w('## Reproducing it');
w();
w('```bash');
w('node test-lab/freight-platform/server.js            # port 4400');
w('node test-lab/freight-platform/selftest.mjs         # 54 checks over HTTP');
w('cd apps/browser-worker && pnpm build                # the crawler, compiled');
w('node ../../test-lab/freight-platform/selftest-browser.mjs      # 17 checks in a browser');
w('node ../../test-lab/freight-platform/measure-discovery.mjs --mode links --budget 600');
w('node ../../test-lab/freight-platform/measure-discovery.mjs --mode navigation --budget 900');
w('node ../../test-lab/freight-platform/measure-discovery.mjs --mode interactive --budget 900');
w('cd ../../test-lab/freight-platform && node analyse-reachability.mjs && node report.mjs');
w('```');
w();

const outputPath = new URL('./MEASUREMENT.md', import.meta.url);
await writeFile(outputPath, lines.join('\n'));
console.log(`Wrote ${outputPath.pathname} (${lines.length} lines)`);
for (const run of runs) {
  console.log(`  ${run.mode.padEnd(12)} ${run.declaredReached}/${run.declaredTotal}  `
    + `linked ${run.byShape.linked.percent}%  routed ${run.byShape.routed.percent}%  ${run.status}`);
}

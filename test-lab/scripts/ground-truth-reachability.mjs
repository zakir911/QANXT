#!/usr/bin/env node
/**
 * Which planted defects sit on a screen the crawl never reached.
 *
 * The question this exists to ask is "does anything reach the place the defect lives", and it
 * is worth asking separately from "was the defect detected" because the two look identical in
 * a detection count and have nothing else in common. A defect on a screen nothing reached is
 * a mapping problem. A defect on a screen that was mapped and still went unreported is a
 * detection problem. Chasing the second while the cause is the first wastes the day.
 *
 * It cost a day to learn that. clinic-spa's CS_D04 read as undetected through three runs and
 * two written explanations, and the cause was that the application never issued the request
 * at all: the fixture drew a Cancel button wired to nothing. Nobody asked whether the thing
 * was reachable, because nothing asked it for them.
 *
 * What it cannot do, said plainly: it cannot tell a gap in the product from a fixture that
 * does not exercise its own route. Both show up as "nothing reached this". Naming the screen
 * is the whole contribution — the looking is still a person's job.
 *
 * Nor is "nothing reached it" the same as "untested". token-api demonstrates both halves at
 * once: nothing crawled /api/auth/token, and TA_D03 on that endpoint is detected anyway,
 * because the application *declares* where it signs in and the scan reads the declaration
 * rather than waiting to observe one. An address can be tested without being walked to. So
 * read this list as "screens worth a look", never as a count of what was missed.
 *
 *   node test-lab/scripts/ground-truth-reachability.mjs <ground-truth.json> <routes-file>
 *
 * where routes-file holds one mapped route per line, as
 *   psql -tAc "select distinct route from application_pages where application_id='...'"
 * produces. Reads `defects.list[].screen` (freight) or `defects[].routes[]` (the small
 * targets), so it works against either shape of ground truth.
 */
import { readFile } from 'node:fs/promises';

const [groundTruthPath, routesPath] = process.argv.slice(2);
if (!groundTruthPath || !routesPath) {
  console.error('usage: ground-truth-reachability.mjs <ground-truth.json> <routes-file>');
  process.exit(2);
}

const truth = JSON.parse(await readFile(groundTruthPath, 'utf8'));
const reached = (await readFile(routesPath, 'utf8')).split('\n').map(l => l.trim()).filter(Boolean);

/** Both ground-truth shapes, as one list of { id, label, screens }. */
const planted = Array.isArray(truth.defects?.list)
  ? truth.defects.list.map(d => ({ id: d.id, label: d.category ?? '', screens: [d.screen].filter(Boolean) }))
  : (truth.defects ?? []).map(d => ({ id: d.id, label: d.class ?? '', screens: d.routes ?? [] }));

/** The path, without the query: a route column does not carry one. */
const pathOf = (value) => String(value).split('?', 1)[0];

/** A screen matches a mapped route when they are the same path, allowing :id and {id} holes. */
const matches = (screen, route) => {
  const pattern = new RegExp('^' + pathOf(screen).split('/')
    .map(part => (part.startsWith(':') || /^\{.+\}$/.test(part)
      ? '[^/]+'
      : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/') + '$');
  return pattern.test(pathOf(route));
};

const rows = planted.map(d => ({
  ...d,
  // A defect naming several routes is reached if any of them was.
  reached: d.screens.some(screen => reached.some(route => matches(screen, route))),
  // Kept apart from reachability: a defect that lives in a query parameter is on a screen
  // that was mapped, and reporting it as unreached would be wrong in a way that sends
  // somebody looking at the crawler for a detection problem.
  inQuery: d.screens.some(screen => screen.includes('?'))
}));

const unreached = rows.filter(r => r.screens.length > 0 && !r.reached);
const queryBorne = rows.filter(r => r.reached && r.inQuery);

console.log(`${truth.application ?? truth.name ?? groundTruthPath}`);
console.log(`  planted defects      ${rows.length}`);
console.log(`  routes mapped        ${reached.length}`);
console.log(`  screens reached      ${rows.length - unreached.length} of ${rows.length}`);

if (unreached.length) {
  console.log(`\n  nothing reached the screen these ${unreached.length} live on:`);
  for (const r of unreached) console.log(`    ${r.id.padEnd(44)} ${String(r.label).padEnd(16)} ${r.screens.join(', ')}`);
  console.log('\n    a gap in the crawl, or a fixture that does not exercise its own route.');
  console.log('    this cannot tell which; go and look before reading the detection count.');
}

if (queryBorne.length) {
  console.log(`\n  reached by path, defect lives in a query parameter (${queryBorne.length}):`);
  for (const r of queryBorne) console.log(`    ${r.id.padEnd(44)} ${r.screens.join(', ')}`);
}

if (!unreached.length) console.log('\n  every planted defect sits on a screen something reached.');

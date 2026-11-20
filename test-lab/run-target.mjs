/**
 * Runs QA NXT end to end against any target in this lab, from a descriptor.
 *
 * Meridian Freight has its own driver because it is the big one and it grew a lot of
 * specific measurement. Everything learned there is in it, and none of it is reusable:
 * adding a target meant copying 400 lines and editing the names, which is how the lab
 * came to prove the engines against exactly one application.
 *
 * This is the generic path. A target is a directory with a `target.json` saying where it
 * is, how to sign in, what it is built out of, and what was planted in it. The driver
 * does what a team would: register it, discover it, design the deterministic form-level
 * suite, run it in a real browser, scan it, then join every failure and finding back to
 * the planted list.
 *
 * AI is off throughout, for the same reason as the freight driver: the claim worth
 * testing is the deterministic engine, and a hosted model makes a run unreproducible.
 *
 *   node run-target.mjs clinic-spa [permits-legacy ...] [--budget 240] [--parallelism 4]
 *
 * Writes <target>/run-result.json per target and prints one table across all of them.
 */
import { readFile, writeFile } from 'node:fs/promises';
import {
  request, newTenant, createProject, registerApplication, runDiscovery,
  applicationModel, waitForRun
} from '../verification/golden-tests/platform.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const targetKeys = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

const line = (text = '') => console.log(text);
const section = (title) => { line(); line('─'.repeat(78)); line(`  ${title}`); line('─'.repeat(78)); };

/**
 * Does a failure or finding describe this planted defect?
 *
 * Route first, because a route is a fact and prose is an opinion — the freight run spent
 * two rounds crediting defects from keyword matches that turned out to be about a
 * different screen. A keyword match alone is recorded as weak and shown as such rather
 * than counted silently.
 */
function matches(defect, evidence) {
  const route = (evidence.route ?? '').toLowerCase();
  const text = [evidence.message, evidence.asserts, evidence.name, evidence.code, evidence.checkId]
    .filter(Boolean).join(' ').toLowerCase();
  // A defect names every route its evidence can legitimately appear on: the screen a user
  // meets it through as well as the endpoint behind it. Recording only the endpoint hid a
  // true detection — "Schedule: refuses End before Start" is about /schedule, and the
  // planted route said /api/appointments.
  const routeHit = route !== '' && defect.routes.some(candidate => {
    const pattern = candidate.toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z0-9_]+/gi, '[^/]+');
    return new RegExp(`^${pattern}$`).test(route.split('?')[0]);
  });
  const keywordHits = defect.keywords.filter(k => text.includes(k.toLowerCase()));
  if (routeHit && keywordHits.length) return { strength: 'route and wording', keywordHits };
  // Route alone is not a detection. On an application with two forms, every piece of
  // evidence about either of them matches the route of whatever was planted there: the
  // first run of this driver credited an unescaped-search-term defect to a finding that
  // said "term has no label tied to it", which is true, is about the same form, and is
  // not that defect.
  if (routeHit) return { strength: 'same screen, different subject', keywordHits };
  if (keywordHits.length >= 2) return { strength: 'wording only, no route', keywordHits };
  return null;
}

/**
 * Which screen a piece of evidence is about.
 *
 * A test case is named "<form name>: <what it checks>" and a page test "Page <route>: ...",
 * so the name carries the screen. That is a convention of the product's own naming rather
 * than a field, which is worth saying plainly: when it changes, this stops working and the
 * verdicts fall back to wording, which is visible in the report rather than silent.
 */
/** The path of an endpoint, however it was written down. */
function pathOf(endpoint) {
  if (!endpoint) return null;
  const text = String(endpoint).replace(/^[A-Z]+\s+/, '');
  try { return new URL(text).pathname; } catch { /* not absolute */ }
  const path = text.split('?')[0];
  return path.startsWith('/') ? path : null;
}

function routeFromName(name, forms) {
  const subject = String(name ?? '').split(':')[0]?.trim() ?? '';
  const page = /^Page\s+(\S+)/.exec(subject);
  if (page) return page[1];
  const form = forms.find(f => f.name === subject);
  return form?.route ?? null;
}

async function runOne(key) {
  const target = JSON.parse(await readFile(new URL(`./${key}/target.json`, import.meta.url), 'utf8'));
  const budget = Number(flag('budget', target.budgetSeconds ?? 240));
  const maxPages = Number(flag('max-pages', target.maxPages ?? 40));

  section(`${target.name}  (${key})`);
  line(`  built as: ${target.technology}`);
  line(`  domain:   ${target.domain}`);
  line(`  planted:  ${target.defects.length} defect(s)`);

  const result = {
    key, name: target.name, technology: target.technology, domain: target.domain,
    ranAt: new Date().toISOString(), planted: target.defects.length, stages: {}
  };

  // A target that keeps what earlier runs put into it is not the same target twice. The
  // clinic application accumulated appointments across three runs: its buttons went from 34
  // to 185, and a page-width check then reported 38,963px of sideways scroll, which was
  // leftover test data rather than anything about the application. Where a target offers a
  // reset, the run starts from the seeded state.
  if (target.resetUrl) {
    const reset = await fetch(target.resetUrl, { method: 'POST' }).then(r => r.status).catch(() => null);
    line(`  reset ${target.resetUrl} → ${reset ?? 'not reachable'}`);
  }

  const reachable = await fetch(target.healthUrl, {
    headers: target.auth.strategy === 'basicAuth'
      ? { authorization: `Basic ${Buffer.from(`${target.auth.username}:${target.auth.password}`).toString('base64')}` }
      : {}
  }).then(r => r.status).catch(() => null);
  if (reachable === null) {
    line(`\n  Not reachable at ${target.healthUrl}. Start it with: ${target.start}`);
    return { ...result, unreachable: true };
  }
  line(`  reachable: ${target.healthUrl} → ${reachable}`);

  // ---- register ------------------------------------------------------------
  const tenant = await newTenant(`Target-${key}`);
  const project = await createProject(tenant, target.name,
    { aiEnabled: false, aiProvider: 'local', healingPolicy: 'suggest' });
  const application = await registerApplication(tenant, project.id, {
    name: target.name, baseUrl: target.baseUrl,
    strategy: target.auth.strategy,
    loginUrl: target.auth.loginUrl,
    username: target.auth.username, password: target.auth.password,
    bearerToken: target.auth.bearerToken,
    maxPages
  });
  await request(`/api/v1/applications/${application.id}`, {
    token: tenant.token, method: 'PATCH',
    body: {
      maxPages, maxCrawlDepth: 6, explorationTimeoutSeconds: budget,
      maxActions: Number(flag('max-actions', 1500)),
      interactionMode: 'navigation', respectRobotsTxt: false, useSitemap: false
    }
  });
  line(`  application ${application.id}, auth ${target.auth.strategy}, budget ${budget}s`);
  result.stages.application = { id: application.id, authStrategy: target.auth.strategy, budget, maxPages };

  // ---- discovery -----------------------------------------------------------
  const discoveryStarted = Date.now();
  const discovery = await runDiscovery(tenant, application.id, {
    maxPages, maxDepth: 6, timeoutSeconds: budget, timeoutMs: (budget + 180) * 1000
  });
  const model = await applicationModel(tenant, application.id);
  const pages = model.pages ?? [];
  const elements = model.elements ?? [];
  const byKind = {};
  for (const element of elements) byKind[element.kind] = (byKind[element.kind] ?? 0) + 1;
  line(`\n  discovery ${discovery.status} in ${Math.round((Date.now() - discoveryStarted) / 1000)}s: `
    + `${pages.length} page(s), ${elements.length} element(s), ${(model.endpoints ?? []).length} endpoint(s)`);
  line(`  element kinds: ${Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', ') || '(none)'}`);
  const paths = [...new Set(pages.map(p => {
    try { return new URL(p.url ?? p.normalizedUrl).pathname; } catch { return p.route ?? ''; }
  }))].filter(Boolean).sort();
  line(`  paths: ${paths.join(' ') || '(none)'}`);
  result.stages.discovery = {
    status: discovery.status, pages: pages.length, elements: elements.length,
    endpoints: (model.endpoints ?? []).length, byKind, paths,
    message: discovery.message ?? discovery.summary ?? null
  };

  // ---- forms the extractor captured ---------------------------------------
  const forms = await request(`/api/v1/applications/${application.id}/forms`, { token: tenant.token });
  const formList = forms.json?.items ?? forms.json ?? [];
  line(`  forms: ${formList.length}`
    + (formList.length ? ` (${formList.map(f => f.route ?? f.name).join(', ')})` : ''));
  result.stages.forms = {
    count: formList.length,
    list: formList.map(f => ({ id: f.id, route: f.route, name: f.name, fields: f.fieldCount ?? f.fields?.length ?? 0 }))
  };

  if (pages.length === 0) {
    line('\n  Discovery mapped nothing, so everything downstream would report zero from an');
    line('  empty model rather than from the application. The run stops here.');
    await writeFile(new URL(`./${key}/run-result.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
    return result;
  }

  // ---- design the deterministic suite --------------------------------------
  const designed = await request(`/api/v1/applications/${application.id}/form-tests/generate`, {
    token: tenant.token, method: 'POST', body: { suiteName: `${target.name} — form level` }
  });
  if (!designed.ok) {
    line(`\n  form-test design REFUSED ${designed.status}: ${designed.text.slice(0, 200)}`);
    result.stages.design = { ok: false, status: designed.status, body: designed.text.slice(0, 400) };
  } else {
    const design = designed.json ?? {};
    line(`\n  designed ${design.testsCreated ?? 0} test(s) from ${design.forms ?? 0} form(s); `
      + `${design.gaps ?? 0} gap(s), ${design.humanTasks ?? 0} human task(s), `
      + `${design.findings ?? 0} structural finding(s); usedAi=${design.usedAi === true}`);
    result.stages.design = design;
  }

  // ---- authorize and run a security scan -----------------------------------
  //
  // `includeSecurity: true` on the run is not enough on its own, and the first pass of this
  // driver reported "0 security finding(s)" on both targets because of it. The scan refuses
  // every check against an application whose scope has not been authorized, and every
  // authorization check reports inconclusive without two identities to compare. Both are
  // the scanner behaving correctly; a driver that does not supply them is measuring nothing.
  //
  // Active testing is granted because these are synthetic applications on loopback holding
  // no real data, built for this exercise. Destructive testing stays off: it is a separate
  // decision and nothing here needs it.
  const host = new URL(target.baseUrl).hostname;
  const scope = await request(`/api/v1/security/applications/${application.id}/scope`, {
    token: tenant.token, method: 'PUT',
    body: {
      enabled: true, allowedDomains: host, allowedApiDomains: host,
      allowActiveTesting: true, allowDestructiveTesting: false,
      authorizationNote: `Synthetic ${target.domain} application on loopback, built for this `
        + 'exercise and authorized for active security testing, excluding destructive checks. '
        + 'No real system and no real data is involved.'
    }
  });
  line(`  security scope ${scope.status}${scope.ok ? '' : ` — ${scope.text.slice(0, 160)}`}`);

  const scanStarted = await request('/api/v1/security/scans/start', {
    token: tenant.token, method: 'POST',
    body: { applicationId: application.id, profile: 'standard', identities: target.identities ?? [] }
  });
  let scan = null;
  if (!scanStarted.ok) {
    line(`  scan REFUSED ${scanStarted.status}: ${scanStarted.text.slice(0, 200)}`);
    result.stages.scan = { ok: false, status: scanStarted.status, body: scanStarted.text.slice(0, 400) };
  } else {
    const scanId = scanStarted.json?.securityScanId ?? scanStarted.json?.id;
    line(`  scan ${scanId}: ${scanStarted.json?.targets ?? '?'} target(s), `
      + `${scanStarted.json?.checksToRun ?? '?'} of ${scanStarted.json?.checksConfigured ?? '?'} check(s) to run`);
    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      const read = await request(`/api/v1/security/scans/${scanId}`, { token: tenant.token });
      scan = read.json ?? null;
      const status = String(scan?.status ?? '').toLowerCase();
      if (['completed', 'failed', 'abandoned', 'cancelled'].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    const untested = scan?.untestedReasons ?? scan?.untested ?? null;
    line(`  scan ${scan?.status ?? 'unknown'}: ${scan?.requestsSent ?? '?'} request(s), `
      + `${(scan?.findings ?? []).length} finding(s)`
      + (untested ? `, ${Array.isArray(untested) ? untested.length : Object.keys(untested).length} untested reason(s)` : ''));
    result.stages.scan = {
      ok: true, id: scanId, status: scan?.status ?? null,
      requestsSent: scan?.requestsSent ?? null,
      checksRun: scan?.checksRun ?? null,
      untested
    };
  }

  // ---- run it --------------------------------------------------------------
  const started = await request(`/api/v1/applications/${application.id}/runs`, {
    timeoutMs: 5 * 60 * 1000,
    token: tenant.token, method: 'POST',
    body: {
      mode: 'all', name: `${target.name} — all`, browser: 'chromium', headless: true,
      // The scan above is the security measurement, with an authorized scope and
      // identities; asking the run to scan again would only scan a second time without them.
      includeSecurity: false,
      parallelism: Number(flag('parallelism', 4))
    }
  });
  if (!started.ok) {
    line(`  run REFUSED ${started.status}: ${started.text.slice(0, 200)}`);
    result.stages.run = { ok: false, status: started.status, body: started.text.slice(0, 400) };
    await writeFile(new URL(`./${key}/run-result.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  const runId = started.json?.testRunId ?? started.json?.runId ?? started.json?.id;
  line(`  run ${runId} with ${started.json?.selected ?? started.json?.testCaseCount ?? '?'} test(s)`);
  const finished = await waitForRun(tenant, runId, 30 * 60 * 1000);
  const executions = await request(`/api/v1/testruns/${runId}/executions?pageSize=2000`,
    { token: tenant.token });
  const rows = executions.json?.items ?? executions.json ?? [];
  const screens = result.stages.forms.list ?? [];
  const byStatus = {};
  for (const row of rows) {
    const status = String(row.status).toLowerCase();
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  const failures = rows.filter(r => String(r.status).toLowerCase() === 'failed');
  line(`  ${finished.status}: ${rows.length} execution(s) — `
    + Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(', '));
  result.stages.run = {
    ok: true, runId, status: finished.status, executions: rows.length, byStatus,
    failures: failures.map(f => ({
      name: f.testCaseName ?? f.name,
      route: routeFromName(f.testCaseName ?? f.name, screens),
      // The executions API calls this errorMessage. Reading failureMessage gave every
      // failure an empty message and left the join nothing to read.
      message: (f.errorMessage ?? f.failureMessage ?? f.message ?? '').slice(0, 400)
    }))
  };

  // ---- what the engine concluded ------------------------------------------
  // The routes, which cost a round of measurement each time they were guessed: defects are
  // project-scoped and narrowed by application, structural findings hang off the
  // application, and security findings live under the security controller.
  const defects = await request(
    `/api/v1/defects?projectId=${project.id}&applicationId=${application.id}`, { token: tenant.token });
  const defectList = defects.json?.items ?? defects.json ?? [];
  const findings = await request(
    `/api/v1/applications/${application.id}/form-findings`, { token: tenant.token });
  const findingList = findings.json?.items ?? findings.json ?? [];
  const security = await request(
    `/api/v1/security/findings?applicationId=${application.id}`, { token: tenant.token });
  const securityList = security.json?.items ?? security.json ?? [];
  for (const [label, response] of [['defects', defects], ['form findings', findings], ['security findings', security]]) {
    if (!response.ok) line(`  (${label} could not be read: ${response.status} ${response.text.slice(0, 120)})`);
  }
  line(`  concluded: ${defectList.length} defect(s), ${findingList.length} structural finding(s), `
    + `${securityList.length} security finding(s)`);
  result.stages.conclusions = {
    // A defect carries the form it was correlated to, which is the route it is about.
    // Reading a `route` field it does not have left every defect routeless, and the two
    // reflected-input defects the engine had correctly raised as critical went uncredited.
    defects: defectList.map(d => ({
      severity: d.severity,
      route: screens.find(f => f.id === d.applicationFormId)?.route
        ?? routeFromName(d.title, screens),
      message: (d.title ?? d.summary ?? d.message ?? '').slice(0, 300)
    })),
    structural: findingList.map(f => ({ code: f.code, severity: f.severity, route: f.route ?? null,
      message: (f.message ?? '').slice(0, 300) })),
    // A security finding names its endpoint and the parameter it was found on; the route
    // is the endpoint's path.
    security: securityList.map(s => ({
      severity: s.severity,
      checkId: s.category ?? s.checkId ?? s.code,
      route: pathOf(s.endpoint),
      parameter: s.parameter ?? null,
      message: [s.title, s.parameter ? `parameter "${s.parameter}"` : null, s.cwe]
        .filter(Boolean).join(' — ').slice(0, 300)
    }))
  };

  // ---- join back to what was planted --------------------------------------
  const evidence = [
    ...result.stages.run.failures.map(f => ({ ...f, kind: 'test failure' })),
    ...result.stages.conclusions.defects.map(d => ({ ...d, kind: 'defect' })),
    ...result.stages.conclusions.structural.map(f => ({ ...f, kind: 'structural finding' })),
    ...result.stages.conclusions.security.map(s => ({ ...s, kind: 'security finding' }))
  ];
  const verdicts = target.defects.map(defect => {
    const hits = evidence
      .map(item => ({ item, match: matches(defect, item) }))
      .filter(entry => entry.match);
    const strong = hits.filter(h => h.match.strength === 'route and wording');
    const chosen = (strong[0] ?? hits[0]);
    return {
      id: defect.id, class: defect.class, severity: defect.severity, routes: defect.routes,
      statement: defect.statement,
      detected: strong.length > 0,
      weakOnly: strong.length === 0 && hits.length > 0,
      evidence: chosen ? {
        kind: chosen.item.kind, strength: chosen.match.strength,
        route: chosen.item.route ?? null,
        message: (chosen.item.message ?? '').slice(0, 220)
      } : null
    };
  });
  result.detection = {
    planted: verdicts.length,
    detected: verdicts.filter(v => v.detected).length,
    weakOnly: verdicts.filter(v => v.weakOnly).length,
    verdicts
  };

  line();
  for (const v of verdicts) {
    const mark = v.detected ? 'FOUND  ' : v.weakOnly ? 'weak?  ' : 'missed ';
    line(`  ${mark} ${v.id}  ${v.class.padEnd(14)} ${v.statement}`);
    if (v.evidence) line(`           via ${v.evidence.kind} (${v.evidence.strength}): ${v.evidence.message || '(no message)'}`);
  }
  line(`\n  ${result.detection.detected}/${verdicts.length} planted defect(s) detected on evidence`
    + (result.detection.weakOnly
      ? `, ${result.detection.weakOnly} matched partially and are not counted` : ''));

  await writeFile(new URL(`./${key}/run-result.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
  return result;
}

const keys = targetKeys.length ? targetKeys : ['clinic-spa', 'permits-legacy'];
const results = [];
for (const key of keys) {
  try {
    results.push(await runOne(key));
  } catch (error) {
    line(`\n  ${key} FAILED: ${error.message}`);
    results.push({ key, error: String(error.message).slice(0, 400) });
  }
}

section('Across every target');
line(`  ${'target'.padEnd(16)} ${'pages'.padStart(6)} ${'forms'.padStart(6)} ${'tests'.padStart(6)} `
  + `${'failed'.padStart(7)} ${'found'.padStart(6)}`);
for (const r of results) {
  if (r.error || r.unreachable) { line(`  ${r.key.padEnd(16)} ${(r.error ? 'error' : 'unreachable').padStart(6)}`); continue; }
  line(`  ${r.key.padEnd(16)} ${String(r.stages.discovery?.pages ?? 0).padStart(6)} `
    + `${String(r.stages.forms?.count ?? 0).padStart(6)} `
    + `${String(r.stages.run?.executions ?? 0).padStart(6)} `
    + `${String(r.stages.run?.byStatus?.failed ?? 0).padStart(7)} `
    + `${String(`${r.detection?.detected ?? 0}/${r.planted}`).padStart(6)}`);
}
await writeFile(new URL('./multi-target-result.json', import.meta.url),
  JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2) + '\n');
line(`\n  written: test-lab/multi-target-result.json`);

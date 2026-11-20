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
  const pattern = defect.route.toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[a-z0-9_]+/gi, '[^/]+');
  const routeHit = route !== '' && new RegExp(`^${pattern}$`).test(route.split('?')[0]);
  const keywordHits = defect.keywords.filter(k => text.includes(k.toLowerCase()));
  if (routeHit && keywordHits.length) return { strength: 'route and wording', keywordHits };
  if (routeHit) return { strength: 'route only', keywordHits };
  if (keywordHits.length >= 2) return { strength: 'wording only (weak)', keywordHits };
  return null;
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

  // ---- run it --------------------------------------------------------------
  const started = await request(`/api/v1/applications/${application.id}/runs`, {
    timeoutMs: 5 * 60 * 1000,
    token: tenant.token, method: 'POST',
    body: {
      mode: 'all', name: `${target.name} — all`, browser: 'chromium', headless: true,
      includeSecurity: true, securityProfile: 'standard',
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
  // An execution row names its test case, not the form the case was designed against, so
  // the route a failure is about has to be looked up. Without it every verdict fell back to
  // keyword matching, which is how the first run reported 0 of 4 on a target where the
  // engine had in fact caught one defect with hard evidence.
  const cases = await request(`/api/v1/testcases?projectId=${project.id}&pageSize=2000`,
    { token: tenant.token });
  const caseRows = cases.json?.items ?? cases.json ?? [];
  const routeOfForm = new Map((result.stages.forms.list ?? []).map(f => [f.route, f.route]));
  const routeOfCase = new Map();
  for (const row of caseRows) {
    const form = (result.stages.forms.list ?? []).find(f => f.id && f.id === row.applicationFormId);
    if (form) routeOfCase.set(row.id, form.route);
  }
  void routeOfForm;
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
      route: routeOfCase.get(f.testCaseId) ?? null,
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
    defects: defectList.map(d => ({ severity: d.severity, route: d.route ?? null,
      message: (d.title ?? d.summary ?? d.message ?? '').slice(0, 300) })),
    structural: findingList.map(f => ({ code: f.code, severity: f.severity, route: f.route ?? null,
      message: (f.message ?? '').slice(0, 300) })),
    security: securityList.map(s => ({ severity: s.severity, checkId: s.checkId ?? s.code,
      route: s.route ?? s.url ?? null, message: (s.title ?? s.message ?? '').slice(0, 300) }))
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
    const strong = hits.filter(h => h.match.strength !== 'wording only (weak)');
    const chosen = (strong[0] ?? hits[0]);
    return {
      id: defect.id, class: defect.class, severity: defect.severity, route: defect.route,
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
    + (result.detection.weakOnly ? `, ${result.detection.weakOnly} matched on wording alone and are not counted` : ''));

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

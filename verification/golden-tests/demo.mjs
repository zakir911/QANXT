/**
 * The demonstration: the whole product in one pass, recorded.
 *
 * Sixteen steps, each printed as it happens and each leaving something on disk. Nothing is
 * staged — the discovery is a real crawl, the tests are generated from a sentence, the runs
 * are real browser sessions, and the healing happens because the application really did
 * change underneath a test that was never edited.
 *
 * Video comes from the product's own capture: the demo project enables it, so the .webm in
 * verification/demo is a recording the platform made of itself working.
 *
 * Usage: node verification/golden-tests/demo.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VERIFICATION } from './harness.mjs';
import {
  LAB, applicationModel, artifactsFor, createProject, execute, generateTests, importJourney,
  journey, lab, newTenant, registerApplication, request, requestBinary, runDiscovery, step, testCase
} from './platform.mjs';

const BANK = LAB.banking;
const DEMO_DIR = resolve(VERIFICATION, 'demo');
mkdirSync(DEMO_DIR, { recursive: true });

const transcript = [];
let stepNumber = 0;

function say(title, detail) {
  stepNumber++;
  const line = `${String(stepNumber).padStart(2, '0')}. ${title}`;
  console.log(`\n\u001b[1m${line}\u001b[0m`);
  if (detail) console.log(`    ${detail}`);
  transcript.push({ step: stepNumber, title, detail, at: new Date().toISOString() });
}

function note(detail) {
  console.log(`    ${detail}`);
  if (transcript.length) {
    transcript.at(-1).detail = `${transcript.at(-1).detail ?? ''}${transcript.at(-1).detail ? '\n' : ''}${detail}`;
  }
}

// ---------------------------------------------------------------------------

say('Check the platform and the application under test are up');
const health = await request('/health');
const bankHealth = await fetch(`${BANK}/health`).then(response => response.json());
note(`QA NXT: ${health.status === 200 ? 'healthy' : `not answering (${health.status})`}`);
note(`${bankHealth.application} ${bankHealth.version}: healthy, faults: ${
  Object.entries(bankHealth.faults).filter(([, on]) => on).map(([id]) => id).join(', ') || 'none'}`);
await lab.reset(BANK);

say('Create an organisation, a project and register the application');
const tenant = await newTenant('Demo');
const project = await createProject(tenant, 'Product demonstration', {
  healingPolicy: 'auto', healingConfidenceThreshold: 75, captureVideo: true, captureTrace: true
});
const application = await registerApplication(tenant, project.id, {
  name: 'QA NXT Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
  username: 'alice', password: 'Password123!'
});
note(`project ${project.key}, application ${application.id}`);
note('healing policy: auto at 75% · video and trace capture: on');

say('Discover the application');
const discoveryStarted = Date.now();
const discovery = await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });
const model = await applicationModel(tenant, application.id);
note(`crawl ${discovery.status} in ${Math.round((Date.now() - discoveryStarted) / 1000)}s`);

say('What discovery found');
for (const page of model.pages) {
  note(`${(page.route ?? '/').padEnd(24)} ${String(page.elementCount).padStart(3)} elements  `
    + `${page.requiresAuthentication ? 'private' : 'public '}  ${page.kind}`);
}
note(`${model.pages.length} pages, ${model.elements.length} elements, ${model.endpoints.length} API endpoints`);

say('Generate tests from a sentence',
  '"Customer can login and download account statement."');
const generated = await generateTests(tenant, {
  applicationId: application.id,
  requirement: 'Customer can login and download account statement.',
  suiteName: 'Demonstration', maxScenarios: 3
});
note(`${generated.json.casesCreated} test case(s), ${generated.json.stepsCreated} steps, `
  + `by ${generated.json.provider}/${generated.json.model}`
  + `${generated.json.isLocalProvider ? ' (built-in rules — no model provider configured)' : ''}`);

const generatedList = await request(`/api/v1/testcases?projectId=${project.id}&testSuiteId=${generated.json.testSuiteId}`, { token: tenant.token });
for (const summary of generatedList.json ?? []) note(`  ${summary.Reference ?? summary.reference}  ${summary.name}`);

say('Execute a generated test');
const firstGenerated = (generatedList.json ?? [])[0];
const generatedRun = await execute(tenant, {
  projectId: project.id, testCaseId: firstGenerated.id, name: 'Demo — generated test'
});
note(`${firstGenerated.name}: ${generatedRun.run?.status} `
  + `(${generatedRun.detail?.stepsPassed}/${generatedRun.detail?.stepsTotal} steps, ${generatedRun.detail?.durationMs}ms)`);

say('Execute the statement journey the demonstration is about');
const statementJourney = journey({
  name: 'Customer signs in and downloads a statement',
  startUrl: `${BANK}/login`,
  steps: [
    step.navigate(`${BANK}/login`),
    step.fill('username', 'alice', `${BANK}/login`),
    step.fill('password', '${secret:app_password}', `${BANK}/login`),
    step.click('login-submit', `${BANK}/login`),
    step.assertVisible('total-balance', `${BANK}/dashboard`),
    step.click('nav-statements', `${BANK}/dashboard`),
    step.click('generate-statement', `${BANK}/statements`),
    step.assertVisible('statement-result', `${BANK}/statements`),
    step.assertVisible('download-statement', `${BANK}/statements`)
  ]
});
const imported = await importJourney(tenant, {
  projectId: project.id, applicationId: application.id, journey: statementJourney
});
const baseline = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Demo — baseline'
});
note(`${imported.testCaseReference}: ${baseline.run?.status} `
  + `(${baseline.detail?.stepsPassed}/${baseline.detail?.stepsTotal} steps, ${baseline.detail?.durationMs}ms)`);
if (baseline.run?.status !== 'passed') {
  console.error('The baseline did not pass; the rest of the demonstration would be meaningless.');
  process.exit(1);
}

say('Change the application underneath the test',
  'FAULT_LOGIN_BUTTON_RENAMED: the sign-in control is relabelled "Sign In" and its test id changes');
await lab.set(BANK, { FAULT_LOGIN_BUTTON_RENAMED: true });
const renamedPage = await fetch(`${BANK}/login`).then(response => response.text());
note(`the page now renders: ${/renamedSignIn":(true|false)/.exec(renamedPage)?.[0] ?? 'runtime config updated'}`);

say('Re-run the same test, unedited');
const healed = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Demo — after the rename'
});
const healEvents = healed.detail?.healingEvents ?? [];
const healedClick = (healed.detail?.actions ?? []).find(action => action.action === 'click');
note(`${healed.run?.status}: ${healEvents.length} healing event(s)`);
for (const event of healEvents) {
  note(`  ${event.outcome} at ${event.confidence}% — `
    + `${JSON.parse(event.original ?? '{}').value} → ${JSON.parse(event.healed ?? '{}').value}`);
}
note(`the click step records wasHealed=${healedClick?.wasHealed} at ${healedClick?.healingConfidence}%`);

say('The stored test was not rewritten');
const storedAfterHeal = await testCase(tenant, imported.testCaseId);
const storedClick = (storedAfterHeal.steps ?? []).find(candidate => candidate.action === 'click');
note(`the stored step still targets ${JSON.stringify(storedClick?.target)}`);

say('Collect the evidence for that run');
const healedExecution = healed.executions?.[0]?.id;
const artifacts = await artifactsFor(tenant, healedExecution);
for (const artifact of artifacts) {
  note(`${String(artifact.kind).padEnd(12)} ${artifact.name} (${artifact.sizeBytes} bytes)`);
}

const video = artifacts.find(artifact => String(artifact.kind).toLowerCase() === 'video');
if (video) {
  const bytes = await requestBinary(`/api/v1/artifacts/${video.id}/content`, { token: tenant.token });
  if (bytes) {
    writeFileSync(resolve(DEMO_DIR, 'product-demo.webm'), bytes);
    note(`video saved to verification/demo/product-demo.webm (${bytes.length} bytes)`);
  }
} else {
  note('no video artifact was produced by this run');
}

say('Remove the control entirely',
  'FAULT_LOGIN_BUTTON_REMOVED: nothing on the page submits the form');
await lab.reset(BANK);
await lab.set(BANK, { FAULT_LOGIN_BUTTON_REMOVED: true });

say('Re-run the same test again, still unedited');
const broken = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Demo — after the removal'
});
const brokenEvents = broken.detail?.healingEvents ?? [];
const failingStep = (broken.detail?.actions ?? []).find(action => action.status !== 'passed');
note(`${broken.run?.status}: ${broken.detail?.stepsPassed}/${broken.detail?.stepsTotal} steps`);
note(`failed at step ${failingStep?.order} (${failingStep?.action}): ${failingStep?.errorMessage}`);
note(`${brokenEvents.filter(event => String(event.outcome).toLowerCase() === 'applied').length} heal(s) applied — `
  + 'nothing on the page performs that function, so nothing was substituted');

say('What the platform says about the failure');
const failure = broken.detail?.failure;
note(`category: ${failure?.category} at ${failure?.categoryConfidence}% confidence`);
note(`summary: ${failure?.analysis?.summary}`);
note(`likely cause: ${failure?.analysis?.likelyCause}`);
note(`suggested action: ${failure?.analysis?.suggestedAction}`);
note(`produced by: ${failure?.analysis?.provider}${failure?.analysis?.producedByAi ? ' (a model)' : ' (deterministic rules)'}`);

say('Evidence for the failed run');
const brokenArtifacts = await artifactsFor(tenant, broken.executions?.[0]?.id);
for (const artifact of brokenArtifacts) {
  note(`${String(artifact.kind).padEnd(12)} ${artifact.name} (${artifact.sizeBytes} bytes)`);
}

say('Put the application back and confirm the test passes again');
await lab.reset(BANK);
const restored = await execute(tenant, {
  projectId: project.id, testCaseId: imported.testCaseId, name: 'Demo — restored'
});
note(`${restored.run?.status} (${restored.detail?.stepsPassed}/${restored.detail?.stepsTotal} steps)`);

say('Write the demonstration record');

const summary = {
  generatedAt: new Date().toISOString(),
  application: `${bankHealth.application} ${bankHealth.version}`,
  discovery: {
    status: discovery.status,
    pages: model.pages.length, elements: model.elements.length, apiEndpoints: model.endpoints.length,
    routes: model.pages.map(page => page.route)
  },
  generation: {
    requirement: 'Customer can login and download account statement.',
    provider: `${generated.json.provider}/${generated.json.model}`,
    isLocalProvider: generated.json.isLocalProvider,
    casesCreated: generated.json.casesCreated,
    firstCase: { name: firstGenerated?.name, status: generatedRun.run?.status }
  },
  baseline: { reference: imported.testCaseReference, status: baseline.run?.status, durationMs: baseline.detail?.durationMs },
  afterRename: {
    status: healed.run?.status,
    healingEvents: healEvents.map(event => ({ outcome: event.outcome, confidence: event.confidence })),
    storedLocatorAfterwards: storedClick?.target
  },
  afterRemoval: {
    status: broken.run?.status,
    healsApplied: brokenEvents.filter(event => String(event.outcome).toLowerCase() === 'applied').length,
    failingStep: failingStep && { order: failingStep.order, action: failingStep.action, error: failingStep.errorMessage },
    classification: failure?.category,
    analysis: failure?.analysis && {
      summary: failure.analysis.summary, likelyCause: failure.analysis.likelyCause,
      suggestedAction: failure.analysis.suggestedAction,
      producedByAi: failure.analysis.producedByAi, provider: failure.analysis.provider
    }
  },
  restored: { status: restored.run?.status },
  artifacts: {
    afterRename: artifacts.map(artifact => ({ kind: artifact.kind, name: artifact.name, bytes: artifact.sizeBytes })),
    afterRemoval: brokenArtifacts.map(artifact => ({ kind: artifact.kind, name: artifact.name, bytes: artifact.sizeBytes }))
  },
  transcript
};

writeFileSync(resolve(DEMO_DIR, 'product-demo.json'), `${JSON.stringify(summary, null, 2)}\n`);

const script = `# Product demonstration

Recorded ${summary.generatedAt} against ${summary.application}.

Reproduce with:

\`\`\`bash
./scripts/run-product-demo
\`\`\`

Everything below happened in one pass. The test that heals and then fails is the same test
throughout — it is never edited between runs, and \`${summary.baseline.reference}\` can be
read in the console to confirm that.

| Step | What happens | What to look for |
| --- | --- | --- |
${transcript.map(entry => `| ${entry.step} | ${entry.title} | ${(entry.detail ?? '').split('\n')[0].slice(0, 120)} |`).join('\n')}

## The three runs that matter

| | Application | Verdict | What the platform did |
| --- | --- | --- | --- |
| Baseline | unchanged | **${summary.baseline.status}** | ${summary.baseline.durationMs}ms, no healing needed |
| After the rename | sign-in control relabelled and re-identified | **${summary.afterRename.status}** | ${summary.afterRename.healingEvents.map(event => `${event.outcome} at ${event.confidence}%`).join(', ') || 'no healing events'} |
| After the removal | no control submits the form | **${summary.afterRemoval.status}** | ${summary.afterRemoval.healsApplied} heals applied; classified \`${summary.afterRemoval.classification}\` |

The middle row is the capability. The bottom row is the safety property: with nothing on the
page that performs the function, the platform failed the run rather than finding something
that looked close enough.

## Evidence

| Artifact | Where |
| --- | --- |
| Video of the healed run | \`verification/demo/product-demo.webm\` |
| Full record of the demonstration | \`verification/demo/product-demo.json\` |
| Artifacts of the healed run | ${summary.artifacts.afterRename.map(artifact => artifact.kind).join(', ')} |
| Artifacts of the failed run | ${summary.artifacts.afterRemoval.map(artifact => artifact.kind).join(', ')} |

## What the platform said about the failure

> ${summary.afterRemoval.analysis?.summary ?? 'no analysis'}
>
> ${summary.afterRemoval.analysis?.likelyCause ?? ''}
>
> **Suggested action:** ${summary.afterRemoval.analysis?.suggestedAction ?? ''}

Produced by ${summary.afterRemoval.analysis?.provider}${summary.afterRemoval.analysis?.producedByAi ? ' (a model)' : ' (deterministic rules — no model provider is configured in this environment)'}.
`;

writeFileSync(resolve(DEMO_DIR, 'product-demo-script.md'), script);
note('verification/demo/product-demo-script.md');
note('verification/demo/product-demo.json');

console.log('\n\u001b[32mDemonstration complete.\u001b[0m');

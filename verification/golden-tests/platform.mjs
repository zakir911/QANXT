/**
 * A client for AIRA's public API, and for the test lab's control endpoints.
 *
 * The golden suite talks to the product the way a customer's pipeline would: over HTTP,
 * with a token, through documented endpoints. It never imports the product's code and
 * never reaches into its database — a test that calls an internal method proves the method
 * works, not that the platform does.
 */
import { sleep } from './harness.mjs';

export const API = (process.env.AIRA_API_URL ?? 'http://127.0.0.1:5080').replace(/\/+$/, '');

export const LAB = {
  banking: process.env.LAB_BANKING_URL ?? 'http://localhost:4300',
  commerce: process.env.LAB_COMMERCE_URL ?? 'http://localhost:4310',
  forms: process.env.LAB_FORMS_URL ?? 'http://localhost:4320',
  dynamic: process.env.LAB_DYNAMIC_URL ?? 'http://localhost:4330',
  failure: process.env.LAB_FAILURE_URL ?? 'http://localhost:4340',
  healing: process.env.LAB_HEALING_URL ?? 'http://localhost:4350'
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export async function request(path, options = {}) {
  const { token, method = 'GET', body, headers = {}, timeoutMs = 60_000 } = options;
  const url = path.startsWith('http') ? path : `${API}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  } catch (error) {
    return { ok: false, status: 0, text: String(error), json: null, headers: new Headers() };
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* the text is the evidence */ }
  return { ok: response.ok, status: response.status, text, json, headers: response.headers };
}

export async function requestBinary(path, { token } = {}) {
  const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Tenancy and setup
// ---------------------------------------------------------------------------

/** Registers a throwaway organisation. Each suite gets its own, so suites cannot interfere. */
export async function newTenant(label = 'Golden') {
  const unique = Math.random().toString(36).slice(2, 12);
  const email = `${label.toLowerCase()}-${unique}@example.test`;
  const password = 'Str0ngPassphrase!2026';
  const response = await request('/api/v1/auth/register', {
    method: 'POST',
    body: { organizationName: `${label} ${unique}`, email, password, displayName: `${label} Admin` }
  });
  if (!response.ok) throw new Error(`could not register a tenant: ${response.status} ${response.text.slice(0, 200)}`);
  return {
    token: response.json.accessToken,
    refreshToken: response.json.refreshToken,
    userId: response.json.user.userId,
    organizationId: response.json.user.organizationId,
    email, password
  };
}

export async function createProject(tenant, name, overrides = {}) {
  const response = await request('/api/v1/projects', {
    token: tenant.token, method: 'POST',
    body: { name, key: `G${Math.random().toString(36).slice(2, 8).toUpperCase()}`, description: 'Golden verification' }
  });
  if (!response.ok) throw new Error(`could not create a project: ${response.status} ${response.text.slice(0, 200)}`);

  if (Object.keys(overrides).length > 0) {
    const patched = await request(`/api/v1/projects/${response.json.id}`, {
      token: tenant.token, method: 'PATCH', body: overrides
    });
    if (!patched.ok) throw new Error(`could not configure the project: ${patched.status} ${patched.text.slice(0, 200)}`);
  }
  return response.json;
}

export async function registerApplication(tenant, projectId, { name, baseUrl, loginUrl, username, password, maxPages = 25 }) {
  const host = new URL(baseUrl).hostname;
  const response = await request('/api/v1/applications', {
    token: tenant.token, method: 'POST',
    body: {
      projectId, name, baseUrl,
      description: 'Test lab application',
      allowedDomains: host,
      maxPages,
      maxCrawlDepth: 3,
      explorationTimeoutSeconds: 180,
      authStrategy: username ? 'formLogin' : 'none',
      loginUrl: loginUrl ?? null,
      credentials: username ? { username, password } : null
    }
  });
  if (!response.ok) throw new Error(`could not register ${name}: ${response.status} ${response.text.slice(0, 300)}`);
  return response.json;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function runDiscovery(tenant, applicationId, { maxPages = 25, maxDepth = 3, timeoutMs = 300_000 } = {}) {
  const started = await request('/api/v1/discovery/runs', {
    token: tenant.token, method: 'POST',
    body: { applicationId, maxPages, maxDepth, timeoutSeconds: 240 }
  });
  if (!started.ok) throw new Error(`discovery refused: ${started.status} ${started.text.slice(0, 300)}`);

  // The detail endpoint answers { summary, pages, … }; the list endpoint answers the
  // summary directly. Unwrapping here keeps every caller working with one shape.
  const summaryOf = (payload) => payload?.summary ?? payload;
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['completed', 'failed', 'cancelled', 'partiallycompleted', 'partial', 'error']);
  let last = summaryOf(started.json);
  while (Date.now() < deadline) {
    const current = await request(`/api/v1/discovery/runs/${started.json.id}`, { token: tenant.token });
    last = summaryOf(current.json) ?? last;
    if (last && terminal.has(String(last.status).toLowerCase())) return { ...last, detail: current.json };
    await sleep(2500);
  }
  return { ...last, status: 'timeout' };
}

export async function applicationModel(tenant, applicationId) {
  const [graph, pages, endpoints] = await Promise.all([
    request(`/api/v1/applications/${applicationId}/graph`, { token: tenant.token }),
    request(`/api/v1/applications/${applicationId}/pages`, { token: tenant.token }),
    request(`/api/v1/applications/${applicationId}/api-endpoints`, { token: tenant.token })
  ]);

  const pageList = pages.json ?? [];
  const elements = [];
  for (const page of pageList) {
    // The elements endpoint answers { page, elements }, not a bare array.
    const response = await request(`/api/v1/applications/${applicationId}/pages/${page.id}/elements`, { token: tenant.token });
    for (const element of response.json?.elements ?? []) {
      elements.push({ ...element, pageId: page.id, pageUrl: page.url, pageRoute: page.route });
    }
  }

  return { graph: graph.json, pages: pageList, elements, endpoints: endpoints.json ?? [] };
}

// ---------------------------------------------------------------------------
// Tests and execution
// ---------------------------------------------------------------------------

export async function createSuite(tenant, projectId, name) {
  const response = await request('/api/v1/test-suites', {
    token: tenant.token, method: 'POST', body: { projectId, name }
  });
  return response.json;
}

export async function generateTests(tenant, { applicationId, requirement, suiteName, maxScenarios, testSuiteId }) {
  const response = await request('/api/v1/testcases/generate', {
    token: tenant.token, method: 'POST',
    body: {
      applicationId, requirement, suiteName, testSuiteId,
      // Omitted rather than defaulted here: "no budget" is a distinct request from "a
      // budget of three", and the platform's own default belongs to the platform.
      ...(maxScenarios === undefined ? {} : { maxScenarios })
    }
  });
  return response;
}

export async function testCase(tenant, id) {
  const response = await request(`/api/v1/testcases/${id}`, { token: tenant.token });
  return response.json;
}

/**
 * Imports a journey and returns the test case it produced.
 *
 * Used where a test needs an exact stored locator — the platform has no manual authoring
 * endpoint (BUG-0002), and generation deliberately chooses its own locators.
 */
export async function importJourney(tenant, { projectId, applicationId, journey }) {
  const response = await request('/api/v1/journeys/import', {
    token: tenant.token, method: 'POST', body: { projectId, applicationId, journey }
  });
  if (!response.ok) throw new Error(`journey import failed: ${response.status} ${response.text.slice(0, 300)}`);
  return response.json;
}

export function journey({ name, startUrl, steps }) {
  return {
    schemaVersion: 1,
    name,
    startUrl,
    recordedAt: new Date().toISOString(),
    recorderVersion: '0.1.0',
    steps: steps.map((step, index) => ({ order: index + 1, timestampMs: Date.now() + index, ...step }))
  };
}

export const step = {
  navigate: (url, description) => ({ action: 'navigate', description: description ?? `Go to ${url}`, url }),
  fill: (testId, value, url, description) => ({
    action: 'fill', description: description ?? `Enter a value in ${testId}`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, value, url
  }),
  fillBy: (target, value, url, description) => ({
    action: 'fill', description: description ?? 'Enter a value', target, value, url
  }),
  click: (testId, url, description) => ({
    action: 'click', description: description ?? `Press ${testId}`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, url
  }),
  clickBy: (target, url, description) => ({ action: 'click', description: description ?? 'Press a control', target, url }),
  select: (testId, value, url) => ({
    action: 'select', description: `Choose "${value}" in ${testId}`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, value, url
  }),
  check: (testId, url) => ({
    action: 'check', description: `Tick ${testId}`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, url
  }),
  assertVisible: (testId, url, description) => ({
    action: 'assertVisible', description: description ?? `${testId} is visible`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, url
  }),
  assertText: (testId, expected, url, description) => ({
    action: 'assertText', description: description ?? `${testId} reads "${expected}"`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, expected, url
  }),
  assertUrl: (fragment, url, description) => ({
    action: 'assertUrl', description: description ?? `The address contains "${fragment}"`,
    expected: fragment, url
  }),
  assertValue: (testId, expected, url, description) => ({
    action: 'assertValue', description: description ?? `${testId} holds "${expected}"`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, expected, url
  }),
  assertHidden: (testId, url, description) => ({
    action: 'assertHidden', description: description ?? `${testId} is not visible`,
    target: { strategy: 'testId', value: testId, exact: false, fallbacks: [] }, url
  }),
  press: (key, testId, url) => ({
    action: 'press', description: `Press ${key}`,
    target: testId ? { strategy: 'testId', value: testId, exact: false, fallbacks: [] } : undefined,
    value: key, url
  })
};

/**
 * Authors an API test through the platform's own endpoint.
 *
 * Returns the raw response rather than throwing, because several golden tests are about
 * what the platform *refuses* to store, and a helper that threw would make a refusal
 * indistinguishable from a broken harness.
 */
export async function createApiTest(tenant, body) {
  return request('/api/v1/testcases/api-tests', { token: tenant.token, method: 'POST', body });
}

/** Creates an API test and fails loudly if the platform would not store it. */
export async function requireApiTest(tenant, body) {
  const response = await createApiTest(tenant, body);
  if (!response.ok) {
    throw new Error(`the platform refused an API test it should have stored: `
      + `${response.status} ${response.text.slice(0, 400)}`);
  }
  return response.json;
}

/** One environment for a project, so an API test has an API base URL to resolve against. */
export async function createEnvironment(tenant, projectId, body) {
  const response = await request('/api/v1/environments', {
    token: tenant.token, method: 'POST', body: { projectId, ...body }
  });
  if (!response.ok) throw new Error(`could not create an environment: ${response.status} ${response.text.slice(0, 300)}`);
  return response.json;
}

/** The gate's own verdict for a run, as the CLI and the console both read it. */
export async function qualityGate(tenant, runId) {
  const response = await request(`/api/v1/testruns/${runId}/quality-gate`, { token: tenant.token });
  return response.json;
}

/** Adds a quality gate rule to a project. */
export async function createGateRule(tenant, projectId, body) {
  const response = await request(`/api/v1/quality-gates?projectId=${projectId}`, {
    token: tenant.token, method: 'POST', body
  });
  if (!response.ok) throw new Error(`could not create a gate rule: ${response.status} ${response.text.slice(0, 300)}`);
  return response.json;
}

export async function startRun(tenant, { projectId, testCaseIds, name, browser, headless = true, maxRetries, environmentId }) {
  const response = await request('/api/v1/testruns', {
    token: tenant.token, method: 'POST',
    body: { projectId, testCaseIds, name, headless, browser, maxRetries, environmentId }
  });
  if (!response.ok) throw new Error(`run refused: ${response.status} ${response.text.slice(0, 300)}`);
  return response.json;
}

const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled', 'blocked']);

export async function waitForRun(tenant, runId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await request(`/api/v1/testruns/${runId}`, { token: tenant.token });
    if (run.json && TERMINAL.has(String(run.json.status).toLowerCase())) return run.json;
    await sleep(2000);
  }
  return null;
}

/** Runs a test case and returns the run, its executions and the first execution's detail. */
export async function execute(tenant, { projectId, testCaseId, name, browser, maxRetries, timeoutMs, environmentId }) {
  const started = await startRun(tenant, { projectId, testCaseIds: [testCaseId], name, browser, maxRetries, environmentId });
  const run = await waitForRun(tenant, started.id, timeoutMs);
  if (!run) return { run: null, executions: [], detail: null };

  const executions = await request(`/api/v1/testruns/${run.id}/executions`, { token: tenant.token });
  const first = executions.json?.[0];
  const detail = first ? await request(`/api/v1/executions/${first.id}`, { token: tenant.token }) : { json: null };
  return { run, executions: executions.json ?? [], detail: detail.json };
}

export async function artifactsFor(tenant, executionId) {
  const response = await request(`/api/v1/artifacts?executionId=${executionId}`, { token: tenant.token });
  return response.json ?? [];
}

export async function consoleLog(tenant, executionId) {
  const response = await request(`/api/v1/executions/${executionId}/console`, { token: tenant.token });
  return response.json ?? [];
}

export async function networkLog(tenant, executionId) {
  const response = await request(`/api/v1/executions/${executionId}/network`, { token: tenant.token });
  return response.json ?? [];
}

export async function healingEvents(tenant, { testCaseId } = {}) {
  const query = testCaseId ? `?testCaseId=${testCaseId}` : '';
  const response = await request(`/api/v1/healing${query}`, { token: tenant.token });
  return response.json ?? [];
}

// ---------------------------------------------------------------------------
// The lab
// ---------------------------------------------------------------------------

/**
 * A fetch that survives a connection the other end has already closed.
 *
 * The lab applications keep connections alive for five seconds. A test that blocks for
 * longer than that — one that shells out to the CLI and waits for a whole run, say — comes
 * back to a pooled socket the server has since dropped, and the next request fails with a
 * bare "fetch failed" that looks like the application is down. One retry on a transport
 * error tells the two apart: a real outage fails twice.
 */
async function labFetch(url, options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (attempt >= 2) throw new Error(`${options.method ?? 'GET'} ${url} failed twice: ${error}`);
      await sleep(250);
    }
  }
}

export const lab = {
  async faults(baseUrl) {
    const response = await labFetch(`${baseUrl}/__faults`);
    return (await response.json()).faults;
  },
  async set(baseUrl, patch) {
    const response = await labFetch(`${baseUrl}/__faults`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch)
    });
    return response.json();
  },
  async reset(baseUrl) {
    const response = await labFetch(`${baseUrl}/__reset`, { method: 'POST' });
    return response.json();
  },
  async resetAll() {
    return Promise.all(Object.values(LAB).map(url => lab.reset(url).catch(() => null)));
  },
  async health(baseUrl) {
    const response = await labFetch(`${baseUrl}/health`);
    return response.json();
  }
};

/** Fails loudly if the stack the suites depend on is not actually up. */
export async function requireEnvironment(labs = Object.values(LAB)) {
  const problems = [];
  const health = await request('/health');
  if (!health.ok) problems.push(`the AIRA API at ${API} is not answering`);

  for (const url of labs) {
    try {
      const response = await fetch(`${url}/health`);
      if (!response.ok) problems.push(`${url} answered ${response.status}`);
    } catch (error) {
      problems.push(`${url} is not reachable (${String(error.cause?.code ?? error.message)})`);
    }
  }

  if (problems.length) {
    throw new Error(`The environment is not ready:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * The client's view of the bank's API.
 *
 * Every call is a real `fetch` against the real server with the session cookie attached,
 * and every failure is surfaced to the user rather than swallowed — an application that
 * hides its errors cannot be used to prove that a test framework detects them.
 */
async function call(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    // A destroyed socket lands here. It is a distinct failure from an HTTP error and the
    // application says so, because the classifier under test has to tell them apart.
    const failure = new Error('The bank could not be reached. Check your connection.');
    failure.kind = 'network';
    failure.cause = error;
    throw failure;
  }

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const failure = new Error(payload?.message ?? `Request failed with status ${response.status}.`);
    failure.status = response.status;
    failure.kind = payload?.error ?? 'http';
    failure.errors = payload?.errors ?? null;
    throw failure;
  }
  return payload;
}

const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

export const api = {
  signIn: (username, password, remember) => call('/api/session', { method: 'POST', body: { username, password, remember } }),
  signOut: () => call('/api/session', { method: 'DELETE' }),
  session: () => call('/api/session'),
  dashboard: () => call('/api/dashboard'),
  accounts: () => call('/api/accounts'),
  account: (id) => call(`/api/accounts/${id}`),
  accountTransactions: (id, query) => call(`/api/accounts/${id}/transactions?${new URLSearchParams(query)}`),
  transactions: (query) => call(`/api/transactions?${new URLSearchParams(query)}`),
  beneficiaries: () => call('/api/beneficiaries'),
  addBeneficiary: (body) => call('/api/beneficiaries', { method: 'POST', body }),
  payments: () => call('/api/payments'),
  pay: (body) => call('/api/payments', { method: 'POST', body }),
  statement: (body) => call('/api/statements', { method: 'POST', body }),
  profile: () => call('/api/profile'),
  saveProfile: (body) => call('/api/profile', { method: 'PUT', body })
};

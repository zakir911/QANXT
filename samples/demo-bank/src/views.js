import { getScenario } from './scenario.js';

/**
 * Server-rendered pages. Plain HTML by design: the platform must work against an
 * ordinary application, not one instrumented for it. Test ids are present because
 * real teams add them — and one scenario switch removes them all, which is how the
 * fallback to semantic locators is demonstrated.
 */

const money = (value, currency = 'GBP') =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);

/** Honours the removeTestIds switch in one place so no view can forget it. */
function testId(name) {
  return getScenario().removeTestIds ? '' : ` data-testid="${name}"`;
}

function layout({ title, body, user, activeNav = '' }) {
  const nav = user
    ? `
      <nav class="nav" aria-label="Main">
        <a href="/dashboard" class="${activeNav === 'dashboard' ? 'active' : ''}"${testId('nav-dashboard')}>Dashboard</a>
        <a href="/accounts" class="${activeNav === 'accounts' ? 'active' : ''}"${testId('nav-accounts')}>Accounts</a>
        <a href="/payments" class="${activeNav === 'payments' ? 'active' : ''}"${testId('nav-payments')}>Payments</a>
        <a href="/profile" class="${activeNav === 'profile' ? 'active' : ''}"${testId('nav-profile')}>Profile</a>
        <form method="post" action="/logout" class="nav-end">
          <button type="submit" class="link"${testId('logout')}>Sign out</button>
        </form>
      </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Demo Bank</title>
<style>
  :root { --ink:#132135; --muted:#5b6b82; --line:#dde5ef; --bg:#f4f7fb; --accent:#0b5fff; --bad:#b3261e; --good:#1b7f4b; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:var(--bg); }
  header.bank { background:#0b2545; color:#fff; padding:14px 24px; display:flex; align-items:center; gap:12px; }
  header.bank .brand { font-weight:700; letter-spacing:.3px; }
  .nav { display:flex; gap:4px; background:#fff; border-bottom:1px solid var(--line); padding:0 16px; align-items:center; }
  .nav a, .nav .link { padding:12px 14px; color:var(--muted); text-decoration:none; border-bottom:2px solid transparent; background:none; border-0; font:inherit; cursor:pointer; }
  .nav a.active { color:var(--accent); border-bottom-color:var(--accent); }
  .nav .nav-end { margin-left:auto; }
  main { max-width:1040px; margin:24px auto; padding:0 16px; }
  h1 { font-size:24px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); font-size:15px; }
  th { color:var(--muted); font-weight:600; font-size:13px; text-transform:uppercase; letter-spacing:.04em; }
  td.amount { text-align:right; font-variant-numeric:tabular-nums; }
  td.amount.negative { color:var(--bad); }
  td.amount.positive { color:var(--good); }
  label { display:block; font-weight:600; margin:12px 0 4px; font-size:14px; }
  input, select { width:100%; padding:10px; border:1px solid var(--line); border-radius:6px; font:inherit; background:#fff; }
  button.primary { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:11px 18px; font:inherit; font-weight:600; cursor:pointer; }
  button.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:9px 14px; font:inherit; cursor:pointer; }
  .error { background:#fdecea; border:1px solid #f5c2c0; color:var(--bad); padding:12px; border-radius:6px; margin:12px 0; }
  .success { background:#e8f5ee; border:1px solid #bfe3ce; color:var(--good); padding:12px; border-radius:6px; margin:12px 0; }
  .balance { font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); font-size:14px; }
  .login-wrap { max-width:400px; margin:56px auto; }
  .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .menu { position:relative; display:inline-block; }
  .menu-items { border:1px solid var(--line); background:#fff; border-radius:6px; padding:6px; margin-top:6px; }
  details > summary { cursor:pointer; padding:9px 14px; border:1px solid var(--line); border-radius:6px; background:#fff; display:inline-block; }
</style>
</head>
<body>
<header class="bank"><span class="brand">Demo Bank</span><span class="muted" style="color:#9db4d6">Synthetic data · for testing only</span></header>
${nav}
<main>${body}</main>
</body>
</html>`;
}

export function loginPage({ error, username = '' } = {}) {
  const scenario = getScenario();
  // The switch changes both the accessible name and the test id, which is exactly the
  // kind of change that breaks a stored locator in the field.
  const buttonLabel = scenario.renameLoginButton ? 'Log in' : 'Sign in';
  const buttonTestId = scenario.renameLoginButton ? 'login-submit-v2' : 'login-submit';

  return layout({
    title: 'Sign in',
    body: `
      <div class="login-wrap">
        <div class="card">
          <h1>Sign in to Demo Bank</h1>
          <p class="sub">Use one of the documented demo accounts.</p>
          ${error ? `<div class="error" role="alert"${testId('login-error')}>${error}</div>` : ''}
          <form method="post" action="/login"${testId('login-form')}>
            <label for="username">Username</label>
            <input id="username" name="username" autocomplete="username" value="${escapeHtml(username)}" required${testId('username')}>
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required${testId('password')}>
            <div class="row" style="margin-top:14px">
              <input id="remember" name="remember" type="checkbox" style="width:auto"${testId('remember-me')}>
              <label for="remember" style="margin:0;font-weight:400">Remember me on this device</label>
            </div>
            <div style="margin-top:18px">
              <button type="submit" class="primary"${scenario.removeTestIds ? '' : ` data-testid="${buttonTestId}"`}>${buttonLabel}</button>
            </div>
          </form>
        </div>
      </div>`
  });
}

export function dashboardPage({ user, accounts, total, currency }) {
  return layout({
    title: 'Dashboard', user, activeNav: 'dashboard',
    body: `
      <h1>Good day, ${escapeHtml(user.displayName)}</h1>
      <p class="sub">Here is where your money is today.</p>
      <div class="card">
        <div class="muted">Total balance across all accounts</div>
        <div class="balance"${testId('total-balance')}>${money(total, currency)}</div>
      </div>
      <div class="grid">
        ${accounts.map(a => `
          <div class="card"${testId(`account-card-${a.id}`)}>
            <div class="muted">${escapeHtml(a.type)}</div>
            <h2 style="font-size:18px;margin:2px 0 6px">${escapeHtml(a.name)}</h2>
            <div class="muted">${a.sortCode} · ${a.number}</div>
            <div class="balance" style="font-size:22px">${money(a.balance, a.currency)}</div>
            <p style="margin:14px 0 0"><a href="/accounts/${a.id}"${testId(`open-account-${a.id}`)}>View account</a></p>
          </div>`).join('')}
      </div>`
  });
}

export function accountsPage({ user, accounts }) {
  return layout({
    title: 'Accounts', user, activeNav: 'accounts',
    body: `
      <h1>Accounts</h1>
      <p class="sub">All accounts held by ${escapeHtml(user.displayName)}.</p>
      <div class="card">
        <table${testId('accounts-table')}>
          <thead><tr><th>Account</th><th>Type</th><th>Sort code</th><th>Number</th><th style="text-align:right">Balance</th><th></th></tr></thead>
          <tbody>
            ${accounts.map(a => `
              <tr>
                <td>${escapeHtml(a.name)}</td>
                <td>${escapeHtml(a.type)}</td>
                <td>${a.sortCode}</td>
                <td>${a.number}</td>
                <td class="amount">${money(a.balance, a.currency)}</td>
                <td><a href="/accounts/${a.id}"${testId(`open-account-${a.id}`)}>Open</a></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
  });
}

export function accountDetailPage({ user, account, transactions, filters, error }) {
  const scenario = getScenario();

  const downloadControl = scenario.moveStatementButton
    ? `<details class="menu"${testId('account-actions')}>
         <summary>More actions</summary>
         <div class="menu-items">
           <a href="/accounts/${account.id}/statement?format=csv&from=${filters.from}&to=${filters.to}"${testId('download-statement')}>Download statement</a>
         </div>
       </details>`
    : `<a class="secondary" style="text-decoration:none" href="/accounts/${account.id}/statement?format=csv&from=${filters.from}&to=${filters.to}"${testId('download-statement')}>Download statement</a>`;

  return layout({
    title: account.name, user, activeNav: 'accounts',
    body: `
      <h1>${escapeHtml(account.name)}</h1>
      <p class="sub">${escapeHtml(account.type)} · ${account.sortCode} · ${account.number}</p>
      <div class="card">
        <div class="muted">Current balance</div>
        <div class="balance"${testId('account-balance')}>${money(account.balance, account.currency)}</div>
      </div>
      <div class="card">
        <form method="get" class="row" style="align-items:flex-end"${testId('transaction-filter')}>
          <div style="flex:1;min-width:150px"><label for="from">From</label>
            <input id="from" name="from" type="date" value="${filters.from}"${testId('filter-from')}></div>
          <div style="flex:1;min-width:150px"><label for="to">To</label>
            <input id="to" name="to" type="date" value="${filters.to}"${testId('filter-to')}></div>
          <div style="flex:1;min-width:150px"><label for="category">Category</label>
            <select id="category" name="category"${testId('filter-category')}>
              <option value="">All categories</option>
              ${['Groceries', 'Travel', 'Eating out', 'Utilities', 'Shopping', 'Health', 'Income']
                .map(c => `<option value="${c}"${filters.category === c ? ' selected' : ''}>${c}</option>`).join('')}
            </select></div>
          <div><button type="submit" class="primary"${testId('apply-filter')}>Apply filter</button></div>
        </form>
        ${error ? `<div class="error" role="alert"${testId('filter-error')}>${escapeHtml(error)}</div>` : ''}
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;margin-bottom:10px">
          <h2 style="font-size:18px;margin:0">Transactions</h2>
          ${downloadControl}
        </div>
        ${transactions.length === 0
          ? `<p class="muted"${testId('no-transactions')}>No transactions match the selected filters.</p>`
          : `<table${testId('transactions-table')}>
               <thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th style="text-align:right">Balance</th></tr></thead>
               <tbody>
                 ${transactions.map(t => `
                   <tr>
                     <td>${t.date}</td>
                     <td>${escapeHtml(t.description)}</td>
                     <td>${escapeHtml(t.category)}</td>
                     <td class="amount ${t.amount < 0 ? 'negative' : 'positive'}">${money(t.amount, account.currency)}</td>
                     <td class="amount">${money(t.balanceAfter, account.currency)}</td>
                   </tr>`).join('')}
               </tbody>
             </table>`}
      </div>`
  });
}

export function paymentsPage({ user, accounts, payees, message, error, values = {} }) {
  return layout({
    title: 'Payments', user, activeNav: 'payments',
    body: `
      <h1>Make a payment</h1>
      <p class="sub">Payments are simulated; no money moves anywhere.</p>
      ${message ? `<div class="success" role="status"${testId('payment-success')}>${escapeHtml(message)}</div>` : ''}
      ${error ? `<div class="error" role="alert"${testId('payment-error')}>${escapeHtml(error)}</div>` : ''}
      <div class="card">
        <form method="post" action="/payments"${testId('payment-form')}>
          <label for="fromAccount">From account</label>
          <select id="fromAccount" name="fromAccount"${testId('payment-from')}>
            ${accounts.map(a => `<option value="${a.id}"${values.fromAccount === a.id ? ' selected' : ''}>${escapeHtml(a.name)} — ${money(a.balance, a.currency)}</option>`).join('')}
          </select>
          <label for="payee">Payee</label>
          <select id="payee" name="payee"${testId('payment-payee')}>
            ${payees.map(p => `<option value="${p.id}"${values.payee === p.id ? ' selected' : ''}>${escapeHtml(p.name)} (${p.sortCode} ${p.number})</option>`).join('')}
          </select>
          <label for="amount">Amount (GBP)</label>
          <input id="amount" name="amount" type="text" inputmode="decimal" placeholder="0.00" value="${escapeHtml(values.amount ?? '')}"${testId('payment-amount')}>
          <label for="reference">Reference</label>
          <input id="reference" name="reference" maxlength="18" placeholder="Up to 18 characters" value="${escapeHtml(values.reference ?? '')}"${testId('payment-reference')}>
          <div style="margin-top:18px"><button type="submit" class="primary"${testId('payment-submit')}>Send payment</button></div>
        </form>
      </div>`
  });
}

export function profilePage({ user, message }) {
  return layout({
    title: 'Profile', user, activeNav: 'profile',
    body: `
      <h1>Profile</h1>
      <p class="sub">Your contact details.</p>
      ${message ? `<div class="success" role="status"${testId('profile-success')}>${escapeHtml(message)}</div>` : ''}
      <div class="card">
        <form method="post" action="/profile"${testId('profile-form')}>
          <label for="displayName">Name</label>
          <input id="displayName" name="displayName" value="${escapeHtml(user.displayName)}"${testId('profile-name')}>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" value="${escapeHtml(user.email)}"${testId('profile-email')}>
          <label for="phone">Phone</label>
          <input id="phone" name="phone" value="${escapeHtml(user.phone)}"${testId('profile-phone')}>
          <div style="margin-top:18px"><button type="submit" class="primary"${testId('profile-save')}>Save changes</button></div>
        </form>
      </div>`
  });
}

export function errorPage({ status, message, user }) {
  return layout({
    title: `Error ${status}`, user,
    body: `<div class="card"><h1>${status}</h1><p class="error" role="alert"${testId('error-message')}>${escapeHtml(message)}</p>
      <p><a href="/dashboard">Back to the dashboard</a></p></div>`
  });
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

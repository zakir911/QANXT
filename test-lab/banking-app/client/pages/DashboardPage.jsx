import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { lab, money, testId } from '../lab.js';

/** The landing page: total balance, one card per account, and recent activity. */
export function DashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [slowReady, setSlowReady] = useState(lab.slowElement === 0);

  useEffect(() => {
    api.dashboard().then(setData).catch(failure => setError(failure.message));
  }, []);

  // The slow-element fault delays the balance only. The page is otherwise usable, which is
  // the case a fixed sleep hides and a proper wait handles.
  useEffect(() => {
    if (lab.slowElement === 0) return;
    const timer = setTimeout(() => setSlowReady(true), lab.slowElement);
    return () => clearTimeout(timer);
  }, []);

  if (error) return <p className="error" role="alert" {...testId('dashboard-error')}>{error}</p>;
  if (!data) return <p className="loading" {...testId('dashboard-loading')}>Loading your accounts…</p>;

  return (
    <section>
      <h1 {...testId('page-title')}>Dashboard</h1>

      {data.notice && (
        <p className="notice" data-testid="application-notice">{data.notice}</p>
      )}

      <div className="summary">
        <span className="summary-label">Total balance</span>
        {slowReady
          ? <strong className="summary-value" {...testId('total-balance')}>{money(data.totalBalance)}</strong>
          : <span className="loading" {...testId('total-balance-loading')}>Calculating…</span>}
      </div>

      <div className="cards">
        {data.accounts.map(account => (
          <article key={account.id} className="card" {...testId(`account-card-${account.id}`)}>
            <h2>{account.name}</h2>
            <p className="muted">{account.type} · {account.number}</p>
            <p className="balance" {...testId(`account-balance-${account.id}`)}>{money(account.balance, account.currency)}</p>
            <Link to={`/accounts/${account.id}`} {...testId(`open-account-${account.id}`)}>View account</Link>
          </article>
        ))}
      </div>

      <h2>Quick actions</h2>
      <div className="row">
        <Link className="button" to="/payments" {...testId('quick-action-payments')}>Make a payment</Link>
        <Link className="button" to="/statements" {...testId('quick-action-statements')}>Download a statement</Link>
        <Link className="button" to="/beneficiaries" {...testId('quick-action-beneficiaries')}>Manage payees</Link>
      </div>

      <h2>Recent transactions</h2>
      {data.recentTransactions.length === 0 ? (
        <p className="empty" {...testId('recent-empty')}>No recent transactions.</p>
      ) : (
        <table {...testId('recent-transactions')}>
          <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className="right">Amount</th></tr></thead>
          <tbody>
            {data.recentTransactions.map(row => (
              <tr key={row.id} {...testId(`recent-row-${row.id}`)}>
                <td>{row.date}</td>
                <td>{row.description}</td>
                <td>{row.category}</td>
                <td className="right">{money(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

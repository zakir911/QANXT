import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { money, testId } from '../lab.js';

export function AccountsPage() {
  const [accounts, setAccounts] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.accounts().then(result => setAccounts(result.accounts)).catch(failure => setError(failure.message));
  }, []);

  if (error) return <p className="error" role="alert" {...testId('accounts-error')}>{error}</p>;
  if (!accounts) return <p className="loading" {...testId('accounts-loading')}>Loading accounts…</p>;

  return (
    <section>
      <h1 {...testId('page-title')}>Accounts</h1>
      <table {...testId('accounts-table')}>
        <thead><tr><th>Account</th><th>Type</th><th>Number</th><th className="right">Balance</th><th /></tr></thead>
        <tbody>
          {accounts.map(account => (
            <tr key={account.id} {...testId(`account-row-${account.id}`)}>
              <td>{account.name}</td>
              <td>{account.type}</td>
              <td>{account.number}</td>
              <td className="right">{money(account.balance, account.currency)}</td>
              <td><Link to={`/accounts/${account.id}`} {...testId(`open-account-${account.id}`)}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

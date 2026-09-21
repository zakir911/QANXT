import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { money, testId } from '../lab.js';

/** One account, with a paginated transaction history loaded a page at a time. */
export function AccountDetailPage() {
  const { id } = useParams();
  const [account, setAccount] = useState(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    api.account(id).then(response => setAccount(response.account)).catch(failure => setError(failure.message));
  }, [id]);

  useEffect(() => {
    api.accountTransactions(id, { page, pageSize: 10 }).then(setResult).catch(failure => setError(failure.message));
  }, [id, page]);

  if (error) return <p className="error" role="alert" {...testId('account-error')}>{error}</p>;
  if (!account) return <p className="loading" {...testId('account-loading')}>Loading account…</p>;

  return (
    <section>
      <p><Link to="/accounts" {...testId('back-to-accounts')}>← All accounts</Link></p>
      <h1 {...testId('account-name')}>{account.name}</h1>
      <p className="muted">{account.type} · {account.number} · sort code {account.sortCode}</p>
      <p className="balance large" {...testId('account-balance')}>{money(account.balance, account.currency)}</p>

      <h2>Transactions</h2>
      {!result ? <p className="loading" {...testId('transactions-loading')}>Loading transactions…</p> : (
        <>
          <table {...testId('transactions-table')}>
            <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className="right">Amount</th><th className="right">Balance</th></tr></thead>
            <tbody>
              {result.transactions.map(row => (
                <tr key={row.id} {...testId(`transaction-row-${row.id}`)}>
                  <td>{row.date}</td>
                  <td>{row.description}</td>
                  <td>{row.category}</td>
                  <td className="right">{money(row.amount)}</td>
                  <td className="right">{money(row.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.transactions.length === 0 && <p className="empty" {...testId('transactions-empty')}>No transactions to show.</p>}
          <div className="pager">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} {...testId('page-previous')}>Previous</button>
            <span {...testId('page-indicator')}>Page {result.page} of {result.pages}</span>
            <button type="button" disabled={page >= result.pages} onClick={() => setPage(page + 1)} {...testId('page-next')}>Next</button>
          </div>
        </>
      )}
    </section>
  );
}

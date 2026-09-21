import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { domId, money, testId } from '../lab.js';

const CATEGORIES = ['all', 'Groceries', 'Transport', 'Utilities', 'Dining', 'Salary', 'Transfer', 'Entertainment'];

/** Search across every account, with date, amount, category and free-text filters. */
export function TransactionsPage() {
  const [filters, setFilters] = useState({ from: '', to: '', min: '', max: '', category: 'all', q: '' });
  const [applied, setApplied] = useState({ page: 1, pageSize: 10 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setResult(null);
    api.transactions(applied).then(setResult).catch(failure => setError(failure.message));
  }, [applied]);

  const change = (key) => (event) => setFilters({ ...filters, [key]: event.target.value });

  const apply = (event) => {
    event.preventDefault();
    const query = { page: 1, pageSize: 10 };
    for (const [key, value] of Object.entries(filters)) if (value && value !== 'all') query[key] = value;
    setApplied(query);
  };

  return (
    <section>
      <h1 {...testId('page-title')}>Transactions</h1>

      <form className="filters" onSubmit={apply} {...testId('transaction-filters')}>
        <div className="field">
          <label htmlFor={domId('from')}>From date</label>
          <input id={domId('from')} type="date" value={filters.from} onChange={change('from')} {...testId('filter-from')} />
        </div>
        <div className="field">
          <label htmlFor={domId('to')}>To date</label>
          <input id={domId('to')} type="date" value={filters.to} onChange={change('to')} {...testId('filter-to')} />
        </div>
        <div className="field">
          <label htmlFor={domId('min')}>Minimum amount</label>
          <input id={domId('min')} type="number" step="0.01" value={filters.min} onChange={change('min')} {...testId('filter-min')} />
        </div>
        <div className="field">
          <label htmlFor={domId('max')}>Maximum amount</label>
          <input id={domId('max')} type="number" step="0.01" value={filters.max} onChange={change('max')} {...testId('filter-max')} />
        </div>
        <div className="field">
          <label htmlFor={domId('category')}>Category</label>
          <select id={domId('category')} value={filters.category} onChange={change('category')} {...testId('filter-category')}>
            {CATEGORIES.map(category => <option key={category} value={category}>{category === 'all' ? 'All categories' : category}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={domId('q')}>Search</label>
          <input id={domId('q')} value={filters.q} onChange={change('q')} placeholder="Description or reference" {...testId('filter-search')} />
        </div>
        <button type="submit" className="primary" {...testId('apply-filters')}>Apply filters</button>
      </form>

      {error && <p className="error" role="alert" {...testId('transactions-error')}>{error}</p>}
      {!result ? <p className="loading" {...testId('transactions-loading')}>Searching…</p> : (
        <>
          <p {...testId('result-count')}>{result.total} matching transaction{result.total === 1 ? '' : 's'}</p>
          {result.total === 0 ? <p className="empty" {...testId('transactions-empty')}>Nothing matched those filters.</p> : (
            <table {...testId('transactions-table')}>
              <thead><tr><th>Date</th><th>Description</th><th>Category</th><th className="right">Amount</th></tr></thead>
              <tbody>
                {result.transactions.map(row => (
                  <tr key={row.id} {...testId(`transaction-row-${row.id}`)}>
                    <td>{row.date}</td><td>{row.description}</td><td>{row.category}</td>
                    <td className="right">{money(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="pager">
            <button type="button" disabled={result.page <= 1}
              onClick={() => setApplied({ ...applied, page: result.page - 1 })} {...testId('page-previous')}>Previous</button>
            <span {...testId('page-indicator')}>Page {result.page} of {result.pages}</span>
            <button type="button" disabled={result.page >= result.pages}
              onClick={() => setApplied({ ...applied, page: result.page + 1 })} {...testId('page-next')}>Next</button>
          </div>
        </>
      )}
    </section>
  );
}

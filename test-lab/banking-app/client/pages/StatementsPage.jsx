import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { domId, money, testId } from '../lab.js';

/**
 * Generate a statement for an account over a date range, then download it.
 *
 * Three outcomes matter to the lab and all three are reachable: a statement with lines, a
 * valid range that legitimately contains nothing, and a range the form rejects.
 */
export function StatementsPage() {
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({ accountId: '', from: '2026-08-01', to: '2026-09-15' });
  const [statement, setStatement] = useState(null);
  const [empty, setEmpty] = useState(false);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.accounts().then(result => {
      setAccounts(result.accounts);
      setForm(current => ({ ...current, accountId: current.accountId || result.accounts[0]?.id || '' }));
    }).catch(error => setFailure(error.message));
  }, []);

  const change = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  const generate = async (event) => {
    event.preventDefault();
    setErrors({}); setFailure(null); setStatement(null); setEmpty(false); setBusy(true);
    try {
      const result = await api.statement(form);
      setStatement(result.statement);
      setEmpty(result.empty);
    } catch (error) {
      if (error.errors) setErrors(error.errors); else setFailure(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 {...testId('page-title')}>Statements</h1>

      <form className="filters" onSubmit={generate} noValidate {...testId('statement-form')}>
        <div className="field">
          <label htmlFor={domId('statement-account')}>Account</label>
          <select id={domId('statement-account')} value={form.accountId} onChange={change('accountId')} {...testId('statement-account')}>
            {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={domId('statement-from')}>From</label>
          <input id={domId('statement-from')} type="date" value={form.from} onChange={change('from')} {...testId('statement-from')} />
        </div>
        <div className="field">
          <label htmlFor={domId('statement-to')}>To</label>
          <input id={domId('statement-to')} type="date" value={form.to} onChange={change('to')} {...testId('statement-to')} />
          {errors.to && <span className="error" {...testId('statement-error-to')}>{errors.to}</span>}
        </div>
        <button type="submit" className="primary" disabled={busy} {...testId('generate-statement')}>
          {busy ? 'Generating…' : 'Generate statement'}
        </button>
      </form>

      {failure && <p className="error" role="alert" {...testId('statement-error')}>{failure}</p>}

      {statement && empty && (
        <p className="empty" {...testId('statement-empty')}>
          No transactions between {statement.from} and {statement.to}.
        </p>
      )}

      {statement && !empty && (
        <div {...testId('statement-result')}>
          <h2>{statement.accountName} · {statement.from} to {statement.to}</h2>
          <p {...testId('statement-summary')}>
            {statement.lineCount} transactions · opening {money(statement.openingBalance)} · closing {money(statement.closingBalance)}
          </p>
          <p>
            <a href={`/api/statements/${statement.id}/download`} download {...testId('download-statement')}>
              Download PDF
            </a>
          </p>
          <table {...testId('statement-lines')}>
            <thead><tr><th>Date</th><th>Description</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {statement.lines.slice(0, 25).map(line => (
                <tr key={line.id} {...testId(`statement-row-${line.id}`)}>
                  <td>{line.date}</td><td>{line.description}</td><td className="right">{money(line.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

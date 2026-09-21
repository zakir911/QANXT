import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { domId, money, testId } from '../lab.js';

/** Make a payment to a saved payee, with server-side validation surfaced per field. */
export function PaymentsPage() {
  const [accounts, setAccounts] = useState([]);
  const [payees, setPayees] = useState([]);
  const [history, setHistory] = useState([]);
  const [form, setForm] = useState({ fromAccountId: '', beneficiaryId: '', amount: '', date: '2026-09-16', reference: '' });
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    api.payments().then(result => setHistory(result.payments)).catch(() => undefined);
  };

  useEffect(() => {
    Promise.all([api.accounts(), api.beneficiaries()]).then(([accountResult, payeeResult]) => {
      setAccounts(accountResult.accounts);
      setPayees(payeeResult.beneficiaries);
      setForm(current => ({
        ...current,
        fromAccountId: current.fromAccountId || accountResult.accounts[0]?.id || '',
        beneficiaryId: current.beneficiaryId || payeeResult.beneficiaries[0]?.id || ''
      }));
    }).catch(error => setFailure(error.message));
    reload();
  }, []);

  const change = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  const submit = async (event) => {
    event.preventDefault();
    setErrors({}); setFailure(null); setConfirmation(null); setBusy(true);
    try {
      const result = await api.pay(form);
      setConfirmation(result);
      reload();
    } catch (error) {
      if (error.errors) setErrors(error.errors); else setFailure(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h1 {...testId('page-title')}>Payments</h1>

      <form className="filters" onSubmit={submit} noValidate {...testId('payment-form')}>
        <div className="field">
          <label htmlFor={domId('payment-from')}>Pay from</label>
          <select id={domId('payment-from')} value={form.fromAccountId} onChange={change('fromAccountId')} {...testId('payment-from')}>
            {accounts.map(account => (
              <option key={account.id} value={account.id}>{account.name} — {money(account.balance, account.currency)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={domId('payment-payee')}>Payee</label>
          <select id={domId('payment-payee')} value={form.beneficiaryId} onChange={change('beneficiaryId')} {...testId('payment-payee')}>
            {payees.map(payee => <option key={payee.id} value={payee.id}>{payee.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={domId('payment-amount')}>Amount</label>
          <input id={domId('payment-amount')} inputMode="decimal" value={form.amount}
            onChange={change('amount')} placeholder="0.00" {...testId('payment-amount')} />
          {errors.amount && <span className="error" {...testId('payment-error-amount')}>{errors.amount}</span>}
        </div>
        <div className="field">
          <label htmlFor={domId('payment-date')}>Payment date</label>
          <input id={domId('payment-date')} type="date" value={form.date} onChange={change('date')} {...testId('payment-date')} />
        </div>
        <div className="field">
          <label htmlFor={domId('payment-reference')}>Reference</label>
          <input id={domId('payment-reference')} maxLength={24} value={form.reference}
            onChange={change('reference')} {...testId('payment-reference')} />
          {errors.reference && <span className="error" {...testId('payment-error-reference')}>{errors.reference}</span>}
        </div>
        <button type="submit" className="primary" disabled={busy} {...testId('payment-submit')}>
          {busy ? 'Sending…' : 'Send payment'}
        </button>
      </form>

      {failure && <p className="error" role="alert" {...testId('payment-error')}>{failure}</p>}

      {confirmation && (
        <div className="confirmation" role="status" {...testId('payment-confirmation')}>
          <h2>Payment sent</h2>
          <p>
            {money(confirmation.payment.amount)} to {confirmation.payment.beneficiaryName} on {confirmation.payment.date}.
          </p>
          <p>Confirmation number <strong {...testId('confirmation-number')}>{confirmation.confirmationNumber}</strong></p>
        </div>
      )}

      <h2>Payments made in this session</h2>
      {history.length === 0 ? <p className="empty" {...testId('payments-empty')}>No payments yet.</p> : (
        <table {...testId('payments-table')}>
          <thead><tr><th>Date</th><th>Payee</th><th className="right">Amount</th><th>Reference</th></tr></thead>
          <tbody>
            {history.map(payment => (
              <tr key={payment.id} {...testId(`payment-row-${payment.id}`)}>
                <td>{payment.date}</td><td>{payment.beneficiaryName}</td>
                <td className="right">{money(payment.amount)}</td><td>{payment.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

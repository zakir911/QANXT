import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { domId, testId } from '../lab.js';

/** Saved payees, with a modal dialog for adding one. */
export function BeneficiariesPage() {
  const [payees, setPayees] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', accountNumber: '', sortCode: '', reference: '' });
  const [errors, setErrors] = useState({});
  const [added, setAdded] = useState(null);

  const reload = () => api.beneficiaries().then(result => setPayees(result.beneficiaries)).catch(() => undefined);
  useEffect(() => { reload(); }, []);

  const change = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  const save = async (event) => {
    event.preventDefault();
    setErrors({});
    try {
      const result = await api.addBeneficiary(form);
      setAdded(result.beneficiary);
      setOpen(false);
      setForm({ name: '', accountNumber: '', sortCode: '', reference: '' });
      reload();
    } catch (error) {
      setErrors(error.errors ?? { name: error.message });
    }
  };

  return (
    <section>
      <h1 {...testId('page-title')}>Beneficiaries</h1>
      <button type="button" className="primary" onClick={() => setOpen(true)} {...testId('add-beneficiary')}>Add a payee</button>

      {added && <p className="confirmation" role="status" {...testId('beneficiary-added')}>{added.name} was added.</p>}

      <table {...testId('beneficiaries-table')}>
        <thead><tr><th>Name</th><th>Account</th><th>Sort code</th><th>Reference</th></tr></thead>
        <tbody>
          {payees.map(payee => (
            <tr key={payee.id} {...testId(`beneficiary-row-${payee.id}`)}>
              <td>{payee.name}</td><td>{payee.accountNumber}</td><td>{payee.sortCode}</td><td>{payee.reference}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* A real modal: it traps the page behind it and has to be dismissed or submitted. */}
      {open && (
        <div className="modal-backdrop" {...testId('beneficiary-modal')}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Add a payee">
            <h2>Add a payee</h2>
            <form onSubmit={save} noValidate>
              <div className="field">
                <label htmlFor={domId('beneficiary-name')}>Payee name</label>
                <input id={domId('beneficiary-name')} value={form.name} onChange={change('name')} {...testId('beneficiary-name')} />
                {errors.name && <span className="error" {...testId('beneficiary-error-name')}>{errors.name}</span>}
              </div>
              <div className="field">
                <label htmlFor={domId('beneficiary-account')}>Account number</label>
                <input id={domId('beneficiary-account')} value={form.accountNumber} onChange={change('accountNumber')} {...testId('beneficiary-account')} />
                {errors.accountNumber && <span className="error" {...testId('beneficiary-error-account')}>{errors.accountNumber}</span>}
              </div>
              <div className="field">
                <label htmlFor={domId('beneficiary-sort')}>Sort code</label>
                <input id={domId('beneficiary-sort')} placeholder="00-00-00" value={form.sortCode} onChange={change('sortCode')} {...testId('beneficiary-sort')} />
                {errors.sortCode && <span className="error" {...testId('beneficiary-error-sort')}>{errors.sortCode}</span>}
              </div>
              <div className="field">
                <label htmlFor={domId('beneficiary-reference')}>Reference</label>
                <input id={domId('beneficiary-reference')} value={form.reference} onChange={change('reference')} {...testId('beneficiary-reference')} />
              </div>
              <div className="row">
                <button type="submit" className="primary" {...testId('beneficiary-save')}>Save payee</button>
                <button type="button" onClick={() => setOpen(false)} {...testId('beneficiary-cancel')}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

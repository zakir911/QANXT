import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { domId, testId } from '../lab.js';

export function ProfilePage() {
  const [profile, setProfile] = useState(null);
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState(null);

  useEffect(() => {
    api.profile().then(result => setProfile(result.profile)).catch(error => setFailure(error.message));
  }, []);

  if (failure) return <p className="error" role="alert" {...testId('profile-error')}>{failure}</p>;
  if (!profile) return <p className="loading" {...testId('profile-loading')}>Loading your details…</p>;

  const change = (key) => (event) => { setProfile({ ...profile, [key]: event.target.value }); setSaved(false); };

  const save = async (event) => {
    event.preventDefault();
    setErrors({}); setSaved(false);
    try {
      const result = await api.saveProfile(profile);
      setProfile(result.profile);
      setSaved(true);
    } catch (error) {
      if (error.errors) setErrors(error.errors); else setFailure(error.message);
    }
  };

  return (
    <section>
      <h1 {...testId('page-title')}>Profile</h1>
      <form className="filters" onSubmit={save} noValidate {...testId('profile-form')}>
        <div className="field">
          <label htmlFor={domId('profile-name')}>Full name</label>
          <input id={domId('profile-name')} value={profile.displayName} onChange={change('displayName')} {...testId('profile-name')} />
          {errors.displayName && <span className="error" {...testId('profile-error-name')}>{errors.displayName}</span>}
        </div>
        <div className="field">
          <label htmlFor={domId('profile-email')}>Email address</label>
          <input id={domId('profile-email')} type="email" value={profile.email} onChange={change('email')} {...testId('profile-email')} />
          {errors.email && <span className="error" {...testId('profile-error-email')}>{errors.email}</span>}
        </div>
        <div className="field">
          <label htmlFor={domId('profile-phone')}>Phone number</label>
          <input id={domId('profile-phone')} value={profile.phone} onChange={change('phone')} {...testId('profile-phone')} />
          {errors.phone && <span className="error" {...testId('profile-error-phone')}>{errors.phone}</span>}
        </div>
        <button type="submit" className="primary" {...testId('profile-save')}>Save changes</button>
      </form>
      {saved && <p className="confirmation" role="status" {...testId('profile-saved')}>Your details were saved.</p>}
    </section>
  );
}

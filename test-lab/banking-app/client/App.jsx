import React, { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { lab, testId } from './lab.js';

import { LoginPage } from './pages/LoginPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { AccountsPage } from './pages/AccountsPage.jsx';
import { AccountDetailPage } from './pages/AccountDetailPage.jsx';
import { TransactionsPage } from './pages/TransactionsPage.jsx';
import { StatementsPage } from './pages/StatementsPage.jsx';
import { PaymentsPage } from './pages/PaymentsPage.jsx';
import { BeneficiariesPage } from './pages/BeneficiariesPage.jsx';
import { ProfilePage } from './pages/ProfilePage.jsx';

const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

export function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.session().then(result => setUser(result.user)).catch(() => setUser(null)).finally(() => setReady(true));
  }, []);

  // The JavaScript-error fault throws after the first paint, the way a real regression in
  // an effect does: the page renders, then the console fills and the next update dies.
  useEffect(() => {
    if (!lab.jsError) return;
    const timer = setTimeout(() => { throw new Error('LAB_FAULT_JS_ERROR: statement widget could not initialise'); }, 300);
    return () => clearTimeout(timer);
  }, []);

  if (!ready) return <div className="loading" {...testId('app-loading')}>Loading your bank…</div>;

  return (
    <SessionContext.Provider value={{ user, setUser }}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Shell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:id" element={<AccountDetailPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/statements" element={<StatementsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/beneficiaries" element={<BeneficiariesPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </SessionContext.Provider>
  );
}

const NAVIGATION = [
  ['/dashboard', 'Dashboard', 'nav-dashboard'],
  ['/accounts', 'Accounts', 'nav-accounts'],
  ['/transactions', 'Transactions', 'nav-transactions'],
  ['/statements', 'Statements', 'nav-statements'],
  ['/payments', 'Payments', 'nav-payments'],
  ['/beneficiaries', 'Beneficiaries', 'nav-beneficiaries'],
  ['/profile', 'Profile', 'nav-profile']
];

/** The signed-in frame: navigation, the session guard, and the sign-out control. */
function Shell() {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  const signOut = async () => {
    await api.signOut().catch(() => undefined);
    setUser(null);
    navigate('/login');
  };

  return (
    <div className="app">
      <header className="masthead">
        <Link to="/dashboard" className="brand" {...testId('brand')}>AIRA Demo Bank</Link>
        <nav aria-label="Main" className="nav">
          {NAVIGATION.map(([path, label, id]) => (
            <NavLink key={path} to={path} {...testId(id)}
              className={({ isActive }) => (isActive ? 'active' : undefined)}>{label}</NavLink>
          ))}
        </nav>
        <div className="masthead-end">
          <span {...testId('signed-in-as')}>{user.displayName}</span>
          <button type="button" className="link" onClick={signOut} {...testId('logout')}>Sign out</button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
      <footer className="footer">Synthetic data. AIRA Demo Bank v{lab.version}.</footer>
    </div>
  );
}

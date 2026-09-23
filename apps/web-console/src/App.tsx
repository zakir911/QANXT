import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout';
import { ProjectProvider } from './lib/project';
import { useAuth } from './lib/auth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import ApplicationsPage from './pages/ApplicationsPage';
import ApplicationGraphPage from './pages/ApplicationGraphPage';
import DiscoveryPage from './pages/DiscoveryPage';
import TestCasesPage from './pages/TestCasesPage';
import TestCaseDetailPage from './pages/TestCaseDetailPage';
import TestRunsPage from './pages/TestRunsPage';
import TestRunDetailPage from './pages/TestRunDetailPage';
import ExecutionDetailPage from './pages/ExecutionDetailPage';
import FailuresPage from './pages/FailuresPage';
import HealingPage from './pages/HealingPage';
import AgentPage from './pages/AgentPage';
import InsightsPage from './pages/InsightsPage';
import SchedulesPage from './pages/SchedulesPage';
import AuditPage from './pages/AuditPage';
import VerificationPage from './pages/VerificationPage';
import SettingsPage from './pages/SettingsPage';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  // The attempted destination is preserved so signing in returns the user there rather
  // than dumping them on the dashboard.
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <ProjectProvider>
              <Layout />
            </ProjectProvider>
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="applications" element={<ApplicationsPage />} />
        <Route path="applications/:applicationId/graph" element={<ApplicationGraphPage />} />
        <Route path="discovery" element={<DiscoveryPage />} />
        <Route path="tests" element={<TestCasesPage />} />
        <Route path="tests/:testCaseId" element={<TestCaseDetailPage />} />
        <Route path="runs" element={<TestRunsPage />} />
        <Route path="runs/:runId" element={<TestRunDetailPage />} />
        <Route path="executions/:executionId" element={<ExecutionDetailPage />} />
        <Route path="failures" element={<FailuresPage />} />
        <Route path="healing" element={<HealingPage />} />
        <Route path="agent" element={<AgentPage />} />
        <Route path="insights" element={<InsightsPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="verification" element={<VerificationPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

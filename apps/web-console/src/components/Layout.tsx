import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useAuth } from '../lib/auth';
import { useProject } from '../lib/project';

interface Meta { product: string; tagline: string; version: string }

/**
 * In the order a tester works: set up the project and its application, explore it, plan and
 * run the tests, then read what they found. The numbered steps are that path; the rest
 * supports it (the test library, security scope, automation, administration).
 */
const NAV: { to: string; label: string; end?: boolean; step?: number; title?: string }[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/projects', label: 'Projects', step: 1, title: 'Step 1: choose or create the project' },
  { to: '/applications', label: 'Applications', step: 2, title: 'Step 2: add the application and its sign-in' },
  { to: '/discovery', label: 'Discovery', step: 3, title: 'Step 3: explore the application to find its pages and forms' },
  { to: '/testing', label: 'Testing', step: 4, title: 'Step 4: choose what to test, generate the tests and run them' },
  { to: '/runs', label: 'Test runs', step: 5, title: 'Step 5: follow the run and download the bug report' },
  { to: '/defects', label: 'Defects', step: 6, title: 'Step 6: confirm or reject what the tests found' },
  { to: '/human-tasks', label: 'Human checks', step: 7, title: 'Step 7: do the checks only a person can make' },
  { to: '/coverage', label: 'Coverage', step: 8, title: 'Step 8: see what was tested and what was not' },
  { to: '/failures', label: 'Failures' },
  { to: '/repository', label: 'Repository' },
  { to: '/tests', label: 'Test cases' },
  { to: '/security', label: 'Security' },
  { to: '/schedules', label: 'Schedules' },
  { to: '/healing', label: 'Healing' },
  { to: '/agent', label: 'Agent' },
  { to: '/insights', label: 'AI insights' },
  { to: '/audit', label: 'Audit' },
  { to: '/verification', label: 'Verification' },
  { to: '/settings', label: 'Settings' }
];

/// Whether the navigation has more items off the left or right edge.
///
/// The nav scrolls, but an overlay scrollbar is invisible until you already know to try,
/// so at 1280px — an ordinary laptop — "Settings" sat entirely off-screen and
/// "Verification" was cut mid-word with nothing on the page saying there was more. A fade
/// on the overflowing side is the affordance. It is measured rather than always drawn,
/// because a fade over the last item when there is nothing past it is its own small lie.
function useNavOverflow() {
  const ref = useRef<HTMLElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setEdges({ start: el.scrollLeft > 1, end: max > 1 && el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    // The nav also overflows when the window narrows, not only when it is scrolled.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => { el.removeEventListener('scroll', measure); observer.disconnect(); };
  }, [measure]);

  return { ref, ...edges };
}

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavOverflow();
  const navigate = useNavigate();
  const { projects, projectId, setProjectId } = useProject();

  // Branding comes from the server so renaming the product is a configuration change.
  const { data: meta } = useQuery({
    queryKey: ['meta'],
    queryFn: () => apiRequest<Meta>('/api/v1/meta', { authenticated: false }),
    staleTime: Infinity
  });

  const handleSignOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-full flex flex-col">
      {/* The first thing a keyboard reaches, and hidden until then. Without it, getting to
          the content meant tabbing past the project selector, sign-out and all fifteen
          navigation links — seventeen stops, on every page, every time. WCAG 2.4.1. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-lg
                   focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-semibold
                   focus:text-brand focus:shadow-lg"
      >
        Skip to the main content
      </a>

      <header className="bg-[#0b2545] text-white">
        <div className="flex flex-wrap items-center gap-4 px-5 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="font-bold tracking-tight">{meta?.product ?? 'QA NXT'}</span>
            <span className="text-xs text-white/60">{meta?.tagline}</span>
          </div>

          <label className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-white/70">Project</span>
            <select
              value={projectId ?? ''}
              onChange={event => setProjectId(event.target.value || null)}
              className="rounded-md bg-white/10 border border-white/20 px-2 py-1 text-sm text-white
                         [&>option]:text-ink"
            >
              {/* Every screen shows one project's work, so there is no "all projects" view
                  to mix them; the placeholder appears only while there is none to choose. */}
              {projects.length === 0 && <option value="">No projects yet</option>}
              {projects.map(project => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-3 text-sm">
            <span className="text-white/70" title={user?.email}>{user?.displayName}</span>
            <button type="button" onClick={handleSignOut} className="text-white/80 hover:text-white underline">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="relative">
        {nav.start && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-8
                                      bg-gradient-to-r from-surface to-transparent" />
        )}
        {nav.end && (
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8
                                      bg-gradient-to-l from-surface to-transparent" />
        )}
        <nav ref={nav.ref} aria-label="Main" className="bg-surface border-b border-line overflow-x-auto">
          <ul className="flex px-3">
            {NAV.map(item => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  title={item.title}
                  className={({ isActive }) =>
                    `inline-block whitespace-nowrap px-3.5 py-3 text-sm font-medium border-b-2 transition-colors ${
                      isActive
                        ? 'border-brand text-brand'
                        : 'border-transparent text-ink-muted hover:text-ink'
                    }`
                  }
                >
                  {item.step !== undefined && (
                    <span aria-hidden className="mr-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand/10 text-[10px] font-bold text-brand">{item.step}</span>
                  )}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      {/* tabIndex={-1} so the skip link can move focus here; without it the browser scrolls
          but focus stays behind, and the next Tab returns to the navigation. */}
      <main id="main" tabIndex={-1} className="flex-1 w-full max-w-[1400px] mx-auto px-5 py-6 focus:outline-none">
        <Outlet />
      </main>

      <footer className="border-t border-line bg-surface px-5 py-3 text-xs text-ink-subtle">
        {meta?.product ?? 'QA NXT'} {meta?.version} · Synthetic and customer data is masked before it is stored.
      </footer>
    </div>
  );
}

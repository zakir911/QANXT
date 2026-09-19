import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useAuth } from './auth';

export interface ProjectSummary {
  id: string;
  name: string;
  key: string;
  description: string;
  applicationCount: number;
  testCaseCount: number;
  openDefectCount: number;
  createdAt: string;
}

interface ProjectContextValue {
  projects: ProjectSummary[];
  projectId: string | null;
  project: ProjectSummary | null;
  setProjectId(id: string | null): void;
  isLoading: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);
const STORAGE_KEY = 'aira.project';

/**
 * The selected project scopes almost every screen. It is remembered across reloads so a
 * user returns to where they were rather than to an unfiltered view of everything.
 */
export function ProjectProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [projectId, setProjectIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY)
  );

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<ProjectSummary[]>('/api/v1/projects'),
    enabled: isAuthenticated
  });

  useEffect(() => {
    // A remembered project that no longer exists (deleted, or a different organization)
    // must not leave every screen silently empty.
    if (projectId && projects.length > 0 && !projects.some(p => p.id === projectId)) {
      setProjectIdState(null);
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (!projectId && projects.length === 1) {
      setProjectIdState(projects[0]!.id);
      localStorage.setItem(STORAGE_KEY, projects[0]!.id);
    }
  }, [projects, projectId]);

  const value = useMemo<ProjectContextValue>(() => ({
    projects,
    projectId,
    project: projects.find(p => p.id === projectId) ?? null,
    isLoading,
    setProjectId: (id: string | null) => {
      setProjectIdState(id);
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    }
  }), [projects, projectId, isLoading]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('useProject must be used inside a ProjectProvider.');
  return context;
}

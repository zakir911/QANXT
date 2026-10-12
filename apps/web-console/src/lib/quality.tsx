import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useProject } from './project';

/**
 * Shapes and helpers shared by the quality-engineering screens: testing configuration,
 * coverage, the repository, defects and human verification.
 *
 * Every figure these screens show comes from the API, which counts it from stored runs.
 * Nothing here computes a coverage number of its own.
 */

export interface ApplicationOption { id: string; name: string; baseUrl: string; pageCount: number }

export interface TaxonomyCategory { key: string; name: string; description: string; group: string; automation: string }
export interface Taxonomy {
  modes: { mode: string; categories: string[] }[];
  categories: TaxonomyCategory[];
  defaultWeights: Record<string, number>;
  defaultViewports: Viewport[];
}

export interface Viewport { name: string; width: number; height: number }

export interface TestingProfile {
  mode: string;
  categories: string[];
  viewports: Viewport[];
  browsers: string[];
  pageLoadBudgetMs: number;
  submitBudgetMs: number;
  allowSafeSecurityProbes: boolean;
  visualThresholdPercent: number;
  weights: Record<string, number>;
}

export interface FormSummary {
  id: string; formKey: string; name: string; route: string; pageUrl: string; method: string; action?: string | null;
  isMultiStep: boolean; hasCsrfToken: boolean; fieldCount: number; requiredFieldCount: number; dependencyCount: number;
  isPresent: boolean; lastSeenAt: string; changedAt?: string | null;
}

export interface CategoryCoverage {
  category: string; status: string; generated: number; executed: number; passed: number; failed: number; blocked: number;
  openGaps: number; humanTasks: number; weight: number; coveragePercent: number | null;
}

export interface FormCoverage {
  formId: string; name: string; route: string; pageUrl: string; fields: number; requiredFields: number; isMultiStep: boolean;
  generated: number; executed: number; passed: number; failed: number; blocked: number; notRun: number;
  coveragePercent: number | null; passPercent: number | null; gaps: number; humanTasks: number; humanTasksOpen: number; findings: number;
  categories: CategoryCoverage[];
}

export interface GapView {
  id: string; formId?: string | null; formName?: string | null; fieldKey?: string | null; category: string;
  missing: string; reason: string; recommendedAction: string; status: string;
}

export interface ApplicationCoverage {
  applicationId: string; applicationName: string; mode: string; selectedCategories: string[];
  surface: {
    discoveredPages: number; discoveredForms: number; discoveredFields: number; discoveredEndpoints: number;
    testableTests: number; executedTests: number; passedTests: number; failedTests: number;
    partiallyCovered: number; humanRequired: number; unsupported: number; unknownBoundaries: number; notCovered: number;
  };
  overallCoveragePercent: number | null; passPercent: number | null;
  forms: FormCoverage[];
  dimensions: { dimension: string; discovered: number; tested: number; executed: number; detail: string }[];
  categories: CategoryCoverage[];
  gaps: GapView[];
  humanTasksByStatus: Record<string, number>;
  statement: string;
}

export const CATEGORY_LABEL: Record<string, string> = {
  functional: 'Functional', negative: 'Negative', boundary: 'Boundary', equivalence: 'Equivalence', validation: 'Validation',
  inputValidation: 'Input handling', crossField: 'Cross-field', dynamic: 'Dynamic', multiStep: 'Multi-step', workflow: 'Workflow',
  regression: 'Regression', accessibility: 'Accessibility', security: 'Security', api: 'API', performance: 'Performance',
  compatibility: 'Compatibility', responsive: 'Responsive', visual: 'Visual', usability: 'Usability', exploratory: 'Exploratory',
  dataIntegrity: 'Data integrity', stateTransition: 'State transition', errorHandling: 'Error handling', reliability: 'Reliability',
  recovery: 'Recovery', smoke: 'Smoke'
};

export const categoryLabel = (key: string) => CATEGORY_LABEL[key] ?? key;

/** "93.5%" or "not measured" — never a number the API did not give. */
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? 'not measured' : `${value}%`;
}

export function useApplications() {
  const { projectId } = useProject();
  return useQuery({
    queryKey: ['applications', projectId],
    queryFn: () => apiRequest<ApplicationOption[]>(`/api/v1/applications?projectId=${projectId}`),
    enabled: Boolean(projectId)
  });
}

export function useTaxonomy() {
  return useQuery({
    queryKey: ['testing-taxonomy'],
    queryFn: () => apiRequest<Taxonomy>('/api/v1/meta/testing-taxonomy'),
    staleTime: Infinity
  });
}

const APP_KEY = 'qanxt.quality.application';

/** The application the quality screens are looking at, remembered across them. */
export function useSelectedApplication(applications: ApplicationOption[]) {
  const [applicationId, setApplicationId] = useState<string | null>(() => {
    try { return localStorage.getItem(APP_KEY); } catch { return null; }
  });
  useEffect(() => {
    if (applications.length === 0) return;
    if (!applicationId || !applications.some(a => a.id === applicationId)) setApplicationId(applications[0]!.id);
  }, [applications, applicationId]);
  const select = (id: string) => {
    setApplicationId(id);
    try { localStorage.setItem(APP_KEY, id); } catch { /* memory only */ }
  };
  return [applicationId, select] as const;
}

export function ApplicationPicker({ applications, value, onChange }: {
  applications: ApplicationOption[]; value: string | null; onChange(id: string): void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">Application</span>
      <select className="input" value={value ?? ''} onChange={e => onChange(e.target.value)} aria-label="Application">
        {applications.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </label>
  );
}

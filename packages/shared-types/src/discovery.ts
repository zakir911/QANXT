import type { ElementKind, PageKind } from './enums.js';
import type { LocatorDescriptor } from './locator.js';

/**
 * What the crawler reports for one page. The signals captured here are exactly the
 * ones the locator engine later scores against, so a healed locator can always be
 * explained in terms of something that was observed.
 */
export interface DiscoveredPage {
  url: string;
  normalizedUrl: string;
  route: string;
  title: string;
  kind: PageKind;
  depth: number;
  parentNormalizedUrl?: string;
  requiresAuthentication: boolean;
  httpStatus?: number;
  loadTimeMs: number;
  consoleErrorCount: number;
  visibleTextExcerpt: string;
  screenshotKey?: string;
  domKey?: string;
  accessibilityKey?: string;
  elements: DiscoveredElement[];
}

export interface DiscoveredElement {
  kind: ElementKind;
  tagName: string;
  ariaRole?: string;
  accessibleName?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  elementId?: string;
  name?: string;
  type?: string;
  title?: string;
  value?: string;
  cssSelector?: string;
  xpath?: string;
  domPath?: string;
  parentSignature?: string;
  neighbourText?: string;
  bounding: { x: number; y: number; width: number; height: number };
  isVisible: boolean;
  isEnabled: boolean;
  isRequired: boolean;
  attributes: Record<string, string>;
  preferredLocator: LocatorDescriptor;
  stabilityScore: number;
}

export interface DiscoveredTransition {
  fromNormalizedUrl: string;
  toNormalizedUrl: string;
  action: string;
  triggerAccessibleName?: string;
}

export interface DiscoveredApiEndpoint {
  method: string;
  urlTemplate: string;
  sampleUrl: string;
  /** How many times this call was seen during the run. */
  timesObserved: number;
  statusCode?: number;
  durationMs: number;
  requestSample?: string;
  responseSample?: string;
  requestContentType?: string;
  responseContentType?: string;
  requiresAuthentication: boolean;
  triggeredByNormalizedUrl?: string;
}

export interface DiscoveryProgressReport {
  discoveryRunId: string;
  pagesVisited: number;
  pagesQueued: number;
  elementsFound: number;
  currentUrl?: string;
  message: string;
  occurredAt: string;
}

export interface DiscoveryCompletionReport {
  discoveryRunId: string;
  status: 'completed' | 'failed' | 'partiallyCompleted' | 'cancelled';
  startedAt: string;
  completedAt: string;
  workerId: string;
  pages: DiscoveredPage[];
  transitions: DiscoveredTransition[];
  apiEndpoints: DiscoveredApiEndpoint[];
  consoleErrors: { level: string; message: string; url?: string; occurredAt: string }[];
  pagesBlockedByPolicy: number;
  errorMessage?: string;
  progressLog: string;
}

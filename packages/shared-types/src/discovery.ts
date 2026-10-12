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
  /** Forms on the page, each with its fields, constraints and observed dependencies. */
  forms?: DiscoveredForm[];
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

// ---- Forms -------------------------------------------------------------------

export interface DiscoveredFormOption {
  value: string;
  label: string;
  disabled: boolean;
}

export interface DiscoveredFormField {
  key: string;
  name: string | null;
  elementId: string | null;
  testId: string | null;
  label: string | null;
  hasAssociatedLabel: boolean;
  accessibleName: string | null;
  placeholder: string | null;
  tagName: string;
  /** The control as a tester names it: text, email, number, select, multiselect, radio, checkbox, switch, textarea, file, … */
  controlType: string;
  htmlType: string | null;
  role: string | null;
  required: boolean;
  readOnly: boolean;
  disabled: boolean;
  visible: boolean;
  defaultValue: string | null;
  checked: boolean;
  constraints: Record<string, string>;
  options: DiscoveredFormOption[];
  autocomplete: string | null;
  inputMode: string | null;
  describedByText: string | null;
  ariaInvalid: boolean;
  /** Index of the step or section the field sits in, when the form has several. */
  group: number;
  groupLabel: string | null;
  locator: LocatorDescriptor;
}

export interface DiscoveredFormButton {
  label: string;
  type: string;
  testId: string | null;
  role: 'submit' | 'next' | 'previous' | 'reset' | 'cancel' | 'other';
  visible: boolean;
  disabled: boolean;
  locator: LocatorDescriptor;
}

export interface DiscoveredForm {
  key: string;
  name: string;
  hasFormElement: boolean;
  /** Position among the page's <form> elements, or -1 for an implicit form. */
  domIndex: number;
  action: string | null;
  method: string;
  enctype: string | null;
  noValidate: boolean;
  hasCsrfToken: boolean;
  hiddenFieldNames: string[];
  locator: LocatorDescriptor;
  fields: DiscoveredFormField[];
  buttons: DiscoveredFormButton[];
  groupCount: number;
  visibleGroup: number;
  isMultiStep: boolean;
  stepIndicatorText: string | null;
  /** What changing each select, checkbox and radio group did to the rest of the form. */
  dependencies: FormDependency[];
  /** Why the dependency probe stopped early, when it did. */
  probeNote?: string;
}

/** One observed effect of answering a control: fields shown, hidden, made required, or repopulated. */
export interface FormDependency {
  trigger: string;
  triggerLabel: string;
  triggerValue: string;
  shows: string[];
  hides: string[];
  becomesRequired: string[];
  /** Selects whose options changed, with the options they then held. */
  optionsOf: Record<string, string[]>;
}


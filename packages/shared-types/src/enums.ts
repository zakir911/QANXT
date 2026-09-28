/**
 * Enum vocabularies mirrored from the .NET domain. The API serialises enums as
 * camelCase strings, so these unions are what actually travels on the wire.
 *
 * `packages/shared-types/test/contract.test.ts` asserts these stay in step with
 * `apps/api/src/QaNxt.Domain/Enums/Enums.cs`; if that test fails, the two sides
 * of the wire have drifted.
 */

export const BROWSER_ACTION_TYPES = [
  'navigate', 'click', 'doubleClick', 'fill', 'select', 'check', 'uncheck',
  'hover', 'press', 'upload', 'download', 'wait', 'screenshot', 'scroll',
  'assertText', 'assertVisible', 'assertHidden', 'assertUrl', 'assertValue',
  'assertCount', 'assertAttribute', 'assertEnabled', 'assertDisabled',
  'apiRequest',
  'checkAccessibility',
  'checkVisual',
  'executeScript'
] as const;
export type BrowserActionType = (typeof BROWSER_ACTION_TYPES)[number];

/** Verbs that assert rather than act. Used to decide how a step failure is reported. */
export const ASSERTION_ACTIONS: readonly BrowserActionType[] = [
  'assertText', 'assertVisible', 'assertHidden', 'assertUrl', 'assertValue',
  'assertCount', 'assertAttribute', 'assertEnabled', 'assertDisabled'
];

export const LOCATOR_STRATEGIES = [
  'role', 'testId', 'label', 'placeholder', 'text', 'altText', 'title', 'css', 'xpath'
] as const;
export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

export const RUN_TRIGGERS = ['manual', 'scheduled', 'cicd', 'api', 'agent'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const BROWSER_TYPES = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserType = (typeof BROWSER_TYPES)[number];

export const EXECUTION_STATUSES = [
  'pending', 'queued', 'running', 'passed', 'failed', 'skipped', 'blocked',
  'healed', 'flaky', 'timedOut', 'cancelled', 'error'
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const FAILURE_CATEGORIES = [
  'unknown', 'applicationDefect', 'testDefect', 'environmentDefect', 'locatorChange',
  'timingIssue', 'networkIssue', 'authenticationIssue', 'dataIssue', 'thirdPartyDependency'
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const ELEMENT_KINDS = [
  'unknown', 'link', 'button', 'textInput', 'passwordInput', 'numberInput', 'dateInput',
  'fileInput', 'checkbox', 'radio', 'select', 'textArea', 'form', 'table', 'dialog',
  'menu', 'tab', 'navigation', 'heading', 'image', 'alert', 'text'
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

export const PAGE_KINDS = [
  'unknown', 'login', 'dashboard', 'list', 'detail', 'form', 'report', 'settings', 'error'
] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
export type HealingPolicy = 'never' | 'suggest' | 'auto';
export type AuthenticationStrategy = 'none' | 'formLogin' | 'storageState' | 'bearerToken' | 'basicAuth';
export type TestPriority = 'critical' | 'high' | 'medium' | 'low';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';
export const ASSERTION_TYPES = [
  'textEquals', 'textContains', 'visible', 'hidden', 'urlEquals', 'urlContains',
  'valueEquals', 'countEquals', 'attributeEquals', 'enabled', 'disabled',
  'httpStatusEquals', 'noConsoleErrors',
  'responseStatusIn', 'responseTimeUnderMs', 'responseBodyContains',
  'responseJsonPathEquals', 'responseJsonPathExists', 'responseJsonPathMatches',
  'responseHeaderEquals', 'responseSchemaMatches'
] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** Assertion types evaluated against an HTTP response rather than a page. */
export const RESPONSE_ASSERTION_TYPES: readonly AssertionType[] = [
  'httpStatusEquals', 'responseStatusIn', 'responseTimeUnderMs', 'responseBodyContains',
  'responseJsonPathEquals', 'responseJsonPathExists', 'responseJsonPathMatches',
  'responseHeaderEquals', 'responseSchemaMatches'
];

export const TEST_CASE_KINDS = ['ui', 'api', 'mixed'] as const;
export type TestCaseKind = (typeof TEST_CASE_KINDS)[number];

export const API_AUTH_MODES = [
  'none', 'inheritSession', 'bearer', 'basic', 'apiKeyHeader', 'apiKeyQuery',
  'oAuth2ClientCredentials'
] as const;
export type ApiAuthMode = (typeof API_AUTH_MODES)[number];

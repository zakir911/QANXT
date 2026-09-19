import type { BrowserActionType } from './enums.js';
import type { LocatorDescriptor } from './locator.js';

/**
 * The shape the browser extension exports and the platform imports. It is
 * deliberately close to a test case without being one: journeys describe what a
 * person did, and generation turns that into assertions and test data.
 */
export interface RecordedJourney {
  /** Contract version, so an older extension build fails loudly rather than silently. */
  schemaVersion: 1;
  name: string;
  description?: string;
  startUrl: string;
  recordedAt: string;
  recorderVersion: string;
  steps: RecordedStep[];
}

export interface RecordedStep {
  order: number;
  action: BrowserActionType;
  description: string;
  target?: LocatorDescriptor;
  /** Candidate locators the recorder considered, best first. */
  candidates?: LocatorDescriptor[];
  /** Recorded values are masked at capture: a password field yields a secret reference. */
  value?: string;
  url?: string;
  expected?: string;
  annotation?: string;
  timestampMs: number;
}

export function isRecordedJourney(value: unknown): value is RecordedJourney {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RecordedJourney>;
  return candidate.schemaVersion === 1
    && typeof candidate.name === 'string'
    && typeof candidate.startUrl === 'string'
    && Array.isArray(candidate.steps);
}

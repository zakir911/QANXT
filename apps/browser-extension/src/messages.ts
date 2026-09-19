import type { LocatorDescriptor } from './locator.js';

/** The message contract between the popup, the service worker and the content script. */

export type BrowserActionType =
  | 'navigate' | 'click' | 'doubleClick' | 'fill' | 'select' | 'check' | 'uncheck'
  | 'press' | 'assertText' | 'assertVisible' | 'assertUrl' | 'assertValue';

export interface RecordedStep {
  order: number;
  action: BrowserActionType;
  description: string;
  target?: LocatorDescriptor;
  candidates?: LocatorDescriptor[];
  value?: string;
  url?: string;
  expected?: string;
  annotation?: string;
  timestampMs: number;
}

export interface RecordedJourney {
  schemaVersion: 1;
  name: string;
  description?: string;
  startUrl: string;
  recordedAt: string;
  recorderVersion: string;
  steps: RecordedStep[];
}

export interface RecordingState {
  recording: boolean;
  paused: boolean;
  tabId?: number;
  startUrl?: string;
  name: string;
  steps: RecordedStep[];
  startedAt?: string;
}

export type ContentToBackground =
  | { kind: 'step'; step: Omit<RecordedStep, 'order'> }
  | { kind: 'inspected'; locator: LocatorDescriptor; candidates: LocatorDescriptor[]; description: string }
  | { kind: 'ready' };

export type BackgroundToContent =
  | { kind: 'startRecording' }
  | { kind: 'stopRecording' }
  | { kind: 'startInspecting' }
  | { kind: 'stopInspecting' }
  | { kind: 'startAsserting' };

export type PopupToBackground =
  | { kind: 'getState' }
  | { kind: 'start'; name: string }
  | { kind: 'stop' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'removeStep'; order: number }
  | { kind: 'annotateStep'; order: number; annotation: string }
  | { kind: 'inspect' }
  | { kind: 'assert' }
  | { kind: 'export' }
  | { kind: 'send'; apiUrl: string; token: string; projectId: string; applicationId: string };

export const RECORDER_VERSION = '0.1.0';

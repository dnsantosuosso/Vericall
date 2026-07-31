// Shared message contract between the popup UI and the content script.
import type { SessionSummary } from './controller.js';
import type { TamperMode } from '../core/index.js';

export type PopupToContent =
  | { type: 'vericall-cmd'; cmd: 'start'; session: string }
  | { type: 'vericall-cmd'; cmd: 'stop' }
  | { type: 'vericall-cmd'; cmd: 'getStatus' }
  | { type: 'vericall-cmd'; cmd: 'setTamper'; mode: TamperMode };

export interface ContentReply {
  ok: boolean;
  onMeet: boolean;
  running: boolean;
  summary: SessionSummary | null;
  error?: string;
}

/** Pushed from content → popup (and background) whenever status changes. */
export interface StatusBroadcast {
  type: 'vericall-status';
  running: boolean;
  summary: SessionSummary | null;
}

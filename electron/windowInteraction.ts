import type { WindowInteractionMode } from '../shared/protocol';

interface WindowTarget {
  setFocusable(value: boolean): void;
  showInactive(): void;
  show(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
}

/** Displaying is not editing. Never restore/focus a browsing window. */
export function displayWindow(window: WindowTarget, mode: WindowInteractionMode): void {
  window.setFocusable(mode === 'edit');
  if (mode === 'browse') window.showInactive();
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

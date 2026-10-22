import type { WindowInteractionMode } from '../shared/protocol';

interface WindowTarget {
  isFocusable(): boolean;
  setFocusable(value: boolean): void;
  showInactive(): void;
  show(): void;
  focus(): void;
  isMinimized(): boolean;
  restore(): void;
}

/** Displaying is not editing. Never restore/focus a browsing window. */
export function displayWindow(window: WindowTarget, mode: WindowInteractionMode): void {
  // On Windows setFocusable(false) also runs native Focus(false), even when
  // already non-focusable. Do not rewrite activation styles on every wake.
  if (window.isFocusable() !== (mode === 'edit')) window.setFocusable(mode === 'edit');
  if (mode === 'browse') window.showInactive();
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

/** CSS transparency alone does not express native whole-window translucency. */
export function prepareRegionWindow(window: { setOpacity(value: number): void }, platform: string): void {
  if (platform === 'win32') window.setOpacity(0.99);
}

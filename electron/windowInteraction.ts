import type { WindowInteractionMode } from '../shared/protocol';

interface WindowTarget {
  isVisible(): boolean;
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
  if (mode === 'browse') {
    if (!window.isVisible()) window.showInactive();
  }
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

interface TrayWindowTarget extends WindowTarget {
  hide(): void;
  setOpacity(value: number): void;
  setIgnoreMouseEvents(value: boolean): void;
}

/**
 * Keep the Windows non-activating render widget mapped. Native hide/show can
 * leave it painting but unable to receive mouse input. A parked window is
 * invisible AND click-through; opacity is restored before accepting input.
 * Logical visibility, rather than HWND visibility, drives the tray/hotkeys.
 */
export class TrayWindowVisibility {
  private shown = false;
  constructor(private window: TrayWindowTarget, private platform: string, private changed: (visible: boolean) => void) {}

  get visible(): boolean { return this.shown && this.window.isVisible(); }

  show(mode: WindowInteractionMode): void {
    if (this.platform === 'win32') {
      this.window.setOpacity(1);
      this.window.setIgnoreMouseEvents(false);
    }
    displayWindow(this.window, mode);
    const changed = !this.shown;
    this.shown = true;
    if (changed) this.changed(true);
  }

  hide(): void {
    if (!this.shown) return;
    if (this.platform === 'win32') {
      this.window.setIgnoreMouseEvents(true);
      this.window.setOpacity(0);
    } else this.window.hide();
    this.shown = false;
    this.changed(false);
  }
}

/** CSS transparency alone does not express native whole-window translucency. */
export function prepareRegionWindow(window: { setOpacity(value: number): void }, platform: string): void {
  if (platform === 'win32') window.setOpacity(0.99);
}

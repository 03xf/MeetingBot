import type { WindowInteractionMode } from './protocol';

/** Editing is explicit. No secondary action may unlock a Windows overlay. */
export function browseLocked(platform: string, mode: WindowInteractionMode): boolean {
  return platform === 'win32' && mode === 'browse';
}

/** Background alpha only; text and controls must never inherit window opacity. */
export const DEFAULT_BACKGROUND_OPACITY = 0.8;

export function backgroundOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0.05, Math.min(1, value))
    : DEFAULT_BACKGROUND_OPACITY;
}

export const DEFAULT_TRANSCRIPT_RATIO = 0.5;
export const PANE_DIVIDER_WIDTH = 8;
export const MIN_PANE_WIDTH = 220;

/** Persist a preferred ratio; the current window adds its own pixel limits. */
export function transcriptRatio(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0.15, Math.min(0.85, value))
    : DEFAULT_TRANSCRIPT_RATIO;
}

export function paneRatioBounds(width: number): [number, number] {
  const available = width - PANE_DIVIDER_WIDTH;
  if (!Number.isFinite(available) || available <= 0) return [0.5, 0.5];
  const min = Math.max(0.15, Math.min(1 / 3, MIN_PANE_WIDTH / available));
  return [min, 1 - min];
}

export function fittedTranscriptRatio(value: unknown, width: number): number {
  const [min, max] = paneRatioBounds(width);
  return Math.max(min, Math.min(max, transcriptRatio(value)));
}

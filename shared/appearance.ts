/** Background alpha only; text and controls must never inherit window opacity. */
export const DEFAULT_BACKGROUND_OPACITY = 0.8;

export function backgroundOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0.05, Math.min(1, value))
    : DEFAULT_BACKGROUND_OPACITY;
}

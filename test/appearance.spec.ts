import { expect, it } from 'vitest';
import { fittedTranscriptRatio, paneRatioBounds, PANE_DIVIDER_WIDTH, transcriptRatio } from '../shared/appearance';

it('keeps both panes accessible at normal and narrow widths without replacing the saved preference', () => {
  expect(fittedTranscriptRatio(0.3, 1200)).toBe(0.3);
  const wide = paneRatioBounds(1200);
  expect(wide[0] * (1200 - PANE_DIVIDER_WIDTH)).toBeCloseTo(220);
  expect((1 - wide[1]) * (1200 - PANE_DIVIDER_WIDTH)).toBeCloseTo(220);
  const narrow = fittedTranscriptRatio(0.15, 500);
  expect(narrow).toBeCloseTo(1 / 3);
  expect(fittedTranscriptRatio(0.15, 2000)).toBe(0.15);
  expect(fittedTranscriptRatio(0.8, 0)).toBe(0.5);
});

it('loads old or corrupt preferences safely and limits extreme ratios', () => {
  for (const value of [undefined, null, '0.3', NaN, Infinity, {}]) expect(transcriptRatio(value)).toBe(0.5);
  expect(transcriptRatio(-10)).toBe(0.15);
  expect(transcriptRatio(10)).toBe(0.85);
});

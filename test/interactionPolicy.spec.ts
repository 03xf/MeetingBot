import { expect, it } from 'vitest';
import { browseLocked } from '../shared/interactionPolicy';

it('locks only Windows browse mode and leaves explicit editing available', () => {
  expect(browseLocked('win32', 'browse')).toBe(true);
  expect(browseLocked('win32', 'edit')).toBe(false);
  expect(browseLocked('darwin', 'edit')).toBe(false);
  expect(browseLocked('linux', 'browse')).toBe(false);
});

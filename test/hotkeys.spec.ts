import { expect, it, vi } from 'vitest';
import { registerBindings } from '../electron/hotkeys';

it('keeps later bindings available after an invalid or occupied accelerator', () => {
  const run = vi.fn();
  const registered = new Map<string, () => void>();
  const failed = registerBindings(['invalid', 'occupied', 'valid'].map(key => ({ key, run })), (key, callback) => {
    if (key === 'invalid') throw Error('invalid accelerator');
    if (key === 'occupied') return false;
    registered.set(key, callback); return true;
  });
  expect(failed).toEqual(['invalid', 'occupied']);
  registered.get('valid')!();
  expect(run).toHaveBeenCalledOnce();
});

it('does not register shortcuts that the user disabled', () => {
  const register = vi.fn();
  expect(registerBindings([{ key: '', run: vi.fn() }], register)).toEqual([]);
  expect(register).not.toHaveBeenCalled();
});

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WindowFaults } from '../electron/windowFaults';
import { clearDiagnosticErrors, recentDiagnosticErrors } from '../electron/diagnostics';

describe('persistent window fault history', () => {
  it('keeps a bounded sanitized history and restores it into the support report', async () => {
    clearDiagnosticErrors();
    const file = join(mkdtempSync(join(tmpdir(), 'mc-window-faults-')), 'faults.json');
    const faults = new WindowFaults(file);
    for (let i = 0; i < 22; i++) faults.record('unresponsive', `failure ${i}; Authorization: Bearer sk-fake-secret-for-test-1234567890`);
    await faults.flush();
    const text = readFileSync(file, 'utf8'); expect(text).not.toContain('sk-fake-secret-for-test-1234567890');
    const saved = JSON.parse(text); expect(saved).toHaveLength(20); expect(saved[0].message).toContain('failure 2');
    clearDiagnosticErrors(); new WindowFaults(file);
    expect(recentDiagnosticErrors()).toHaveLength(20);
  });
  it('ignores damaged or unrelated persisted entries without breaking startup', async () => {
    clearDiagnosticErrors(); const file = join(mkdtempSync(join(tmpdir(), 'mc-window-faults-')), 'faults.json');
    writeFileSync(file, JSON.stringify([{ at: 'bad date', scope: 'window/a', message: 'bad' }, { at: new Date().toISOString(), scope: 'not-window', message: 'unrelated' }]));
    expect(() => new WindowFaults(file)).not.toThrow(); expect(recentDiagnosticErrors()).toHaveLength(0);
  });
});

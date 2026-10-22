import { mkdirSync, readFileSync, statSync } from 'fs';
import { writeFile, rename } from 'fs/promises';
import { dirname } from 'path';
import { recordDiagnosticError, recentDiagnosticErrors, type DiagnosticErrorEntry } from './diagnostics';

/** Small, sanitized window fault history survives restarting an unresponsive UI. */
export class WindowFaults {
  private entries: DiagnosticErrorEntry[] = [];
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {
    try {
      if (statSync(file).size > 32_768) return;
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) this.entries = parsed.filter((e): e is DiagnosticErrorEntry =>
        typeof e?.at === 'string' && Number.isFinite(Date.parse(e.at)) &&
        typeof e?.scope === 'string' && e.scope.startsWith('window/') && typeof e?.message === 'string')
        .slice(-20).map(e => ({ at: e.at.slice(0, 40), scope: e.scope.slice(0, 80), message: e.message.slice(0, 400) }));
      // Run persisted values through the existing redactor too.
      for (const e of this.entries) recordDiagnosticError(e.scope, e.message, new Date(e.at));
      this.entries = this.entries.length ? recentDiagnosticErrors().slice(-this.entries.length) : [];
    } catch { this.entries = []; }
  }
  record(kind: string, detail: string): void {
    recordDiagnosticError('window/' + kind, detail);
    const entry = recentDiagnosticErrors().at(-1);
    if (!entry) return;
    this.entries = [...this.entries, entry].slice(-20);
    const data = JSON.stringify(this.entries, null, 2);
    this.writing = this.writing.catch(() => {}).then(async () => {
      mkdirSync(dirname(this.file), { recursive: true });
      await writeFile(this.file + '.tmp', data, 'utf8');
      await rename(this.file + '.tmp', this.file);
    }).catch(() => {}); // disk failure must not freeze or terminate the app
  }
  async flush(): Promise<void> { await this.writing; }
}

/** Personal library shared by all sessions; retrieval itself stays local. */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import type { KnowledgeSummary, KnowledgeContext } from '../shared/protocol';
import { KnowledgeIndex, type KnowledgeDocument } from './knowledgeSearch';

export const MAX_DOCUMENT_CHARS = 2_000_000;
export const MAX_LIBRARY_CHARS = 10_000_000;

export class KnowledgeStore {
  private documents: KnowledgeDocument[] = [];
  private index = new KnowledgeIndex([]);
  private unreadable = false;

  constructor(private readonly filePath: string, legacyPath?: string) {
    try {
      if (existsSync(filePath)) {
        // Never silently replace an unreadable library with an empty one.
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        if (!raw || raw.version !== 1 || !Array.isArray(raw.documents) || raw.documents.some((d: KnowledgeDocument) =>
          !d || typeof d.id !== 'string' || typeof d.name !== 'string' || typeof d.text !== 'string' || !Number.isFinite(d.createdAt))) {
          throw new Error('Invalid personal knowledge library');
        }
        this.documents = raw.documents;
      } else if (legacyPath && existsSync(legacyPath)) {
        const text = readFileSync(legacyPath, 'utf8').trim();
        if (text) this.commit([{ id: randomUUID(), name: 'knowledge.md', text, createdAt: Date.now() }]);
      }
      this.index = new KnowledgeIndex(this.documents);
    } catch {
      // Keep the app usable, but never overwrite a file we could not read.
      this.unreadable = true;
      this.documents = [];
      this.index = new KnowledgeIndex([]);
    }
  }

  get chars(): number {
    return this.documents.reduce((n, d) => n + d.text.length, 0);
  }

  summary(): KnowledgeSummary {
    return { chars: this.chars, documents: this.documents.map(({ text, ...d }) => ({ ...d, chars: text.length })), ...(this.unreadable ? { error: 'READ_FAILED' as const } : {}) };
  }

  add(name: string, text: string): void {
    const clean = text.trim();
    if (!clean) throw new Error('NO_TEXT');
    if (this.documents.some((d) => d.name === name && d.text === clean)) return;
    if (clean.length > MAX_DOCUMENT_CHARS || this.chars + clean.length > MAX_LIBRARY_CHARS) throw new Error('TOO_LARGE');
    this.commit([...this.documents, { id: randomUUID(), name, text: clean, createdAt: Date.now() }]);
  }

  remove(id: string): void { this.commit(this.documents.filter((d) => d.id !== id)); }
  clear(): void { this.commit([]); }

  retrieve(query: string): KnowledgeContext {
    return { documentCount: this.documents.length, sources: this.index.search(query), ...(this.unreadable ? { error: 'READ_FAILED' as const } : {}) };
  }

  private commit(documents: KnowledgeDocument[]): void {
    if (this.unreadable) throw new Error('LIBRARY_UNREADABLE');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, documents }), 'utf8');
    renameSync(tmp, this.filePath);
    this.documents = documents;
    this.index = new KnowledgeIndex(documents);
  }
}

/** Local lexical retrieval. No network, embeddings, or additional credentials. */
import type { KnowledgeSource } from '../shared/protocol';

export interface KnowledgeDocument {
  id: string;
  name: string;
  text: string;
  createdAt: number;
}

const STOP_WORDS = new Set('a an the is are was were do does did i you my me we our to of for in on and or with what how please explain tell about this that'.split(' '));
const CJK_STOP = new Set(['什么', '怎么', '如何', '一下', '介绍', '请问', '可以', '我们', '你们', '这个', '那个', '的是', '我的']);

export function searchTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? []) {
    for (const part of word.match(/[\p{Script=Han}]+|[^\p{Script=Han}]+/gu) ?? []) {
      if (/\p{Script=Han}/u.test(part)) {
        if (part.length === 1) continue;
        for (let i = 0; i < part.length - 1; i++) {
          const pair = part.slice(i, i + 2);
          if (!CJK_STOP.has(pair)) tokens.push(pair);
        }
      } else if (part.length > 1 && !STOP_WORDS.has(part)) tokens.push(part);
    }
  }
  return tokens;
}

export function chunkDocument(doc: KnowledgeDocument): KnowledgeSource[] {
  const chunks: KnowledgeSource[] = [];
  const text = doc.text.trim();
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 1000, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('。', end), text.lastIndexOf('. ', end));
      if (boundary > start + 500) end = boundary + 1;
    }
    chunks.push({ documentId: doc.id, documentName: doc.name, chunkIndex: chunks.length, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end - 120;
  }
  return chunks;
}

export class KnowledgeIndex {
  private entries: { source: KnowledgeSource; terms: Map<string, number>; length: number }[];
  private frequencies = new Map<string, number>();
  private averageLength: number;

  constructor(documents: KnowledgeDocument[]) {
    this.entries = documents.flatMap(chunkDocument).map((source) => {
      const tokens = searchTokens(source.text + '\n' + source.documentName);
      const terms = new Map<string, number>();
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
      for (const token of terms.keys()) this.frequencies.set(token, (this.frequencies.get(token) ?? 0) + 1);
      return { source, terms, length: tokens.length };
    });
    this.averageLength = this.entries.reduce((n, e) => n + e.length, 0) / (this.entries.length || 1) || 1;
  }

  search(query: string, maxChars = 6000, limit = 6): KnowledgeSource[] {
    // Small libraries fit whole: also covers paraphrases and screenshot-only questions.
    const total = this.entries.reduce((n, e) => n + e.source.text.length, 0);
    if (total <= maxChars && this.entries.length <= limit) return this.entries.map((e) => e.source);
    const tokens = [...new Set(searchTokens(query))];
    if (!tokens.length) return [];
    const ranked = this.entries.map((entry, order) => {
      let score = 0;
      for (const token of tokens) {
        const tf = entry.terms.get(token) ?? 0;
        if (!tf) continue;
        const df = this.frequencies.get(token) ?? 0;
        const idf = Math.log(1 + (this.entries.length - df + 0.5) / (df + 0.5));
        score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * entry.length / this.averageLength));
      }
      return { ...entry, score, order };
    }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || a.order - b.order);
    const result: KnowledgeSource[] = [];
    let used = 0;
    for (const entry of ranked) {
      if (result.length >= limit) break;
      if (used + entry.source.text.length > maxChars) continue;
      result.push(entry.source);
      used += entry.source.text.length;
    }
    return result;
  }
}

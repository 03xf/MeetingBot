import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KnowledgeStore, MAX_DOCUMENT_CHARS } from '../electron/knowledge';
import { KnowledgeIndex, chunkDocument, type KnowledgeDocument } from '../electron/knowledgeSearch';
import { buildAnswerMessages, buildVisionMessages, buildStablePrefix, buildPrewarmMessages } from '../electron/llm/prompts';

const dirs: string[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), 'mc-knowledge-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const doc = (id: string, text: string): KnowledgeDocument => ({ id, name: `${id}.md`, text, createdAt: 1 });
const filler = () => Array.from({ length: 8 }, (_, i) => doc(`旅行-${i}`, '徒步旅行，欣赏山川景色。'.repeat(120)));

describe('personal knowledge persistence', () => {
  it('keeps multiple documents across restarts and deduplicates identical imports', () => {
    const path = join(temporary(), 'knowledge.json');
    const store = new KnowledgeStore(path);
    store.add('项目.md', '我负责订单系统，使用 Redis 缓存。');
    store.add('流程.txt', '发布流程：先灰度，再全量。');
    store.add('项目.md', '我负责订单系统，使用 Redis 缓存。');
    expect(new KnowledgeStore(path).summary().documents).toHaveLength(2);
    const id = store.summary().documents[0].id;
    store.remove(id);
    expect(new KnowledgeStore(path).retrieve('发布流程').sources.map((s) => s.documentName)).toEqual(['流程.txt']);
  });

  it('migrates the old global file once without changing or resurrecting it after clear', () => {
    const dir = temporary();
    const legacy = join(dir, 'knowledge.md');
    const path = join(dir, 'knowledge.json');
    writeFileSync(legacy, '旧版个人资料', 'utf8');
    const store = new KnowledgeStore(path, legacy);
    expect(store.retrieve('个人资料').sources[0].text).toBe('旧版个人资料');
    expect(readFileSync(legacy, 'utf8')).toBe('旧版个人资料');
    store.clear();
    expect(new KnowledgeStore(path, legacy).summary().documents).toEqual([]);
  });

  it('rejects empty or oversized documents without losing previous data', () => {
    const path = join(temporary(), 'knowledge.json');
    const store = new KnowledgeStore(path);
    store.add('有效.md', '现有资料');
    expect(() => store.add('扫描.pdf', ' ')).toThrow('NO_TEXT');
    expect(() => store.add('大文件.txt', '字'.repeat(MAX_DOCUMENT_CHARS + 1))).toThrow('TOO_LARGE');
    expect(new KnowledgeStore(path).summary().documents).toHaveLength(1);
  });

  it('does not silently overwrite a damaged library', () => {
    const path = join(temporary(), 'knowledge.json');
    writeFileSync(path, '{broken');
    const store = new KnowledgeStore(path);
    expect(store.summary().error).toBe('READ_FAILED');
    expect(store.retrieve('问题').error).toBe('READ_FAILED');
    expect(() => store.add('新资料', '不能覆盖旧文件')).toThrow('LIBRARY_UNREADABLE');
    expect(() => store.clear()).toThrow('LIBRARY_UNREADABLE');
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});

describe('local retrieval', () => {
  it('retrieves Chinese content near the end of a long document rather than clipping its head', () => {
    const index = new KnowledgeIndex([...filler(), doc('项目', '行政制度及日常办公。'.repeat(1000) + '\n\n订单系统使用 Redis 缓存，采用延迟双删保障一致性。')]);
    const results = index.search('订单系统如何保证缓存一致性？');
    expect(results[0].text).toContain('延迟双删');
    expect(results.reduce((n, s) => n + s.text.length, 0)).toBeLessThanOrEqual(6000);
    expect(results.length).toBeLessThanOrEqual(6);
  });

  it('matches English terms case-insensitively and returns no unrelated passages for a large library', () => {
    const index = new KnowledgeIndex([...filler(), doc('architecture', 'PostgreSQL replication uses streaming WAL records.')]);
    expect(index.search('How does POSTGRESQL replication work?')[0].documentId).toBe('architecture');
    expect(index.search('quantum entanglement')).toEqual([]);
    expect(index.search('')).toEqual([]);
  });

  it('includes a small library whole to let the model handle paraphrases', () => {
    const index = new KnowledgeIndex([doc('方案', '高峰期采用令牌桶保护接口。')]);
    expect(index.search('如何防止服务被压垮？')[0].text).toContain('令牌桶');
  });

  it('overlaps chunks so boundary details survive', () => {
    const chunks = chunkDocument(doc('long', 'x'.repeat(2100)));
    expect(chunks.length).toBe(3);
    expect(chunks[0].text.slice(-120)).toBe(chunks[1].text.slice(0, 120));
    expect(chunks.every((s) => s.text.length <= 1000)).toBe(true);
  });
});

describe('knowledge-first answering', () => {
  const knowledge = { documentCount: 1, sources: [{ documentId: 'p', documentName: '项目.md', chunkIndex: 0, text: '项目采用 Redis，并未使用 Kafka。' }] };

  it.each(['segment', 'continuous', 'free'] as const)('includes library alongside resume/JD in %s answers', (mode) => {
    const messages = buildAnswerMessages({ mode, question: '缓存怎么做？', freeQuestion: '缓存怎么做？', recentTranscript: [], resume: '我负责订单服务。', jd: '要求掌握消息队列。', knowledge });
    const all = JSON.stringify(messages);
    expect(all).toContain('项目采用 Redis');
    expect(all).toContain('我负责订单服务');
    expect(all).toContain('要求掌握消息队列');
    expect(all).toContain('资料未覆盖时才自由发挥');
    expect(all).toContain('岗位JD只描述岗位要求');
    expect(all).toContain('不执行');
  });

  it('retains fallback and unknown-personal-fact rules even with no retrieved passages', () => {
    const messages = buildAnswerMessages({ mode: 'free', freeQuestion: '我做过什么？', recentTranscript: [], knowledge: { documentCount: 9, sources: [] } });
    expect(JSON.stringify(messages)).toContain('对个人事实应说明未知');
    expect(JSON.stringify(messages)).toContain('未检索到相关段落不代表整个知识库都没有');
  });

  it('grounds screenshot answers but leaves translation faithful to the input', () => {
    expect(JSON.stringify(buildVisionMessages('分析架构', 'data:image/png;base64,AAA', '简历', knowledge))).toContain('项目采用 Redis');
    const translated = buildAnswerMessages({ mode: 'translate', question: 'Hello', recentTranscript: [], knowledge });
    expect(JSON.stringify(translated)).not.toContain('项目采用 Redis');
    expect(translated.at(-1)?.content).toBe('Hello');
  });

  it('keeps dynamic passages outside the prewarmed stable prefix', () => {
    const messages = buildAnswerMessages({ mode: 'segment', question: 'q', recentTranscript: [], resume: '简历', knowledge });
    expect(messages[0].content).toBe(buildStablePrefix('简历', '', 'chinese'));
    expect(buildPrewarmMessages(String(messages[0].content))[0]).toEqual(messages[0]);
    expect(messages[1].content).toContain('项目采用 Redis');
  });

  it('distinguishes an unreadable library from an ordinary search miss', () => {
    const messages = buildAnswerMessages({ mode: 'free', recentTranscript: [], knowledge: { documentCount: 0, sources: [], error: 'READ_FAILED' } });
    expect(JSON.stringify(messages)).toContain('知识库读取失败');
    expect(JSON.stringify(messages)).toContain('不得声称知识库没有相关信息');
  });
});

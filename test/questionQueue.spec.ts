import { describe, expect, it } from 'vitest';
import type { StoredSession } from '../shared/protocol';
import { claimQuestion, clearQuestionTranscript, collectQuestionSegment, hasPendingAnswer, loadQuestionSession, questionText, restoreQuestion } from '../shared/questionQueue';
import { nextSegmentId } from '../shared/transcript';
import { buildAnswerMessages } from '../electron/llm/prompts';

const empty = (): StoredSession => ({ id: 'a', name: 'Interview', createdAt: 1, turns: [], segments: [], questionQueueVersion: 1 });
let seq = 0;
function hear(s: StoredSession, text: string, startTs = 0, speaker: 'them' | 'me' = 'them') {
  return collectQuestionSegment(s, { id: nextSegmentId(s.segments ?? []), text, speaker, startTs, endTs: startTs + 100 }, `chunk-${++seq}`);
}

describe('manually confirmed question queue', () => {
  it('marks interrupted free and screenshot answers as errors when recovering the interface', () => {
    const s: StoredSession = { ...empty(), turns: [
      { id: 'free', kind: 'free', label: 'test', text: 'partial', status: 'streaming' },
      { id: 'shot', kind: 'vision', label: 'test', text: '', status: 'streaming' },
    ] };
    const recovered = loadQuestionSession(s, 'Interrupted');
    expect(recovered.turns.map(t => t.status)).toEqual(['error', 'error']);
    expect(recovered.turns[0].text).toBe('partial');
    expect(loadQuestionSession(recovered, 'Interrupted')).toEqual(recovered);
  });
  it('also interrupts unfinished answers when migrating a legacy session', () => {
    const s: StoredSession = { ...empty(), questionQueueVersion: undefined, turns: [
      { id: 'old', kind: 'free', label: 'test', text: 'saved partial', status: 'streaming' },
    ] };
    const recovered = loadQuestionSession(s, 'Interrupted');
    expect(recovered.turns[0]).toMatchObject({ status: 'error', text: 'saved partial', error: 'Interrupted' });
  });
  it('combines all interviewer fragments regardless of silence or question marks', () => {
    let s = hear(empty(), '先介绍项目');
    s = hear(s, '然后讲一下难点', 60_000);
    s = hear(s, '尤其是并发处理', 120_000);
    expect(s.segments).toHaveLength(3);
    expect(questionText(s)).toBe('先介绍项目\n然后讲一下难点\n尤其是并发处理');
    expect(s.turns).toHaveLength(0);
    const claimed = claimQuestion(s, 'q1')!;
    expect(claimed.turns[0].label).toBe(questionText(s));
    expect(questionText(claimed)).toBe('');
  });

  it('excludes my microphone and empty final segments', () => {
    let s = hear(empty(), '对方的问题');
    s = hear(s, '我的回答', 1000, 'me');
    s = hear(s, '  ', 2000);
    expect(questionText(s)).toBe('对方的问题');
    expect(s.pendingQuestion).toHaveLength(1);
    expect(s.segments).toHaveLength(2);
  });

  it('tracks raw fragments even when the transcript merges them into one bubble', () => {
    const s = hear(hear(empty(), '问题前半句'), '补充条件', 200);
    expect(s.segments).toHaveLength(1);
    expect(s.pendingQuestion).toHaveLength(2);
    expect(s.pendingQuestion!.map((c) => c.segmentId)).toEqual([1, 1]);
    expect(claimQuestion(s, 'q1')!.turns[0].label).toBe('问题前半句\n补充条件');
  });

  it('seals submitted bubbles and keeps arrivals during generation for the next question', () => {
    const claimed = claimQuestion(hear(empty(), '第一个问题'), 'q1')!;
    const next = hear(claimed, '下一轮问题', 200);
    expect(next.segments).toHaveLength(2);
    expect(next.segments![0].text).toBe('第一个问题');
    expect(questionText(next)).toBe('下一轮问题');
    expect(next.turns[0].label).toBe('第一个问题');
    expect(hasPendingAnswer(next)).toBe(true);
    expect(claimQuestion(next, 'double-click')).toBeNull();
    const done = { ...next, turns: next.turns.map((t) => ({ ...t, status: 'done' as const })) };
    expect(claimQuestion(done, 'q2')!.turns[1].label).toBe('下一轮问题');
  });

  it('cannot submit an empty queue', () => {
    expect(claimQuestion(empty(), 'q')).toBeNull();
  });

  it('ignores stale errors after a successful answer', () => {
    const s = claimQuestion(hear(empty(), '已经回答的问题'), 'q1')!;
    const done: StoredSession = { ...s, turns: s.turns.map((t) => ({ ...t, status: 'done' })) };
    expect(restoreQuestion(done, 'q1', 'Late error')).toBe(done);
    expect(questionText(done)).toBe('');
  });

  it('restores failed or cancelled speech once, before speech collected while answering', () => {
    const claimed = claimQuestion(hear(hear(empty(), '问题'), '条件', 200), 'q1')!;
    const next = hear(claimed, '新补充', 400);
    const restored = restoreQuestion(next, 'q1', 'Network error');
    expect(questionText(restored)).toBe('问题\n条件\n新补充');
    expect(restored.turns[0].status).toBe('error');
    expect(hasPendingAnswer(restored)).toBe(false);
    expect(restoreQuestion(restored, 'q1', 'Duplicate error')).toBe(restored);
    expect(claimQuestion(restored, 'retry')!.turns[1].label).toBe(questionText(restored));
  });

  it('does not resurrect explicitly cleared speech or reused segment IDs after an error', () => {
    const claimed = claimQuestion(hear(empty(), '已清空的问题'), 'q1')!;
    const cleared = clearQuestionTranscript(claimed);
    const next = hear(cleared, '清空后新问题');
    expect(next.segments![0].id).toBe(1);
    const restored = restoreQuestion(next, 'q1', 'Stopped');
    expect(questionText(restored)).toBe('清空后新问题');
    expect(restored.segments![0].questionBoundary).toBeUndefined();
  });

  it('restores interrupted batches on restart while preserving stable IDs and new pending speech', () => {
    const claimed = claimQuestion(hear(empty(), '未完成的问题'), 'q1')!;
    const before = hear(claimed, '接着说的话', 200);
    const reloaded = loadQuestionSession(JSON.parse(JSON.stringify(before)), 'Interrupted');
    expect(questionText(reloaded)).toBe('未完成的问题\n接着说的话');
    expect(reloaded.segments!.map((s) => s.id)).toEqual([1, 2]);
    expect(hasPendingAnswer(reloaded)).toBe(false);
    expect(loadQuestionSession(reloaded, 'Interrupted')).toEqual(reloaded);
  });

  it('keeps a saved pending queue after restart', () => {
    const s = hear(empty(), '待确认的问题');
    expect(loadQuestionSession(JSON.parse(JSON.stringify(s)), 'Interrupted')).toEqual(s);
  });

  it('keeps legacy history without queueing all historical questions', () => {
    const old = { ...hear(empty(), '旧版本转录'), questionQueueVersion: undefined };
    const migrated = loadQuestionSession(old, 'Interrupted');
    expect(questionText(migrated)).toBe('');
    expect(migrated.segments![0].text).toBe('旧版本转录');
    const next = hear(migrated, '新问题', 200);
    expect(questionText(next)).toBe('新问题');
    expect(next.segments).toHaveLength(2);
  });

  it('does not truncate pending speech when transcript display reaches its 500-bubble limit', () => {
    let s = empty();
    for (let i = 0; i < 505; i++) s = hear(s, `第${i}句`, i * 60_000);
    expect(s.segments).toHaveLength(500);
    expect(s.pendingQuestion).toHaveLength(505);
    expect(claimQuestion(s, 'q1')!.turns[0].label).toBe(Array.from({ length: 505 }, (_, i) => `第${i}句`).join('\n'));
  });

  it('keeps session queues independent', () => {
    const a = hear(empty(), 'A的问题');
    const b = hear({ ...empty(), id: 'b' }, 'B的问题');
    claimQuestion(a, 'q1');
    expect(questionText(b)).toBe('B的问题');
    expect(questionText(a)).toBe('A的问题'); // pure operations leave previous state unchanged
  });

  it('one-off answers do not advance the pending question', () => {
    const s = hear(empty(), '完整问题');
    const oneOff: StoredSession = { ...s, turns: [{ id: 'single', kind: 'segment', label: '一句', text: '', status: 'streaming' }] };
    expect(hasPendingAnswer(oneOff)).toBe(false);
    expect(restoreQuestion(oneOff, 'single', 'Failed').pendingQuestion).toEqual(s.pendingQuestion);
    expect(claimQuestion(oneOff, 'q1')!.turns[1].label).toBe('完整问题');
  });

  it('sends the complete confirmed question even if recent transcript context is truncated', () => {
    const question = ['第一段：' + '问题'.repeat(1700), '第二段：补充限制条件', '第三段：给出代码'].join('\n');
    const messages = buildAnswerMessages({ mode: 'continuous', question, recentTranscript: Array(50).fill('旧背景'.repeat(100)) });
    const content = messages.at(-1)!.content;
    expect(content).toContain(question);
    expect(content).toContain('不要只回答最后一句');
  });
});

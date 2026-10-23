import type { StoredSession } from './protocol';
import { appendSegment, reindexSegments, type TranscriptSegment } from './transcript';

export function questionText(session: StoredSession): string {
  return (session.pendingQuestion ?? []).map((c) => c.text).join('\n');
}

/** Start a new selected range without deleting the original transcript. */
export function beginQuestionRange(session: StoredSession): StoredSession {
  return { ...session, pendingQuestion: [], questionEpoch: (session.questionEpoch ?? 0) + 1 };
}

export function hasPendingAnswer(session: StoredSession): boolean {
  return session.turns.some((t) => t.status === 'streaming' && !!t.questionBatch);
}

export function collectQuestionSegment(session: StoredSession, segment: TranscriptSegment, chunkId: string): StoredSession {
  const segments = appendSegment(session.segments ?? [], segment);
  const text = segment.text.trim();
  const pendingQuestion = text && (segment.speaker ?? 'them') === 'them'
    ? [...(session.pendingQuestion ?? []), { id: chunkId, segmentId: segments.at(-1)!.id, text }]
    : session.pendingQuestion ?? [];
  return { ...session, segments, pendingQuestion, questionQueueVersion: 1 };
}

/** Consume an exact snapshot before requesting an answer. Later arrivals remain queued. */
export function claimQuestion(session: StoredSession, requestId: string, maxTurns = 200): StoredSession | null {
  if (hasPendingAnswer(session) || !session.pendingQuestion?.length) return null;
  const chunks = session.pendingQuestion;
  const ids = new Set(chunks.map((c) => c.segmentId));
  return {
    ...session,
    pendingQuestion: [],
    segments: session.segments?.map((s) => ids.has(s.id) ? { ...s, questionBoundary: true } : s),
    turns: [...session.turns, {
      id: requestId, kind: 'continuous' as const, label: questionText(session), text: '', status: 'streaming' as const,
      questionBatch: { chunks, epoch: session.questionEpoch ?? 0 },
    }].slice(-maxTurns),
  };
}

/** Return a failed/cancelled batch once, before new speech, unless explicitly cleared. */
export function restoreQuestion(session: StoredSession, requestId: string, message: string): StoredSession {
  const turn = session.turns.find((t) => t.id === requestId);
  if (!turn || turn.status !== 'streaming' || turn.questionBatch?.restored) return session;
  const batch = turn.questionBatch;
  const restore = batch && batch.epoch === (session.questionEpoch ?? 0);
  const chunks = restore ? batch.chunks : [];
  const ids = new Set(chunks.map((c) => c.segmentId));
  const seen = new Set<string>();
  return {
    ...session,
    pendingQuestion: [...chunks, ...(session.pendingQuestion ?? [])].filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    }),
    segments: session.segments?.map((s) => ids.has(s.id) ? { ...s, questionBoundary: false } : s),
    turns: session.turns.map((t) => t.id === requestId ? {
      ...t, status: 'error', error: message,
      ...(batch ? { questionBatch: { ...batch, restored: true } } : {}),
    } : t),
  };
}

export function clearQuestionTranscript(session: StoredSession): StoredSession {
  return { ...session, segments: [], pendingQuestion: [], questionEpoch: (session.questionEpoch ?? 0) + 1, questionQueueVersion: 1 };
}

export function loadQuestionSession(session: StoredSession, interruptedMessage: string): StoredSession {
  let next = session;
  if (session.questionQueueVersion !== 1) {
    // No reliable cursor exists in old sessions. Keep their text, start collecting new speech.
    next = { ...session, segments: reindexSegments(session.segments ?? []).map((s) => ({ ...s, questionBoundary: true })), pendingQuestion: [], questionQueueVersion: 1, questionEpoch: 0 };
  }
  for (const turn of next.turns) {
    if (turn.status !== 'streaming') continue;
    if (turn.questionBatch && session.questionQueueVersion === 1) next = restoreQuestion(next, turn.id, interruptedMessage);
    else next = { ...next, turns: next.turns.map(t => t.id === turn.id ? { ...t, status: 'error', error: interruptedMessage } : t) };
  }
  return next;
}

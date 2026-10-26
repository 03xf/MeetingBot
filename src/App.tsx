import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AsrEvent,
  KbSlot,
  LlmAskPayload,
  PublicSettings,
  StoredSession,
  WindowInteractionMode,
} from '../shared/protocol';
import {
  nextSegmentId,
  percentile,
  type TranscriptSegment,
} from '../shared/transcript';
import {
  beginQuestionRange,
  claimQuestion,
  clearQuestionTranscript,
  collectQuestionSegment,
  hasPendingAnswer,
  loadQuestionSession,
  questionText,
  restoreQuestion,
} from '../shared/questionQueue';
import { captureKindForPlatform } from '../shared/platform';
import { backgroundOpacity } from '../shared/appearance';
import { deriveServiceHealth } from '../shared/healthState';
import { LoopbackCapture } from './audio/loopbackCapture';
import { MicCapture, listMics } from './audio/micCapture';
import { TranscriptPanel } from './components/TranscriptPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ServiceHealthPanel } from './components/ServiceHealthPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HelpPanel } from './components/HelpPanel';
import { KnowledgePanel } from './components/KnowledgePanel';
import { StatusBar } from './components/StatusBar';
import { ResizablePanes } from './components/ResizablePanes';
import { AnswerSession, type AnswerTurn } from './components/AnswerSession';
import { I18nProvider, getDict, type Dict } from './i18n';

export interface AsrUiState {
  phase: 'loading' | 'ready' | 'error';
  ep?: string;
  gpuSuspect?: boolean;
  workerState: 'loading' | 'listening' | 'speech' | 'transcribing' | 'stopped';
  lastError?: string;
}

export interface HudStats {
  lastE2eMs?: number;
  lastInferMs?: number;
  p50?: number;
  p95?: number;
  count: number;
}

const MAX_TURNS = 200;
// v2: only the last 8 turns ride along verbatim — the rolling memo carries
// older context, keeping per-request tokens flat as the interview runs long
const HISTORY_TURNS = 8;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}-${Date.now()}`;

function newSession(name: string): StoredSession {
  return { id: uid('s'), name, createdAt: Date.now(), turns: [], segments: [], pendingQuestion: [], questionQueueVersion: 1 };
}

/** legacy single-slot KB → resume slot (dual-slot material, P0-2) */
function migrateKbSlots(s: StoredSession, fallbackName: string): StoredSession {
  if (!s.kbText || s.resumeText) return s;
  const { kbName, kbText, ...rest } = s;
  return { ...rest, resumeName: kbName ?? fallbackName, resumeText: kbText };
}

/** first-question topic → a short session title */
function deriveName(text: string, fallback: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 14 ? t.slice(0, 14) + '…' : t;
}

interface QuestionRange {
  sid: string;
  epoch: number;
  startId: string;
  endId?: string;
  startDone: boolean;
  endMarker?: Promise<void>;
  cancelled?: boolean;
}

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const savePaneRatio = useCallback((value: number) => {
    setSettings(s => s ? { ...s, ui: { ...s.ui, transcriptRatio: value } } : s);
    void window.mc.setSettings({ ui: { transcriptRatio: value } }).catch(() => {
      setWindowNotice('宽度已调整，但未能保存；重新启动后可能恢复原来的比例。');
    });
  }, []);
  const [asr, setAsr] = useState<AsrUiState>({ phase: 'loading', workerState: 'loading' });
  const [capturing, setCapturing] = useState(false);
  const [captureStarting, setCaptureStarting] = useState(false);
  const captureStartingRef = useRef(false);
  const [rangeStage, setRangeStage] = useState<'recording' | 'finishing' | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [windowNotice, setWindowNotice] = useState<string | null>(null);
  const [hotkeyFailures, setHotkeyFailures] = useState<string[]>([]);
  const [windowMode, setWindowMode] = useState<WindowInteractionMode>(window.mc.platform === 'win32' ? 'browse' : 'edit');
  const modeEpochRef = useRef(0);
  const requestEdit = useCallback(async () => {
    const epoch = modeEpochRef.current;
    const mode = await window.mc.getWindowMode();
    if (mode === 'browse' || epoch !== modeEpochRef.current) {
      setWindowNotice(tRef.current.titlebar.editLocked);
      return false;
    }
    return true;
  }, []);
  const finishEdit = useCallback(async () => {
    if (window.mc.platform !== 'win32') return;
    const mode = await window.mc.setWindowMode('browse');
    setWindowMode(mode);
  }, []);
  useEffect(() => {
    const off = window.mc.onWindowModeChanged((mode) => { modeEpochRef.current++; setWindowMode(mode); });
    const offBlocked = window.mc.onInteractionBlocked(() => setWindowNotice(tRef.current.titlebar.editLocked));
    void window.mc.getWindowMode().then(setWindowMode);
    void window.mc.getRecoveryNotice().then(setWindowNotice);
    return () => { off(); offBlocked(); };
  }, []);
  useEffect(() => {
    let changed = false;
    const off = window.mc.onHotkeyFailures((keys) => { changed = true; setHotkeyFailures(keys); });
    void window.mc.getHotkeyFailures().then((keys) => { if (!changed) setHotkeyFailures(keys); });
    return off;
  }, []);
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null);
  const [showHealth, setShowHealth] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  useEffect(() => {
    if (windowMode === 'browse') setShowSettings(false);
  }, [windowMode]);
  const [showHud, setShowHud] = useState(true);
  const [hud, setHud] = useState<HudStats>({ count: 0 });
  const [waitingConfirmation, setWaitingConfirmation] = useState<string | null>(null);
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([]);
  const [partials, setPartials] = useState<{ them?: string; me?: string }>({});
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [kbNotice, setKbNotice] = useState<string | null>(null);

  const loopbackRef = useRef<LoopbackCapture | null>(null);
  const themInputRef = useRef<MicCapture | null>(null);
  const settingsRef = useRef<PublicSettings | null>(null);
  const e2eSamples = useRef<number[]>([]);
  const sessionsRef = useRef<StoredSession[]>([]);
  const currentIdRef = useRef<string>('');
  const loaded = useRef(false);
  const partialsRef = useRef<{ them?: string; me?: string }>({});
  const waitingRef = useRef<string | null>(null);
  const cutRef = useRef<{ requestId: string; sid: string; epoch: number } | null>(null);
  const rangeRef = useRef<QuestionRange | null>(null);
  const submitQuestionRef = useRef<(rangeOnly?: boolean) => void>(() => {});

  // The interface and default answer language are fixed to Chinese.
  const t = getDict('zh');
  const tRef = useRef<Dict>(t);
  tRef.current = t;

  if (!loopbackRef.current) loopbackRef.current = new LoopbackCapture();
  if (!themInputRef.current) themInputRef.current = new MicCapture();
  settingsRef.current = settings;
  currentIdRef.current = currentId;

  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? null,
    [sessions, currentId],
  );
  const segments = current?.segments ?? [];

  // Publish to the ref before React renders: ASR events and rapid confirmation
  // clicks must observe the same queue snapshot, even within one event loop turn.
  const updateSessions = useCallback((fn: (list: StoredSession[]) => StoredSession[]) => {
    const next = fn(sessionsRef.current);
    sessionsRef.current = next;
    setSessions(next);
  }, []);
  const patchSession = useCallback((id: string, fn: (s: StoredSession) => StoredSession) => {
    updateSessions((list) => list.map((s) => (s.id === id ? fn(s) : s)));
  }, [updateSessions]);
  const waitForFinal = useCallback((sid: string | null) => {
    waitingRef.current = sid;
    setWaitingConfirmation(sid);
  }, []);

  const cancelRange = useCallback(async () => {
    const range = rangeRef.current;
    if (!range) return;
    range.cancelled = true;
    setRangeStage(null);
    waitForFinal(null);
    // Seal cancelled audio too. Keep routing its late finals to its original
    // session until the ordered marker drains; never submit it automatically.
    if (!range.endId) {
      range.endId = uid('range-cancel');
      const cap = captureKindForPlatform(window.mc.platform) === 'input' ? themInputRef.current! : loopbackRef.current!;
      range.endMarker = cap.cut(range.endId, () => window.mc.asrCut(range.endId!));
    }
    try { await range.endMarker; }
    catch (error) {
      if (rangeRef.current === range) {
        rangeRef.current = null;
        setAsr((state) => ({ ...state, lastError: tRef.current.question.cutFailed(String(error)) }));
      }
    }
  }, [waitForFinal]);
  const failRange = useCallback((range: QuestionRange, error: unknown) => {
    if (rangeRef.current !== range) return;
    rangeRef.current = null;
    setRangeStage(null);
    waitForFinal(null);
    setAsr((state) => ({ ...state, lastError: tRef.current.question.cutFailed(String(error)) }));
  }, [waitForFinal]);

  const appendTurn = useCallback(
    (sessionId: string, turn: AnswerTurn) => {
      patchSession(sessionId, (s) => {
        const turns = [...s.turns, turn];
        return { ...s, turns: turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns };
      });
    },
    [patchSession],
  );

  const buildHistory = useCallback((): { role: 'user' | 'assistant'; content: string }[] => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    if (!s) return [];
    const done = s.turns.filter((t) => t.status === 'done' && t.kind !== 'translate').slice(-HISTORY_TURNS);
    return done.flatMap((t) => [
      { role: 'user' as const, content: t.label },
      { role: 'assistant' as const, content: t.text },
    ]);
  }, []);

  /** current session's dual-slot material (resume / JD / rolling memo) */
  const currentMaterial = useCallback((): { resume?: string; jd?: string; memo?: string } => {
    const s = sessionsRef.current.find((x) => x.id === currentIdRef.current);
    return {
      resume: s?.resumeText || undefined,
      jd: s?.jdText || undefined,
      memo: s?.memo || undefined,
    };
  }, []);

  /** P1-6: ask main to warm the DeepSeek prefix cache for the current material */
  const prewarm = useCallback(
    (immediate: boolean) => {
      const m = currentMaterial();
      window.mc.prewarm({ resume: m.resume, jd: m.jd, immediate });
    },
    [currentMaterial],
  );

  // P1-5: rolling memo — fold each finished Q&A in asynchronously, one update
  // at a time per session (promise chain), never on the answer critical path
  const memoChain = useRef(new Map<string, Promise<void>>());
  const enqueueMemoUpdate = useCallback(
    (sid: string, question: string, answer: string) => {
      if (!question.trim() || !answer.trim()) return;
      const prev = memoChain.current.get(sid) ?? Promise.resolve();
      const next = prev
        .then(async () => {
          const old = sessionsRef.current.find((x) => x.id === sid)?.memo ?? '';
          const memo = await window.mc.memoUpdate({ memo: old, question, answer });
          if (memo) patchSession(sid, (s) => ({ ...s, memo }));
        })
        .catch(() => {});
      memoChain.current.set(sid, next);
    },
    [patchSession],
  );

  /** auto-name a session from its first real question (once) */
  const maybeTitle = useCallback(
    (sid: string, text?: string) => {
      if (!text?.trim()) return;
      patchSession(sid, (s) =>
        s.titled ? s : { ...s, name: deriveName(text, tRef.current.app.newSession), titled: true },
      );
    },
    [patchSession],
  );

  const askLlm = useCallback(
    (mode: 'segment' | 'continuous' | 'free' | 'translate', text?: string, rangeOnly = false) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const requestId = uid('req');
      const session = sessionsRef.current.find((x) => x.id === sid);
      if (!session) return;
      const segs = session.segments ?? [];
      const question = mode === 'continuous' ? questionText(session) : text;
      if (mode === 'continuous') {
        const claimed = claimQuestion(session, requestId, MAX_TURNS);
        if (!claimed) return;
        patchSession(sid, () => claimed);
      } else {
        appendTurn(sid, { id: requestId, kind: mode, label: question ?? '', text: '', status: 'streaming' });
      }
      if (mode !== 'translate') maybeTitle(sid, question);
      const material = mode === 'translate' ? {} : currentMaterial();
      const payload: LlmAskPayload = {
        requestId,
        mode,
        question: mode === 'free' ? undefined : question,
        freeQuestion: mode === 'free' ? text : undefined,
        recentTranscript: rangeOnly ? (session.pendingQuestion ?? []).map((c) => c.text) : segs.slice(-30).map((s) => s.text),
        answerLang: 'chinese',
        history: mode === 'translate' ? undefined : buildHistory(),
        ...material,
      };
      try { window.mc.llmAsk(payload); } catch (e) {
        patchSession(sid, (s) => restoreQuestion(s, requestId, String(e)));
      }
    },
    [appendTurn, buildHistory, currentMaterial, maybeTitle, patchSession],
  );

  const askShot = useCallback(
    (question: string, imageDataUrl?: string) => {
      const sid = currentIdRef.current;
      if (!sid) return;
      const requestId = uid('shot');
      appendTurn(sid, {
        id: requestId,
        kind: 'vision',
        label: question || tRef.current.app.readShot,
        text: '',
        status: 'streaming',
      });
      maybeTitle(sid, question || tRef.current.app.shotQuestion);
      const m = currentMaterial();
      const background = [m.resume, m.jd].filter(Boolean).join('\n\n') || undefined;
      window.mc.shotAsk({ requestId, question, background, imageDataUrl });
    },
    [appendTurn, currentMaterial, maybeTitle],
  );
  submitQuestionRef.current = (rangeOnly) => askLlm('continuous', undefined, rangeOnly);

  /** region screenshot flow (📷 button or hotkey): drag a region, then ask */
  const doRegionShot = useCallback(async () => {
    const vision = settingsRef.current?.vision;
    if (!vision?.baseUrl || !vision.model || !vision.apiKeySet) {
      setWindowNotice(tRef.current.answer.shotSetup);
      return;
    }
    try {
      setWindowNotice((notice) => notice === tRef.current.answer.shotSetup || notice === tRef.current.answer.shotFailed ? null : notice);
      const img = await window.mc.pickRegion();
      if (img) askShot('', img);
    } catch { setWindowNotice(tRef.current.answer.shotFailed); }
  }, [askShot]);

  // ---- boot: load settings + sessions ----
  useEffect(() => {
    void window.mc.getSettings().then((s) => {
      setSettings(s);
    });
    void window.mc.loadSessions().then((f) => {
      if (f.sessions.length) {
        // heal legacy duplicate segment ids (worker counter used to reset per
        // engine rebuild — translations then landed on multiple bubbles)
        updateSessions(() => f.sessions.map((s) => migrateKbSlots(
          loadQuestionSession(s, tRef.current.question.interrupted), tRef.current.app.legacyKbName,
        )));
        setCurrentId(f.currentId && f.sessions.some((s) => s.id === f.currentId) ? f.currentId : f.sessions[0].id);
      } else {
        const s = newSession(tRef.current.app.sessionN(1));
        updateSessions(() => [s]);
        setCurrentId(s.id);
      }
      loaded.current = true;
    });

    const handleAsrEvent = (ev: AsrEvent) => {
      if (ev.kind === 'cut') {
        const range = rangeRef.current;
        if (range && (ev.requestId === range.startId || ev.requestId === range.endId)) {
          partialsRef.current = { ...partialsRef.current, them: undefined };
          setPartials(partialsRef.current);
          const session = sessionsRef.current.find((s) => s.id === range.sid);
          const valid = !range.cancelled && session && currentIdRef.current === range.sid &&
            (session.questionEpoch ?? 0) === range.epoch;
          if (ev.error) {
            range.cancelled = true;
            setAsr((state) => ({ ...state, lastError: tRef.current.question.cutFailed(ev.error!) }));
          }
          if (ev.requestId === range.startId) {
            range.startDone = true;
            if (valid && !ev.error) {
              const next = beginQuestionRange(session);
              range.epoch = next.questionEpoch!;
              patchSession(range.sid, () => next);
            } else {
              range.cancelled = true;
              setRangeStage(null);
              waitForFinal(null);
              if (!range.endId) rangeRef.current = null;
            }
          } else {
            rangeRef.current = null;
            setRangeStage(null);
            waitForFinal(null);
            if (valid && !ev.error) {
              if (session.pendingQuestion?.length) submitQuestionRef.current(true);
              else setWindowNotice(tRef.current.question.rangeEmpty);
            }
          }
          return;
        }
        const cut = cutRef.current;
        if (!cut || cut.requestId !== ev.requestId) return;
        cutRef.current = null;
        partialsRef.current = { ...partialsRef.current, them: undefined };
        setPartials(partialsRef.current);
        const session = sessionsRef.current.find((s) => s.id === cut.sid);
        const shouldSubmit = waitingRef.current === cut.sid && currentIdRef.current === cut.sid &&
          !!session && (session.questionEpoch ?? 0) === cut.epoch;
        waitForFinal(null);
        if (ev.error) {
          setAsr((s) => ({ ...s, lastError: tRef.current.question.cutFailed(ev.error!) }));
          return;
        }
        // The worker emits this before releasing any post-cut audio results.
        if (shouldSubmit) submitQuestionRef.current();
      } else if (ev.kind === 'ready') {
        setAsr((s) => ({ ...s, phase: 'ready', ep: ev.ep, gpuSuspect: ev.gpuSuspect, workerState: 'listening' }));
      } else if (ev.kind === 'status') {
        setAsr((s) => ({ ...s, workerState: ev.state }));
      } else if (ev.kind === 'error') {
        setAsr((s) => ({ ...s, phase: ev.fatal ? 'error' : s.phase, lastError: ev.message }));
        waitForFinal(null);
        cancelRange();
      } else if (ev.kind === 'partial') {
        partialsRef.current = { ...partialsRef.current, [ev.speaker]: ev.text };
        setPartials(partialsRef.current);
      } else if (ev.kind === 'segment') {
        partialsRef.current = { ...partialsRef.current, [ev.speaker]: undefined };
        setPartials(partialsRef.current);
        const e2eMs = Date.now() - ev.timings.speechEndTs;
        const inferMs = ev.timings.inferEndTs - ev.timings.inferStartTs;
        e2eSamples.current.push(e2eMs);
        if (e2eSamples.current.length > 200) e2eSamples.current.shift();
        setHud({
          lastE2eMs: e2eMs,
          lastInferMs: inferMs,
          p50: percentile(e2eSamples.current, 50),
          p95: percentile(e2eSamples.current, 95),
          count: e2eSamples.current.length,
        });
        const cut = ev.speaker === 'them' ? (rangeRef.current ?? cutRef.current) : null;
        const sid = cut?.sid ?? currentIdRef.current;
        updateSessions((list) =>
          list.map((s) =>
            s.id === sid && (!cut || (s.questionEpoch ?? 0) === cut.epoch)
              ? collectQuestionSegment(s, {
                    // NOT ev.id: the worker counter resets per engine rebuild,
                    // duplicating ids inside a persisted session
                    id: nextSegmentId(s.segments ?? []),
                    text: ev.text,
                    lang: ev.lang,
                    speaker: ev.speaker,
                    startTs: ev.timings.speechStartTs,
                    endTs: ev.timings.speechEndTs,
                    e2eMs,
                    inferMs,
                  }, uid('heard'))
              : s,
          ),
        );
      }
    };
    const off = window.mc.onAsrEvent(handleAsrEvent);
    // instant-ready cloud engines emit ready/status BEFORE this subscription
    // exists — pull the last ones so the UI never sticks at "模型加载中"
    void window.mc.asrReplay().then(({ ready, status }) => {
      if (ready) handleAsrEvent(ready);
      if (status) handleAsrEvent(status);
    });

    const offLlm = window.mc.onLlmEvent((ev) => {
      updateSessions((list) =>
        list.map((s) => {
          if (ev.kind === 'error') return restoreQuestion(s, ev.requestId, ev.message);
          const turn = s.turns.find((t) => t.id === ev.requestId);
          if (!turn || turn.status !== 'streaming') return s;
          if (ev.kind === 'done' && turn.questionBatch && !(ev.text || turn.text).trim()) {
            return restoreQuestion(s, ev.requestId, tRef.current.question.emptyAnswer);
          }
          return {
            ...s,
            turns: s.turns.map((t) => {
              if (t.id !== ev.requestId) return t;
              if (ev.kind === 'knowledge') return { ...t, knowledge: ev.knowledge };
              if (ev.kind === 'delta') return { ...t, text: t.text + ev.text };
              return { ...t, text: ev.text || t.text, status: 'done' };
            }),
          };
        }),
      );
      // fold finished ANSWER turns into the session memo (async, off-path);
      // translate/vision turns are not interview Q&A
      if (ev.kind === 'done') {
        const s = sessionsRef.current.find((x) => x.turns.some((t) => t.id === ev.requestId));
        const t = s?.turns.find((x) => x.id === ev.requestId);
        if (s && t?.status === 'done' && (t.kind === 'segment' || t.kind === 'continuous' || t.kind === 'free')) {
          enqueueMemoUpdate(s.id, t.label, ev.text || t.text);
        }
      }
    });

    const offShot = window.mc.onShotHotkey(() => void doRegionShot());

    window.__mcAutoStart = () => void startCapture();
    // visual-QA hooks (MC_MAIN_SHOT in electron/main.ts): open a panel from the
    // main process so it can be screenshotted
    window.__mcOpenSettings = () => { void requestEdit().then((allowed) => { if (allowed) setShowSettings(true); }); };
    window.__mcOpenHelp = () => setShowHelp(true);
    return () => {
      off();
      offLlm();
      offShot();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- persist sessions (debounced) ----
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => window.mc.saveSessions({ sessions, currentId }), 400);
    return () => clearTimeout(t);
  }, [sessions, currentId]);

  useEffect(() => {
    document.documentElement.style.setProperty('--background-opacity', String(backgroundOpacity(opacityPreview ?? settings?.ui.opacity)));
  }, [settings?.ui.opacity, opacityPreview]);

  // ---- apply UI theme + answer font scale to the document root ----
  useEffect(() => {
    const ui = settings?.ui;
    if (!ui) return;
    document.documentElement.dataset.fontScale = ui.fontScale ?? 'medium';
    const apply = () => {
      const mode = ui.theme ?? 'dark';
      const dark =
        mode === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if ((ui.theme ?? 'dark') !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  // auto-dismiss the KB parse notice
  useEffect(() => {
    if (!kbNotice) return;
    const t = setTimeout(() => setKbNotice(null), 8000);
    return () => clearTimeout(t);
  }, [kbNotice]);

  // switching sessions swaps the material → prefix dirty (reheats if capturing)
  useEffect(() => {
    if (!loaded.current || !currentId) return;
    prewarm(false);
  }, [currentId, prewarm]);

  // Windows: Electron system loopback. macOS/Linux: selected ordinary input
  // (typically a virtual audio device for meeting/system audio).
  const startCapture = useCallback(async () => {
    const inputMode = captureKindForPlatform(window.mc.platform) === 'input';
    const cap = inputMode ? themInputRef.current! : loopbackRef.current!;
    if (cap.running || captureStartingRef.current) return;
    captureStartingRef.current = true;
    setCaptureStarting(true);
    try {
      if (inputMode) {
        await themInputRef.current!.start(
          settingsRef.current?.audio.themDeviceId,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them'),
          { audioProcessing: false },
        );
        void listMics().then(setMics).catch(() => undefined);
      } else {
        await loopbackRef.current!.start((buf, ts) => window.mc.sendPcm(buf, ts, 'them'));
      }
      window.mc.captureStarted();
      setCapturing(true);
      setWindowNotice((notice) => notice === tRef.current.question.rangeNeedsCapture ? null : notice);
      prewarm(true); // ▶ = the meeting starts — build the KV prefix cache now
    } catch (e) {
      setAsr((s) => ({ ...s, lastError: tRef.current.app.captureStartFail((e as Error).message) }));
    } finally { captureStartingRef.current = false; setCaptureStarting(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCapture = useCallback(async () => {
    await cancelRange();
    const cap =
      captureKindForPlatform(window.mc.platform) === 'input'
        ? themInputRef.current!
        : loopbackRef.current!;
    await cap.stop();
    window.mc.captureStopped();
    setCapturing(false);
  }, [cancelRange]);

  const setSeg = useCallback(
    (segId: number, patch: Partial<TranscriptSegment>) => {
      const sid = currentIdRef.current;
      updateSessions((list) =>
        list.map((s) =>
          s.id === sid
            ? { ...s, segments: (s.segments ?? []).map((g) => (g.id === segId ? { ...g, ...patch } : g)) }
            : s,
        ),
      );
    },
    [updateSessions],
  );

  const translateSegment = useCallback(
    (seg: TranscriptSegment) => {
      if (seg.translating) return; // re-translating an already-translated bubble is allowed
      setSeg(seg.id, { translating: true });
      window.mc
        .translate(seg.text)
        .then((zh) => setSeg(seg.id, { translation: zh, translating: false }))
        .catch(() => setSeg(seg.id, { translation: tRef.current.app.translateFail, translating: false }));
    },
    [setSeg],
  );

  const toggleStealth = useCallback(async () => {
    if (!settings) return;
    const on = await window.mc.setStealth(!settings.ui.stealth);
    setSettings({ ...settings, ui: { ...settings.ui, stealth: on } });
  }, [settings]);

  const toggleAnswerModel = useCallback(async () => {
    if (!settings) return;
    const updated = await window.mc.setSettings({ llm: { answerWithVision: !settings.llm.answerWithVision } });
    setSettings(updated);
  }, [settings]);

  const selectThemInput = useCallback(async (deviceId: string) => {
    const updated = await window.mc.setSettings({ audio: { themDeviceId: deviceId || undefined } });
    setSettings(updated);
    settingsRef.current = updated;
    const input = themInputRef.current!;
    if (input.running) {
      await cancelRange();
      await input.stop();
      await input
        .start(
          deviceId || undefined,
          (buf, ts) => window.mc.sendPcm(buf, ts, 'them'),
          { audioProcessing: false },
        )
        .catch((e) => {
          window.mc.captureStopped();
          setCapturing(false);
          setAsr((s) => ({ ...s, lastError: tRef.current.app.themInputSwitchFail((e as Error).message) }));
        });
    }
  }, []);

  const clearTranscript = useCallback(() => {
    cancelRange();
    waitForFinal(null);
    patchSession(currentIdRef.current, clearQuestionTranscript);
  }, [patchSession, waitForFinal, cancelRange]);

  const cancelTurn = useCallback(
    (id: string) => {
      window.mc.llmCancel(id);
      patchSession(currentIdRef.current, (s) => s.turns.find((t) => t.id === id)?.questionBatch
        ? restoreQuestion(s, id, tRef.current.question.cancelled) : ({
        ...s,
        turns: s.turns.map((t) => (t.id === id ? { ...t, status: 'done' } : t)),
      }));
    },
    [patchSession],
  );

  const createSession = useCallback(() => {
    cancelRange();
    const s = newSession(tRef.current.app.sessionN(sessionsRef.current.length + 1));
    updateSessions((list) => [...list, s]);
    setCurrentId(s.id);
  }, [updateSessions, cancelRange]);

  const deleteSession = useCallback((id: string) => {
    cancelRange();
    updateSessions((list) => {
      const next = list.filter((s) => s.id !== id);
      if (next.length === 0) {
        const s = newSession(tRef.current.app.sessionN(1));
        setCurrentId(s.id);
        return [s];
      }
      setCurrentId((cur) => (cur === id ? next[0].id : cur));
      return next;
    });
  }, [updateSessions, cancelRange]);

  const clearAnswers = useCallback(() => {
    patchSession(currentIdRef.current, (s) => {
      let next = s;
      for (const turn of s.turns) {
        if (turn.status !== 'streaming') continue;
        window.mc.llmCancel(turn.id);
        if (turn.questionBatch) next = restoreQuestion(next, turn.id, tRef.current.question.cancelled);
      }
      return { ...next, turns: [] };
    });
  }, [patchSession]);

  const renameSession = useCallback(
    (id: string, name: string) => {
      patchSession(id, (s) => ({ ...s, name: name.trim() || s.name, titled: true }));
    },
    [patchSession],
  );

  /** the overlays are mutually exclusive: one panel at a time, never stacked */
  const closePanels = useCallback(() => {
    setShowKnowledge(false);
    setShowSettings(false);
    setShowHealth(false);
    setShowDiagnostics(false);
    setShowHelp(false);
  }, []);

  /**
   * Tray menu -> renderer (Phase 4 §A). Main only forwards what it cannot do
   * itself, and it has already made the window visible. 开始/停止转写
   * deliberately runs the SAME code path as the title-bar button, readiness
   * gate included, so the two can never disagree. Re-subscribed whenever that
   * state changes — cheaper and less error-prone than a fistful of refs.
   */
  useEffect(() => {
    return window.mc.onTrayCommand(({ command }) => {
      switch (command) {
        case 'toggle-capture':
          if (capturing) void stopCapture();
          else if (asr.phase === 'ready') void startCapture();
          return;
        case 'new-session':
          createSession();
          return;
        case 'open-settings':
          void requestEdit().then((allowed) => { if (allowed) { closePanels(); setShowSettings(true); } });
          return;
        case 'open-health':
          closePanels();
          setShowHealth(true);
          return;
        case 'open-help':
          closePanels();
          setShowHelp(true);
          return;
      }
    });
  }, [capturing, asr.phase, startCapture, stopCapture, createSession, closePanels]);

  const pickKb = useCallback(
    async (slot: KbSlot) => {
      if (!await requestEdit()) return;
      const r = await window.mc.pickKnowledge(slot);
      if (!r) return;
      if (!r.text.trim()) {
        // deterministic parsers return '' for scanned/image-only PDFs
        setKbNotice(tRef.current.app.kbNoText(r.name));
        return;
      }
      setKbNotice(null);
      patchSession(currentIdRef.current, (s) =>
        slot === 'resume'
          ? { ...s, resumeName: r.name, resumeText: r.text }
          : { ...s, jdName: r.name, jdText: r.text },
      );
      // material changed → reheat the prefix cache with the fresh bytes;
      // patchSession is async (React state), so pass the new slots directly
      window.mc.prewarm({
        resume: slot === 'resume' ? r.text : currentMaterial().resume,
        jd: slot === 'jd' ? r.text : currentMaterial().jd,
        immediate: true,
      });
    },
    [patchSession, currentMaterial],
  );

  const clearKb = useCallback(
    (slot: KbSlot) => {
      patchSession(currentIdRef.current, (s) =>
        slot === 'resume'
          ? { ...s, resumeName: undefined, resumeText: undefined }
          : { ...s, jdName: undefined, jdText: undefined },
      );
      // prefix went stale; reheats now if capturing, else at the next ▶
      window.mc.prewarm({
        resume: slot === 'resume' ? undefined : currentMaterial().resume,
        jd: slot === 'jd' ? undefined : currentMaterial().jd,
      });
    },
    [patchSession, currentMaterial],
  );

  /** the v1 -> v2 migration marks hand-configured profiles; show the notice
   * once until the user dismisses it (persisted in onboarding state) */
  const showUpgradeNotice =
    !!settings &&
    settings.version === 2 &&
    settings.onboarding.completed &&
    !!settings.onboarding.migratedFromV1 &&
    !settings.onboarding.dismissedUpgradePrompt;

  const dismissUpgradeNotice = async () => {
    const onboarding = await window.mc.saveOnboardingProgress({ dismissedUpgradePrompt: true });
    setSettings((s) => (s ? { ...s, onboarding } : s));
  };

  const visionReady =
    !!settings?.llm.answerWithVision &&
    !!settings?.vision.baseUrl &&
    !!settings?.vision.model &&
    !!settings?.vision.apiKeySet;

  /**
   * One derivation for the status chips, the health panel and the answer
   * gating (shared/healthState.ts). A missing LLM key disables the answer
   * buttons with an explanation instead of letting every click produce the
   * same main-process error turn — but it never blocks transcription.
   */
  const health = useMemo(
    () => (settings ? deriveServiceHealth({ settings, asr, capturing }) : null),
    [settings, asr, capturing],
  );
  const answersReady = health?.answersAvailable ?? true;
  const questionBusy = !!current && hasPendingAnswer(current);
  const questionCount = rangeStage && !rangeRef.current?.startDone ? 0 : current?.pendingQuestion?.length ?? 0;
  const waiting = waitingConfirmation === currentId;
  const confirmDisabled = rangeStage === 'recording' ? false : !answersReady || questionBusy ||
    (!questionCount && !partials.them?.trim() && !capturing && asr.workerState !== 'speech' && asr.workerState !== 'transcribing');
  const toggleQuestionRange = useCallback(() => {
    const cap = captureKindForPlatform(window.mc.platform) === 'input' ? themInputRef.current! : loopbackRef.current!;
    const range = rangeRef.current;
    if (range) {
      if (range.cancelled) { setWindowNotice(tRef.current.question.stillCutting); return; }
      if (range.endId) return;
      range.endId = uid('range-end');
      setRangeStage('finishing');
      waitForFinal(range.sid);
      range.endMarker = cap.cut(range.endId, () => window.mc.asrCut(range.endId!));
      void range.endMarker.catch((error) => failRange(range, error));
      return;
    }
    if (!cap.running || asr.phase !== 'ready') { setWindowNotice(tRef.current.question.rangeNeedsCapture); return; }
    const session = sessionsRef.current.find((s) => s.id === currentIdRef.current);
    if (!answersReady || !session || hasPendingAnswer(session) || cutRef.current || waitingRef.current) {
      setWindowNotice(tRef.current.question.stillCutting);
      return;
    }
    const next: QuestionRange = { sid: session.id, epoch: session.questionEpoch ?? 0, startId: uid('range-start'), startDone: false };
    rangeRef.current = next;
    setWindowNotice((notice) => notice === tRef.current.question.rangeEmpty || notice === tRef.current.question.stillCutting ? null : notice);
    setRangeStage('recording');
    void cap.cut(next.startId, () => window.mc.asrCut(next.startId)).catch((error) => failRange(next, error));
  }, [answersReady, asr.phase, failRange, waitForFinal]);

  const confirmQuestion = useCallback(() => {
    if (rangeRef.current) {
      if (!rangeRef.current.cancelled && !rangeRef.current.endId) toggleQuestionRange();
      else cancelRange();
      return;
    }
    if (waitingRef.current) { waitForFinal(null); return; }
    const s = sessionsRef.current.find((s) => s.id === currentIdRef.current);
    if (!answersReady || !s || hasPendingAnswer(s)) return;
    if (cutRef.current) {
      setAsr((state) => ({ ...state, lastError: tRef.current.question.stillCutting }));
      return;
    }
    const requestId = uid('cut');
    cutRef.current = { requestId, sid: s.id, epoch: s.questionEpoch ?? 0 };
    waitForFinal(s.id);
    const cap = captureKindForPlatform(window.mc.platform) === 'input' ? themInputRef.current! : loopbackRef.current!;
    void cap.cut(requestId, () => window.mc.asrCut(requestId)).catch((error: unknown) => {
      if (cutRef.current?.requestId !== requestId) return;
      cutRef.current = null;
      waitForFinal(null);
      setAsr((state) => ({ ...state, lastError: tRef.current.question.cutFailed(String(error)) }));
    });
  }, [answersReady, waitForFinal, toggleQuestionRange, cancelRange]);

  useEffect(() => window.mc.onConfirmHotkey(toggleQuestionRange), [toggleQuestionRange]);
  const rangeButtonDisabled = rangeStage === 'recording' ? false :
    !capturing || captureStarting || asr.phase !== 'ready' || !answersReady || questionBusy ||
    !!rangeRef.current || !!cutRef.current || !!waitingRef.current;

  return (
    <I18nProvider lang="zh">
    <div className="app">
      <header className="titlebar">
        <span className="brand">MeetingBot</span>
        <div className="titlebar-actions">
          <button
            className={capturing ? 'btn btn-live' : 'btn btn-primary'}
            onClick={() => (capturing ? void stopCapture() : void startCapture())}
            disabled={asr.phase !== 'ready' || captureStarting}
            title={
              captureKindForPlatform(window.mc.platform) === 'loopback'
                ? capturing
                  ? t.titlebar.stopTitle
                  : t.titlebar.startTitle
                : capturing
                  ? t.titlebar.stopInputTitle
                  : t.titlebar.startInputTitle
            }
          >
            {captureStarting ? t.question.captureStarting : capturing ? t.titlebar.stop : t.titlebar.start}
          </button>
          {captureKindForPlatform(window.mc.platform) === 'input' && mics.length > 0 && (
            <select
              className="mic-select"
              disabled={windowMode === 'browse'}
              value={settings?.audio.themDeviceId ?? ''}
              onChange={(e) => void selectThemInput(e.target.value)}
              title={t.titlebar.themDeviceTitle}
            >
              <option value="">{t.titlebar.themDeviceDefault}</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {(m.label || t.titlebar.themDeviceDefault).slice(0, 14)}
                </option>
              ))}
            </select>
          )}
          <button
            className={rangeStage === 'recording' ? 'btn btn-live range-action' : 'btn range-action'}
            onClick={toggleQuestionRange}
            disabled={rangeButtonDisabled}
            title={t.question.rangeButtonHint}
            aria-pressed={rangeStage === 'recording'}
          >
            {rangeStage === 'recording' ? t.question.rangeEnd : rangeStage === 'finishing' ? t.question.rangeProcessing : t.question.rangeStart}
          </button>
          <button
            className="btn btn-primary question-cut-action"
            onClick={confirmQuestion}
            disabled={!waiting && confirmDisabled}
            title={t.question.hint}
          >
            {waiting ? t.question.cancelWait : rangeStage === 'recording' ? t.question.rangeEnd : t.question.confirm} ({questionCount})
          </button>
          <button
            className="btn screenshot-action"
            onClick={() => void doRegionShot()}
            disabled={!settings || !currentId}
            title={t.answer.shotButtonTitle}
          >
            📷 {t.answer.shotButton}
          </button>
          <button
            className={settings?.llm.answerWithVision ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleAnswerModel()}
            title={t.titlebar.modelTitle}
          >
            {settings?.llm.answerWithVision ? t.titlebar.vision : t.titlebar.textOnly}
          </button>
          <button
            className={settings?.ui.stealth ? 'btn btn-on' : 'btn'}
            onClick={() => void toggleStealth()}
            title={
              window.mc.platform === 'darwin'
                ? t.titlebar.stealthMacTitle
                : t.titlebar.stealthTitle
            }
          >
            {t.titlebar.stealth(!!settings?.ui.stealth)}
          </button>
          <button className="btn" onClick={() => setShowHud((v) => !v)} title={t.titlebar.hudTitle}>
            HUD
          </button>
          {window.mc.platform === 'win32' && <button
            className={windowMode === 'edit' ? 'btn btn-on interaction-mode' : 'btn interaction-mode'}
            title={t.titlebar.modeHint}
            onClick={() => void window.mc.setWindowMode(windowMode === 'browse' ? 'edit' : 'browse').then((mode) => {
              setWindowMode(mode);
              if (mode === 'browse') closePanels();
            })}
          >{windowMode === 'browse' ? t.titlebar.browseMode : t.titlebar.editMode}</button>}
          <button className="btn" onClick={() => {
            if (showSettings) { setShowSettings(false); void finishEdit(); }
            else void requestEdit().then((allowed) => { if (allowed) setShowSettings(true); });
          }} title={t.titlebar.settingsTitle}>
            ⚙
          </button>
          <button className="btn" onClick={() => window.mc.hide()} title={t.titlebar.hideTitle}>
            —
          </button>
          <button className="btn btn-close" onClick={() => window.mc.quit()} title={t.titlebar.quitTitle}>
            ✕
          </button>
        </div>
      </header>

      {(rangeStage || capturing) && <div className="upgrade-banner" role="status" data-range-stage={rangeStage ?? 'ready'}>
        <span>{rangeStage === 'recording' ? t.question.rangeRecording(settings?.ui.hotkeyConfirm ?? '') : rangeStage === 'finishing' ? t.question.rangeFinalizing : t.question.rangeReady(settings?.ui.hotkeyConfirm ?? '')}</span>
      </div>}

      {!!hotkeyFailures.length && <div className="upgrade-banner" role="alert">
        <span>{t.settings.hotkeyFailed(hotkeyFailures.join(' / '))}</span>
        <button className="btn btn-sm" onClick={() => setHotkeyFailures([])}>×</button>
      </div>}

      {windowNotice && <div className="upgrade-banner" role="status">
        <span>{windowNotice}</span><button className="btn btn-sm" onClick={() => setWindowNotice(null)}>×</button>
      </div>}

      {/* grandfathered users (settings.json predates the wizard) get one
          dismissible pointer at the new wizard; wizard-created profiles never
          carry onboarding.migratedFromV1, so they never see it */}
      {showUpgradeNotice && (
        <div className="upgrade-banner">
          <span>{t.app.upgradeNotice}</span>
          <button className="btn btn-sm btn-primary" onClick={() => void window.mc.rerunOnboarding()}>
            {t.app.upgradeCheck}
          </button>
          <button className="btn btn-sm" onClick={() => void dismissUpgradeNotice()}>
            {t.app.upgradeSkip}
          </button>
        </div>
      )}

      {showHealth && settings && health && (
        <ServiceHealthPanel
          settings={settings}
          health={health}
          onClose={() => setShowHealth(false)}
          onOpenSettings={() => {
            setShowHealth(false);
            void requestEdit().then((allowed) => { if (allowed) setShowSettings(true); });
          }}
          onOpenDiagnostics={() => {
            setShowHealth(false);
            setShowDiagnostics(true);
          }}
          onSettingsRefreshed={setSettings}
        />
      )}

      {showDiagnostics && <DiagnosticsPanel onClose={() => setShowDiagnostics(false)} />}

      {showKnowledge && <KnowledgePanel editable={windowMode === 'edit'} onRequestEdit={requestEdit} onClose={() => setShowKnowledge(false)} />}

      {showHelp && (
        <HelpPanel
          onClose={() => setShowHelp(false)}
          onOpenSettings={() => {
            setShowHelp(false);
            void requestEdit().then((allowed) => { if (allowed) setShowSettings(true); });
          }}
          onOpenDiagnostics={() => {
            setShowHelp(false);
            setShowDiagnostics(true);
          }}
        />
      )}

      {showSettings && settings && (
        <SettingsPanel
          settings={settings}
          onOpacityPreview={setOpacityPreview}
          onSaved={(s) => {
            setSettings(s);
            setShowSettings(false);
            void finishEdit();
          }}
          onClose={() => { setShowSettings(false); void finishEdit(); }}
          onRerunWizard={() => {
            setShowSettings(false);
            void window.mc.rerunOnboarding();
          }}
          onOpenDiagnostics={() => {
            setShowSettings(false);
            void finishEdit();
            setShowDiagnostics(true);
          }}
          onOpenHelp={() => {
            setShowSettings(false);
            void finishEdit();
            setShowHelp(true);
          }}
        />
      )}

      <ResizablePanes ratio={settings?.ui.transcriptRatio} disabled={!settings} onCommit={savePaneRatio}>
        <TranscriptPanel
          segments={segments}
          partials={partials}
          answersReady={answersReady}
          answersHint={t.health.answersDisabled}
          pendingText={current && (!rangeStage || rangeRef.current?.startDone) ? questionText(current) : ''}
          pendingCount={questionCount}
          waiting={waiting}
          rangeRecording={rangeStage === 'recording'}
          questionBusy={questionBusy}
          confirmDisabled={confirmDisabled}
          onConfirm={confirmQuestion}
          onAsk={(text) => askLlm('segment', text)}
          onTranslate={translateSegment}
          onClear={clearTranscript}
        />
        <AnswerSession
          sessions={sessions}
          currentId={currentId}
          turns={current?.turns ?? []}
          editable={windowMode === 'edit'}
          onRequestEdit={requestEdit}
          onFinishEdit={finishEdit}
          onOpenKnowledge={() => {
            closePanels();
            setShowKnowledge(true);
          }}
          resumeName={current?.resumeName}
          resumeChars={current?.resumeText?.length ?? 0}
          jdName={current?.jdName}
          jdChars={current?.jdText?.length ?? 0}
          notice={kbNotice}
          visionReady={visionReady}
          answersReady={answersReady}
          answersHint={t.health.answersDisabled}
          onSwitch={(id) => { cancelRange(); waitForFinal(null); setCurrentId(id); }}
          onNew={createSession}
          onDelete={deleteSession}
          onRename={renameSession}
          onPickKb={(slot) => void pickKb(slot)}
          onClearKb={clearKb}
          onCancel={cancelTurn}
          onClear={clearAnswers}
          onFreeAsk={(q) => askLlm('free', q)}
          onShotAsk={askShot}
        />
      </ResizablePanes>

      <StatusBar
        asr={asr}
        capturing={capturing}
        hud={showHud ? hud : undefined}
        health={health ?? undefined}
        onOpenHealth={() => setShowHealth((v) => !v)}
      />
    </div>
    </I18nProvider>
  );
}

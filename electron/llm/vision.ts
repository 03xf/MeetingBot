/**
 * Vision (R5) transport — MAIN PROCESS ONLY (imports electron).
 *
 * DeepSeek has no image input (verified: official API rejects image_url on
 * all models), so screenshot Q&A needs a separate vision provider. Gemini is
 * multimodal but blocked in China, so this path routes through a proxied
 * Electron session (net.request) while the latency-critical DeepSeek answer
 * path stays on direct global fetch. Non-streaming: on-demand + proxy latency
 * dominates, so one round-trip is simpler and robust.
 */
import { net, session, type Session } from 'electron';
import { StringDecoder } from 'node:string_decoder';
import { toProxyRules, type ChatMessage } from './adapter';
import { completionOptions } from './completionOptions';

/** message.content, falling back to reasoning_content (MiMo/thinking models). */
function extractVisionText(jsonBody: string): string {
  try {
    const j = JSON.parse(jsonBody);
    const m = j?.choices?.[0]?.message ?? {};
    return (m.content ?? '').trim() || (m.reasoning_content ?? '').trim();
  } catch {
    return '';
  }
}

export interface VisionConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** e.g. '127.0.0.1:7897'; empty => direct */
  proxyUrl?: string;
}

let proxiedSession: Session | null = null;

/**
 * Direct calls (MiMo etc.) use the proven defaultSession. Only when a proxy is
 * configured (Gemini) do we use a dedicated partitioned session with proxy
 * rules — keeping the proxy off every other network call.
 */
async function pickSession(rules: string): Promise<Session> {
  if (!rules) return session.defaultSession;
  if (!proxiedSession) proxiedSession = session.fromPartition('vision-proxy');
  await proxiedSession.setProxy({ proxyRules: rules });
  return proxiedSession;
}

export async function visionChat(
  config: VisionConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  // Bound both a silent connection and a response that stops halfway through.
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000);
  signal.throwIfAborted();
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({ model: config.model, messages, stream: false, ...completionOptions(config) });
  const rules = toProxyRules(config.proxyUrl);
  const ses = await pickSession(rules);
  signal?.throwIfAborted();

  const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = net.request({ method: 'POST', url, session: ses });
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('Authorization', `Bearer ${config.apiKey}`);
    let settled = false;
    const finish = (error?: Error, result?: { status: number; body: string }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => { finish(signal?.reason ?? new DOMException('Aborted', 'AbortError')); req.abort(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    req.on('response', (res) => {
      let data = '';
      const decoder = new StringDecoder('utf8');
      res.on('data', (c) => (data += decoder.write(c)));
      res.on('end', () => finish(undefined, { status: res.statusCode ?? 0, body: data + decoder.end() }));
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new Error('Vision response aborted (ECONNRESET)')));
    });
    req.on('error', (e) => finish(e));
    req.on('abort', () => finish(new DOMException('Aborted', 'AbortError')));
    // ClientRequest.close can precede response even on success in Electron.
    // Response abort/error and the deadline handle incomplete downloads.
    req.write(body);
    req.end();
  });

  if (raw.status < 200 || raw.status >= 300) {
    throw new Error(`Vision HTTP ${raw.status}: ${raw.body.slice(0, 300)}`);
  }
  const text = extractVisionText(raw.body);
  if (!text) throw new Error(`the vision model returned an empty result: ${raw.body.slice(0, 200)}`);
  return text;
}

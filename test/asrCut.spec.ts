import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { runInNewContext } from 'vm';
import { AliyunRealtimeEngine } from '../electron/asr/aliyunRealtimeEngine';
import { VadSegmenter } from '../electron/asr/vad';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    for (const client of s.clients) client.terminate();
    s.close(() => resolve());
  })));
});

async function service() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address() as { port: number };
  const engine = await AliyunRealtimeEngine.load({ baseUrl: `ws://127.0.0.1:${address.port}`, model: 'fake', apiKey: '' });
  return { server, engine };
}

describe('forced audio boundary', () => {
  it('flushes the worklet tail before the cut marker and keeps processing the next samples', () => {
    const messages: unknown[] = [];
    let Processor: any;
    class Base { port = { onmessage: null as any, postMessage: (value: unknown) => messages.push(value) }; }
    runInNewContext(readFileSync('src/public/pcm-worklet.js', 'utf8'), {
      AudioWorkletProcessor: Base, Float32Array,
      registerProcessor: (_name: string, ctor: any) => { Processor = ctor; },
    });
    const p = new Processor();
    p.process([[new Float32Array(1600).fill(0.1)]]);
    p.process([[new Float32Array(123).fill(0.2)]]);
    p.port.onmessage({ data: { type: 'cut', requestId: 'c1' } });
    p.process([[new Float32Array(1600).fill(0.3)]]);
    expect(messages).toHaveLength(4);
    expect(Array.from(new Float32Array(messages[1] as ArrayBuffer))).toEqual(Array(123).fill(Math.fround(0.2)));
    expect(messages[2]).toEqual({ type: 'cut', requestId: 'c1' });
    expect(new Float32Array(messages[3] as ArrayBuffer)[0]).toBeCloseTo(0.3);
  });

  it('keeps a short word on explicit cut and does not repeat it in the following segment', () => {
    const vad = new VadSegmenter();
    vad.push(new Float32Array(1600).fill(0.1), 100);
    const before = vad.flush(true);
    expect(before).toHaveLength(1);
    expect(before[0].type === 'segment' && before[0].pcm.length).toBe(1600);
    vad.push(new Float32Array(1600).fill(0.2), 200);
    const after = vad.flush(true);
    expect(after[0].type === 'segment' && after[0].pcm[0]).toBeCloseTo(0.2);
    expect(after[0].type === 'segment' && after[0].pcm.length).toBe(1600);
  });

  it('finishes a session opened just before confirmation without dropping its buffered audio', async () => {
    const { server, engine } = await service();
    const order: string[] = [];
    server.on('connection', (ws) => {
      ws.on('message', (data, binary) => {
        if (binary) { order.push('audio'); return; }
        const request = JSON.parse(data.toString());
        const send = (event: string, payload?: unknown) => ws.send(JSON.stringify({ header: { event }, payload }));
        if (request.header.action === 'run-task') setTimeout(() => send('task-started'), 30);
        if (request.header.action === 'finish-task') {
          order.push('finish');
          send('result-generated', { output: { sentence: { text: '第二句已经说出的部分', sentence_end: true } } });
          send('task-finished');
        }
      });
    });
    const results: string[] = [];
    const session = engine.openSession({ onPartial: () => {}, onSentence: (s) => results.push(s.text), onError: () => {} });
    session.push(new Float32Array(1600).fill(0.1));
    const finishing = session.close();
    session.push(new Float32Array(1600).fill(0.2)); // after the boundary: rejected by this session
    await finishing;
    expect(order).toEqual(['audio', 'finish']);
    expect(results).toEqual(['第二句已经说出的部分']);
    await session.close(); // idempotent
  });

  it('rejects an unexpected service close instead of pretending the segment finalized', async () => {
    const { server, engine } = await service();
    server.on('connection', (ws) => ws.on('message', (data, binary) => {
      if (binary) return;
      const request = JSON.parse(data.toString());
      if (request.header.action === 'run-task') ws.send(JSON.stringify({ header: { event: 'task-started' } }));
      if (request.header.action === 'finish-task') ws.close();
    }));
    const errors: string[] = [];
    const session = engine.openSession({ onPartial: () => {}, onSentence: () => {}, onError: (e) => errors.push(e) });
    session.push(new Float32Array(1600));
    await expect(session.close()).rejects.toThrow('before task-finished');
    expect(errors).toHaveLength(1);
  });
});

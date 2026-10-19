/** Order a marker after the worklet's buffered audio without stopping capture. */
export function cutCapture(node: AudioWorkletNode | null, requestId: string, onCut: () => void): Promise<void> {
  if (!node) { onCut(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); node.port.removeEventListener('message', listener); };
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== 'cut' || event.data.requestId !== requestId) return;
      cleanup();
      try { onCut(); resolve(); } catch (error) { reject(error); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Audio boundary timed out')); }, 3000);
    node.port.addEventListener('message', listener);
    node.port.postMessage({ type: 'cut', requestId });
  });
}

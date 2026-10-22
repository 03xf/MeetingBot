export interface RegionRect { x: number; y: number; width: number; height: number }
interface CaptureImage {
  toDataURL(): string;
  crop(rect: RegionRect): { toDataURL(): string };
}
interface Capture { image: CaptureImage; width: number; height: number; scale: number; origin?: { x: number; y: number } }
interface Job {
  resolve: (image: string | null) => void;
  capture?: Capture;
  image?: string;
  window?: { close(): void };
  timer?: ReturnType<typeof setTimeout>;
}

/** One transaction, including the asynchronous desktop capture before a window exists. */
export class RegionCapture {
  private active: Job | null = null;
  private captureInFlight: Promise<Capture> | null = null;
  constructor(private readonly options: {
    capture: () => Promise<Capture>;
    open: (image: string, select: (rect: RegionRect) => void, cancel: () => void, capture: Capture) => { close(): void };
    captureTimeoutMs?: number;
    selectionTimeoutMs?: number;
    onFailure?: (reason: string) => void;
  }) {}
  get picking(): boolean { return this.active !== null; }
  get image(): string | null { return this.active?.image ?? null; }
  cancel(): void { if (this.active) this.finish(this.active, null); }
  select(rect: RegionRect): void { if (this.active) this.selectJob(this.active, rect); }
  private finish(job: Job, result: string | null): void {
    if (this.active !== job) return;
    this.active = null;
    clearTimeout(job.timer);
    try { job.window?.close(); } catch { /* already destroyed */ } finally { job.resolve(result); }
  }
  private fail(job: Job, reason: string): void {
    if (this.active !== job) return;
    this.noteFailure(reason);
    this.finish(job, null);
  }
  private noteFailure(reason: string): void { try { this.options.onFailure?.(reason); } catch { /* diagnostics must not break cleanup */ } }
  private selectJob(job: Job, rect: RegionRect): void {
    if (this.active !== job || !job.capture) return;
    const c = job.capture;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width < 4 || rect.height < 4) { this.finish(job, null); return; }
    const x = Math.max(0, Math.min(c.width, rect.x));
    const y = Math.max(0, Math.min(c.height, rect.y));
    const right = Math.max(x, Math.min(c.width, rect.x + rect.width));
    const bottom = Math.max(y, Math.min(c.height, rect.y + rect.height));
    if (right - x < 4 || bottom - y < 4) { this.finish(job, null); return; }
    try {
      const left = Math.round(x * c.scale), top = Math.round(y * c.scale);
      this.finish(job, c.image.crop({ x: left, y: top,
        width: Math.round(right * c.scale) - left, height: Math.round(bottom * c.scale) - top }).toDataURL());
    } catch { this.finish(job, null); }
  }
  pick(): Promise<string | null> {
    if (this.active) { this.cancel(); return Promise.resolve(null); }
    // getSources has no cancellation API. Never pile new native captures on
    // top of an earlier request that timed out or was cancelled.
    if (this.captureInFlight) { this.noteFailure('capture-still-pending'); return Promise.resolve(null); }
    return new Promise((resolve) => {
      const job: Job = { resolve };
      this.active = job;
      job.timer = setTimeout(() => this.fail(job, 'capture-timeout'), this.options.captureTimeoutMs ?? 10_000);
      const task = Promise.resolve().then(() => this.options.capture());
      this.captureInFlight = task;
      void task.then((capture) => {
        if (this.active !== job) return;
        job.capture = capture;
        // Encode once; repeated regionImage IPC reads must not encode the
        // entire screen again on the main thread.
        job.image = capture.image.toDataURL();
        clearTimeout(job.timer);
        job.timer = setTimeout(() => this.fail(job, 'selection-timeout'), this.options.selectionTimeoutMs ?? 90_000);
        const opened = this.options.open(job.image,
          (rect) => this.selectJob(job, rect), () => this.finish(job, null), capture);
        if (this.active === job) job.window = opened;
        else opened.close(); // synchronous cancellation during open
      }).catch(() => this.fail(job, 'capture-failed')).finally(() => {
        if (this.captureInFlight === task) this.captureInFlight = null;
      });
    });
  }
}

export interface RegionRect { x: number; y: number; width: number; height: number }
interface CaptureImage {
  toDataURL(): string;
  crop(rect: RegionRect): { toDataURL(): string };
}
interface Capture { image: CaptureImage; width: number; height: number; scale: number }
interface Job {
  resolve: (image: string | null) => void;
  capture?: Capture;
  window?: { close(): void };
}

/** One transaction, including the asynchronous desktop capture before a window exists. */
export class RegionCapture {
  private active: Job | null = null;
  constructor(private readonly options: {
    capture: () => Promise<Capture>;
    open: (image: string, select: (rect: RegionRect) => void, cancel: () => void) => { close(): void };
  }) {}
  get picking(): boolean { return this.active !== null; }
  get image(): string | null { return this.active?.capture?.image.toDataURL() ?? null; }
  cancel(): void { if (this.active) this.finish(this.active, null); }
  select(rect: RegionRect): void { if (this.active) this.selectJob(this.active, rect); }
  private finish(job: Job, result: string | null): void {
    if (this.active !== job) return;
    this.active = null;
    try { job.window?.close(); } catch { /* already destroyed */ } finally { job.resolve(result); }
  }
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
    return new Promise((resolve) => {
      const job: Job = { resolve };
      this.active = job;
      void Promise.resolve().then(() => this.options.capture()).then((capture) => {
        if (this.active !== job) return;
        job.capture = capture;
        job.window = this.options.open(capture.image.toDataURL(),
          (rect) => this.selectJob(job, rect), () => this.finish(job, null));
      }).catch(() => this.finish(job, null));
    });
  }
}

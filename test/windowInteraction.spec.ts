import { describe, expect, it, vi } from 'vitest';
import { displayWindow } from '../electron/windowInteraction';
import { RegionCapture } from '../electron/regionCapture';

describe('window activation policy', () => {
  const window = () => ({ setFocusable: vi.fn(), showInactive: vi.fn(), show: vi.fn(), focus: vi.fn(), isMinimized: () => true, restore: vi.fn() });
  it('shows a browsing window without activation or a restore that could activate it', () => {
    const w = window(); displayWindow(w, 'browse');
    expect(w.setFocusable).toHaveBeenCalledWith(false);
    expect(w.showInactive).toHaveBeenCalledOnce();
    expect(w.show).not.toHaveBeenCalled(); expect(w.focus).not.toHaveBeenCalled(); expect(w.restore).not.toHaveBeenCalled();
  });
  it('allows focus and minimized restore only for explicit editing', () => {
    const w = window(); displayWindow(w, 'edit');
    expect(w.setFocusable).toHaveBeenCalledWith(true);
    expect(w.restore).toHaveBeenCalledOnce(); expect(w.focus).toHaveBeenCalledOnce();
  });
});

describe('single screenshot transaction', () => {
  const tick = async () => { await new Promise((r) => setTimeout(r, 0)); };
  function fixture(capture?: () => Promise<any>) {
    const crop = vi.fn(() => ({ toDataURL: () => 'cropped' }));
    const close = vi.fn(); const windows: { select: (r: any) => void; cancel: () => void }[] = [];
    const shot = new RegionCapture({
      capture: capture ?? (async () => ({ image: { toDataURL: () => 'image', crop }, width: 100, height: 80, scale: 1.25 })),
      open: (_image, select, cancel) => { windows.push({ select, cancel }); return { close }; },
    });
    return { shot, crop, close, windows };
  }
  it('crops the bounded selection at the display scale and resolves once', async () => {
    const f = fixture(); const result = f.shot.pick(); await tick();
    f.windows[0].select({ x: 10, y: 10, width: 100, height: 100 });
    expect(await result).toBe('cropped');
    expect(f.crop).toHaveBeenCalledWith({ x: 13, y: 13, width: 112, height: 87 });
    expect(f.close).toHaveBeenCalledOnce(); expect(f.shot.picking).toBe(false);
  });
  it('repeat activation cancels instead of opening a second overlay', async () => {
    const f = fixture(); const first = f.shot.pick(); await tick();
    expect(await f.shot.pick()).toBeNull(); expect(await first).toBeNull();
    expect(f.windows).toHaveLength(1); expect(f.close).toHaveBeenCalledOnce();
  });
  it('cancels immediately while capture is pending and ignores its late result', async () => {
    let complete!: (v: any) => void;
    const f = fixture(() => new Promise((r) => { complete = r; }));
    const result = f.shot.pick(); await tick(); f.shot.cancel();
    expect(await result).toBeNull();
    complete({ image: { toDataURL: () => 'late' }, width: 10, height: 10, scale: 1 }); await tick();
    expect(f.windows).toHaveLength(0); expect(f.shot.image).toBeNull();
  });
  it('does not let an old window callback cancel a newer capture', async () => {
    const f = fixture(); const first = f.shot.pick(); await tick(); f.shot.cancel(); await first;
    const next = f.shot.pick(); await tick(); f.windows[0].cancel();
    expect(f.shot.picking).toBe(true); f.windows[1].cancel(); expect(await next).toBeNull();
  });
  it.each([{ x: NaN, y: 0, width: 20, height: 20 }, { x: 1, y: 1, width: 2, height: 2 }])('rejects an invalid selection', async (rect) => {
    const f = fixture(); const result = f.shot.pick(); await tick(); f.windows[0].select(rect);
    expect(await result).toBeNull(); expect(f.crop).not.toHaveBeenCalled();
  });
  it('cleans up capture failures without opening an overlay', async () => {
    const f = fixture(async () => { throw Error('capture failed'); });
    expect(await f.shot.pick()).toBeNull(); expect(f.shot.picking).toBe(false);
    expect(f.windows).toHaveLength(0);
  });
});

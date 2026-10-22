import { describe, expect, it, vi } from 'vitest';
import { displayWindow, prepareRegionWindow, TrayWindowVisibility } from '../electron/windowInteraction';
import { RegionCapture } from '../electron/regionCapture';

describe('window activation policy', () => {
  const window = (focusable = true) => ({ isVisible: () => false, isFocusable: () => focusable, setFocusable: vi.fn(), showInactive: vi.fn(), show: vi.fn(), focus: vi.fn(), isMinimized: () => true, restore: vi.fn() });
  it('shows a browsing window without activation or a restore that could activate it', () => {
    const w = window(); displayWindow(w, 'browse');
    expect(w.setFocusable).toHaveBeenCalledWith(false);
    expect(w.showInactive).toHaveBeenCalledOnce();
    expect(w.show).not.toHaveBeenCalled(); expect(w.focus).not.toHaveBeenCalled(); expect(w.restore).not.toHaveBeenCalled();
  });
  it('allows focus and minimized restore only for explicit editing', () => {
    const w = window(false); displayWindow(w, 'edit');
    expect(w.setFocusable).toHaveBeenCalledWith(true);
    expect(w.restore).toHaveBeenCalledOnce(); expect(w.focus).toHaveBeenCalledOnce();
  });
  it('does not rewrite the activation style on repeated browse wakes', () => {
    const w = window(false); for (let n = 0; n < 100; n++) displayWindow(w, 'browse');
    expect(w.setFocusable).not.toHaveBeenCalled(); expect(w.showInactive).toHaveBeenCalledTimes(100);
    expect(w.focus).not.toHaveBeenCalled();
  });
  it('uses native translucency for the Windows selection layer', () => {
    const setOpacity = vi.fn(); prepareRegionWindow({ setOpacity }, 'win32');
    expect(setOpacity).toHaveBeenCalledWith(0.99);
    setOpacity.mockClear(); prepareRegionWindow({ setOpacity }, 'darwin'); expect(setOpacity).not.toHaveBeenCalled();
  });
  it('keeps a parked Windows render widget mapped while restoring visibility and mouse input', () => {
    let nativeVisible = false;
    const w = { ...window(false), isVisible: () => nativeVisible, hide: vi.fn(), setOpacity: vi.fn(), setIgnoreMouseEvents: vi.fn() };
    w.showInactive.mockImplementation(() => { nativeVisible = true; });
    const changed = vi.fn(); const visibility = new TrayWindowVisibility(w, 'win32', changed);
    visibility.show('browse');
    for (let n = 0; n < 20; n++) {
      visibility.hide(); expect(visibility.visible).toBe(false);
      expect(w.setOpacity).toHaveBeenLastCalledWith(0); expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
      visibility.show('browse'); expect(visibility.visible).toBe(true);
      expect(w.setOpacity).toHaveBeenLastCalledWith(1); expect(w.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    }
    expect(w.hide).not.toHaveBeenCalled(); expect(w.showInactive).toHaveBeenCalledOnce();
    expect(w.show).not.toHaveBeenCalled(); expect(w.focus).not.toHaveBeenCalled();
    visibility.hide(); visibility.hide(); expect(changed.mock.calls.filter(([shown]) => !shown)).toHaveLength(21);
  });
  it('retains native hiding outside Windows', () => {
    const w = { ...window(), hide: vi.fn(), setOpacity: vi.fn(), setIgnoreMouseEvents: vi.fn() };
    const visibility = new TrayWindowVisibility(w, 'darwin', vi.fn()); visibility.show('edit'); visibility.hide();
    expect(w.hide).toHaveBeenCalledOnce(); expect(w.setOpacity).not.toHaveBeenCalled(); expect(w.setIgnoreMouseEvents).not.toHaveBeenCalled();
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
  it('encodes the captured frame once across repeated IPC image reads', async () => {
    const encode = vi.fn(() => 'image');
    const f = fixture(async () => ({ image: { toDataURL: encode }, width: 100, height: 80, scale: 1 }));
    const result = f.shot.pick(); await tick();
    for (let i = 0; i < 5; i++) expect(f.shot.image).toBe('image');
    expect(encode).toHaveBeenCalledOnce(); f.shot.cancel(); await result;
  });
  it('times out a stalled capture, ignores late completion and prevents overlapping native requests', async () => {
    vi.useFakeTimers();
    let complete!: (value: any) => void;
    const capture = vi.fn(() => new Promise<any>(resolve => { complete = resolve; }));
    const open = vi.fn(); const failure = vi.fn();
    const shot = new RegionCapture({ capture, open, captureTimeoutMs: 10, onFailure: failure });
    try {
      const first = shot.pick(); await vi.advanceTimersByTimeAsync(10); expect(await first).toBeNull();
      expect(failure).toHaveBeenCalledWith('capture-timeout'); expect(shot.picking).toBe(false);
      expect(await shot.pick()).toBeNull(); expect(capture).toHaveBeenCalledOnce();
      expect(failure).toHaveBeenCalledWith('capture-still-pending');
      complete({ image: { toDataURL: () => 'late' }, width: 100, height: 80, scale: 1 });
      await vi.advanceTimersByTimeAsync(0); expect(open).not.toHaveBeenCalled();
    } finally { shot.cancel(); vi.useRealTimers(); }
  });
  it('destroys an abandoned selection after its deadline, even when diagnostic recording fails', async () => {
    vi.useFakeTimers(); const close = vi.fn();
    const shot = new RegionCapture({
      capture: async () => ({ image: { toDataURL: () => 'image', crop: vi.fn() }, width: 100, height: 80, scale: 1 }),
      open: () => ({ close }), selectionTimeoutMs: 10, onFailure: () => { throw Error('disk full'); },
    });
    try {
      const result = shot.pick(); await vi.advanceTimersByTimeAsync(10);
      expect(await result).toBeNull(); expect(close).toHaveBeenCalledOnce(); expect(shot.picking).toBe(false);
    } finally { shot.cancel(); vi.useRealTimers(); }
  });
  it('closes a window that cancels synchronously while opening', async () => {
    const close = vi.fn();
    const shot = new RegionCapture({
      capture: async () => ({ image: { toDataURL: () => 'image', crop: vi.fn() }, width: 100, height: 80, scale: 1 }),
      open: (_image, _select, cancel) => { cancel(); return { close }; },
    });
    expect(await shot.pick()).toBeNull(); expect(close).toHaveBeenCalledOnce();
  });
});

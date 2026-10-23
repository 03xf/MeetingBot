interface Binding { key: string; run: () => void }

/** One invalid or occupied accelerator must not disable the remaining keys. */
export function registerBindings(bindings: Binding[], register: (key: string, run: () => void) => boolean): string[] {
  const failed: string[] = [];
  for (const { key, run } of bindings) {
    if (!key) continue;
    try {
      if (!register(key, run)) failed.push(key);
    } catch { failed.push(key); }
  }
  return failed;
}

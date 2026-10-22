/** Official MiMo uses a reasoning-inclusive token limit. Keep other APIs intact. */
export function completionOptions(config: { baseUrl: string; model: string }, maxTokens?: number): Record<string, unknown> {
  if (config.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === 'https://api.xiaomimimo.com/v1' && /^mimo-v/.test(config.model)) {
    return { thinking: { type: 'disabled' }, max_completion_tokens: maxTokens ?? 4096 };
  }
  return maxTokens ? { max_tokens: maxTokens } : {};
}

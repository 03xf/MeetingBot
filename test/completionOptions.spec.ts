import { describe, expect, it } from 'vitest';
import { completionOptions } from '../electron/llm/completionOptions';

describe('MiMo completion compatibility', () => {
  it('uses the official token field and disables thinking for bounded interactive output', () => {
    expect(completionOptions({ baseUrl: 'https://api.xiaomimimo.com/v1/', model: 'mimo-v2.6-flash' }, 1))
      .toEqual({ max_completion_tokens: 1, thinking: { type: 'disabled' } });
    expect(completionOptions({ baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro' })).toMatchObject({ max_completion_tokens: 4096 });
  });
  it('preserves other providers and custom relay protocols', () => {
    expect(completionOptions({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, 1)).toEqual({ max_tokens: 1 });
    expect(completionOptions({ baseUrl: 'https://relay.example.com/v1', model: 'mimo-v2.6-pro' })).toEqual({});
  });
});

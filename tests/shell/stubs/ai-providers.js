// Test stub for js/ai/providers.js — no network.
import { settings } from '/js/core/settings.js';

const LABELS = { claude: 'Claude', gemini: 'Gemini', mock: '모의 AI' };
export const testCalls = [];

export function getProvider(id = settings.get().provider) {
  return {
    id,
    label: LABELS[id] || id,
    async testKey() {
      testCalls.push(id);
      window.__providerTests = testCalls;
      await new Promise((r) => setTimeout(r, 250));
      const key = settings.get()[id]?.apiKey || '';
      if (key.startsWith('bad')) return { ok: false, message: 'API 키가 올바르지 않습니다. 키를 다시 확인하세요. (401)' };
      return { ok: true, message: `${LABELS[id]} 연결이 확인되었습니다.` };
    },
    async listModels() {
      await new Promise((r) => setTimeout(r, 200));
      return [
        { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
        { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
      ];
    },
    async complete() { return { text: '〔모의 응답〕', usage: { model: 'mock', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }; },
    async *stream() { yield { type: 'text', text: '〔모의 응답〕' }; yield { type: 'done', usage: {} }; },
  };
}

// Test stub for js/ai/providers.js — no network. refreshModels/describeModelChanges are the real js/ai/models.js
// (it imports only core modules) applied to these fake providers.
import { settings } from '/js/core/settings.js';
import { describeModelChanges, syncModels } from '/js/ai/models.js';

export { describeModelChanges };

const LABELS = { claude: 'Claude', openai: 'GPT', gemini: 'Gemini', mock: '모의 AI' };
export const testCalls = [];

const MODELS = {
  claude: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (최고 품질·비쌈)' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (고품질)' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (빠름·저렴)' },
  ],
  openai: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (고품질)' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna (빠름·저렴)' },
  ],
  gemini: [
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
  ],
};

// Same contracts as the real providers: Claude translate → Haiku / assist → Sonnet; GPT Luna / Sol; Gemini plain Flash.
const PICKS = {
  claude: (models, kind) => models.find((m) => m.id.includes(kind === 'translate' ? 'haiku' : 'sonnet'))?.id || models[0]?.id || '',
  openai: (models, kind) => models.find((m) => m.id.includes(kind === 'translate' ? 'luna' : 'sol'))?.id || models[0]?.id || '',
  gemini: (models) => (models.find((m) => /^gemini-[\d.]+-flash$/.test(m.id)) || models[0])?.id || '',
};

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
      return (MODELS[id] || []).map((m) => ({ ...m }));
    },
    pickDefaultModel: (models, kind) => (PICKS[id] ? PICKS[id](models, kind) : models[0]?.id || ''),
    // 2.x Gemini and claude-3 ids are legacy.
    isLegacyModel: (mid) => /^gemini-[0-2](\.\d+)?-|^claude-\d/.test(mid || ''),
    async complete() { return { text: '〔모의 응답〕', usage: { model: 'mock', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }; },
    async *stream() { yield { type: 'text', text: '〔모의 응답〕' }; yield { type: 'done', usage: {} }; },
  };
}

export function refreshModels(id = settings.get().provider, opts = {}) {
  return syncModels(getProvider(id), opts);
}

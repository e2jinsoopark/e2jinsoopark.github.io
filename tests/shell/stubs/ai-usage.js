// Test stub for js/ai/usage.js
export function costUsd() { return 0; }
export function recordUsage() {}
export function usageSummary() {
  return {
    month: '2026-10',
    usd: 0.4231,
    calls: 57,
    byModel: {
      'claude-haiku-5-5': { usd: 0.1832, calls: 49, inputTokens: 812_400, outputTokens: 203_100 },
      'claude-sonnet-5-5': { usd: 0.2399, calls: 8, inputTokens: 61_250, outputTokens: 11_740 },
    },
  };
}

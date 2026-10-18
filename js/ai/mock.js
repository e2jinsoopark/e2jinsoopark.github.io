// Offline, deterministic mock provider (`?mock=1`). No network. Also a test double: `mockControl` lets tests
// inject latency, dropped ids and failures, and observe requests and concurrency.
import { hash } from '../core/util.js';
import { aiError, throwIfAborted } from './providers.js';
import { parseTranslationUserMessage } from './prompts.js';

const DEFAULTS = Object.freeze({ latencyMs: 25, streamDelayMs: 12, reportModel: 'mock' });

/** Test knobs and counters. Call `mockControl.reset()` between tests. */
export const mockControl = {
  /** Delay before each complete() resolves, and between streamed words. */
  latencyMs: DEFAULTS.latencyMs,
  streamDelayMs: DEFAULTS.streamDelayMs,
  /** Model id written into `usage.model` (set to a real id like 'claude-haiku-5-5' to exercise cost math). */
  reportModel: DEFAULTS.reportModel,
  /** Translation ids left out of the FIRST response that contains them (simulates a skipped segment). */
  dropIdsOnce: new Set(),
  /** Translation ids left out of every response (simulates a permanently failing segment). */
  dropIdsAlways: new Set(),
  /** Queue of failures for upcoming calls: { code, message?, partialText? } → thrown as aiError before answering. */
  failNext: [],
  /** Optional (item) => ko | null for translation answers (null = leave the id out). Tests of the fidelity checks. */
  translateWith: null,
  /** Optional (request) => failure | null, checked on every call (content-dependent failures, e.g. one refused id). */
  failWhen: null,
  /** Every request seen, in order: { kind, task, model, effort, maxTokens, system, messages, json, ids, items,
   *  concurrent, startedAt, endedAt } */
  requests: [],
  inFlight: 0,
  maxInFlight: 0,
  reset() {
    Object.assign(this, DEFAULTS);
    this.dropIdsOnce = new Set();
    this.dropIdsAlways = new Set();
    this.failNext = [];
    this.translateWith = null;
    this.failWhen = null;
    this.requests = [];
    this.inFlight = 0;
    this.maxInFlight = 0;
    cachedPrefixes.clear();
    droppedOnce.clear();
  },
};

const cachedPrefixes = new Set();
const droppedOnce = new Set();

export const mockProvider = {
  id: 'mock',
  label: '모의 AI (오프라인 테스트)',

  async complete(opts) {
    const req = begin('complete', opts);
    try {
      await delay(mockControl.latencyMs, opts.signal);
      takeInjectedFailure(req);
      const { text, json } = answer(opts, req);
      return { text, json, usage: fakeUsage(opts, text), stopReason: 'end_turn' };
    } finally {
      end(req);
    }
  },

  async *stream(opts) {
    const req = begin('stream', opts);
    try {
      await delay(mockControl.latencyMs, opts.signal);
      takeInjectedFailure(req);
      const full = cannedAnswer(opts);
      for (const word of full.split(/(?<=\s)/)) {
        await delay(mockControl.streamDelayMs, opts.signal);
        yield { type: 'text', text: word };
      }
      yield { type: 'done', usage: fakeUsage(opts, full), stopReason: 'end_turn' };
    } finally {
      end(req);
    }
  },

  async listModels() {
    return [{ id: 'mock', label: '모의 모델 (오프라인)' }];
  },

  async testKey() {
    return { ok: true, message: '모의 AI는 API 키 없이 동작합니다(오프라인 테스트용).' };
  },
};

// ───────────────────────────── answers ─────────────────────────────

function answer(opts, req) {
  const schema = opts.json;
  if (schema?.properties?.translations) {
    const translations = translateItems(req.items);
    const json = { translations };
    return { text: JSON.stringify(json), json };
  }
  if (schema) {
    const json = fakeFromSchema(schema, citedIds(opts));
    return { text: JSON.stringify(json), json };
  }
  if (opts.task === 'quickTranslate') return { text: mockTranslate(lastUserText(opts.messages)) };
  if (opts.task === 'summary') return { text: cannedSummary(citedIds(opts)) };
  return { text: cannedAnswer(opts) };
}

/** '〔번역〕 ' + the source text, minus the ids the test asked to drop. */
function translateItems(items) {
  const out = [];
  for (const it of items) {
    if (mockControl.dropIdsAlways.has(it.sid)) continue;
    if (mockControl.dropIdsOnce.has(it.sid) && !droppedOnce.has(it.sid)) {
      droppedOnce.add(it.sid);
      continue;
    }
    const ko = mockControl.translateWith ? mockControl.translateWith(it) : mockTranslate(it.text);
    if (ko != null) out.push({ id: it.sid, ko });
  }
  return out;
}

function mockTranslate(text) {
  return `〔번역〕 ${String(text || '')}`;
}

function cannedSummary(ids) {
  const c = (i) => (ids.length ? `[${ids[Math.min(i, ids.length - 1)]}]` : '');
  return `## 한 줄 요약
모의 요약입니다. 이 논문은 중환자실 환자를 대상으로 한 연구의 결과를 보고한다 ${c(0)}.

## 연구 목적
- 연구 배경과 목적을 설명하는 모의 문장이다 ${c(1)}.

## 연구 방법
- 횡단적 조사연구 설계를 사용하였다(모의) ${c(2)}.

## 주요 결과
- 주요 결과는 **41%**에서 통계적으로 유의하였다(p < .05, 모의) ${c(3)}.

## 제한점
- 모의 응답이므로 실제 논문 내용과 다를 수 있다.

## 임상·연구적 시사점
- 간호 실무에 대한 시사점을 제시한다(모의) ${c(4)}.`;
}

function cannedAnswer(opts) {
  const ids = citedIds(opts);
  const cite = ids.length ? ` [${ids[0]}]` : '';
  if (opts.task === 'explain') {
    return `**쉬운 풀이**: 선택한 부분은 연구의 핵심 내용을 설명하는 모의 설명입니다${cite}.\n\n**핵심 용어**: 섬망(delirium)은 급성 의식 혼란 상태를 말합니다.`;
  }
  return `모의 답변입니다. 논문에 따르면 이 질문과 관련된 내용은 다음과 같습니다${cite}. 실제 AI를 연결하면 논문 내용에 근거한 답변이 표시됩니다.`;
}

/**
 * Plausible data for any JSON schema. Arrays get up to 20 items; properties named sid/id are filled with sentence
 * ids seen in the prompt, evenly spread over them (so mock key points cover the whole paper); enums rotate.
 */
function fakeFromSchema(schema, ids) {
  const build = (s, name, index, count) => {
    if (!s || typeof s !== 'object') return null;
    if (Array.isArray(s.enum)) return s.enum[index % s.enum.length];
    switch (s.type) {
      case 'object': {
        const o = {};
        for (const [k, v] of Object.entries(s.properties || {})) o[k] = build(v, k, index, count);
        return o;
      }
      case 'array': {
        const n = Math.max(1, Math.min(20, ids.length || 3));
        return Array.from({ length: n }, (_, i) => build(s.items, name, i, n));
      }
      case 'string':
        if (name !== 'sid' && name !== 'id') return `모의 ${name || '값'}`;
        return ids.length ? ids[Math.floor((index * ids.length) / Math.max(1, count))] : 'p1-0';
      case 'integer':
      case 'number': return index;
      case 'boolean': return index % 2 === 0;
      default: return null;
    }
  };
  return build(schema, '', 0, 1);
}

// ───────────────────────────── plumbing ─────────────────────────────

/** Log a request and count it as in flight (`concurrent` = requests in flight including this one). */
function begin(kind, opts) {
  mockControl.inFlight += 1;
  mockControl.maxInFlight = Math.max(mockControl.maxInFlight, mockControl.inFlight);
  const user = lastUserText(opts.messages);
  const items = opts.json?.properties?.translations ? parseTranslationUserMessage(user).items : [];
  const req = {
    kind,
    task: opts.task || null,
    model: opts.model,
    effort: opts.effort || null,
    maxTokens: opts.maxTokens,
    system: opts.system,
    messages: opts.messages,
    json: opts.json || null,
    ids: items.map((i) => i.sid),
    items,
    concurrent: mockControl.inFlight,
    startedAt: performance.now(),
    endedAt: null,
  };
  mockControl.requests.push(req);
  return req;
}

function end(req) {
  mockControl.inFlight -= 1;
  req.endedAt = performance.now();
}

function takeInjectedFailure(req) {
  const f = mockControl.failNext.shift() || mockControl.failWhen?.(req) || null;
  if (!f) return;
  const messages = {
    max_tokens: '응답이 최대 길이에 도달해 잘렸습니다(모의).',
    refusal: 'AI가 이 요청에 대한 답변을 거절했습니다(모의).',
    rate_limit: '요청이 너무 많습니다(모의). 잠시 후 다시 시도해 주세요.',
    auth: 'API 키가 올바르지 않습니다(모의).',
    network: '네트워크에 연결할 수 없습니다(모의).',
  };
  throw aiError(f.message || messages[f.code] || '모의 오류가 발생했습니다.', {
    code: f.code || 'unknown', ...(f.partialText != null ? { partialText: f.partialText } : {}),
  });
}

/** Sentence ids like p3-12 that appear in the system prompt or messages, in order of first appearance. */
function citedIds(opts) {
  const text = `${systemText(opts.system)}\n${(opts.messages || []).map((m) => contentText(m.content)).join('\n')}`;
  return [...new Set([...text.matchAll(/\[(p\d+-\d+)\]/g)].map((m) => m[1]))];
}

function fakeUsage(opts, outputText) {
  const sys = systemText(opts.system);
  const msgs = (opts.messages || []).map((m) => contentText(m.content)).join('\n');
  const cacheable = Array.isArray(opts.system) && opts.system.some((b) => b.cache);
  const sysTokens = Math.ceil(sys.length / 4);
  const msgTokens = Math.ceil(msgs.length / 4);
  const usage = {
    model: mockControl.reportModel || 'mock',
    inputTokens: msgTokens,
    outputTokens: Math.ceil(String(outputText || '').length / 2),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  if (!cacheable) usage.inputTokens += sysTokens;
  else {
    const key = `${opts.model}|${hash(sys)}`;
    if (cachedPrefixes.has(key)) usage.cacheReadTokens = sysTokens;
    else { usage.cacheWriteTokens = sysTokens; cachedPrefixes.add(key); }
  }
  return usage;
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text || '').join('\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return contentText(messages[i].content);
  }
  return '';
}

function delay(ms, signal) {
  throwIfAborted(signal);
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(aiError('요청을 취소했습니다.', { code: 'aborted' }));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

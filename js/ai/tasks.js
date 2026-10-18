// Paper-level AI tasks. All answers are Korean Markdown and may cite sentences as [p3-12] (the UI links them).
// Stream protocol for chat/explain: yields text chunks (strings), and finally { done: true, usage, model }.
import { settings } from '../core/settings.js';
import { aiError, getProvider, throwIfAborted } from './providers.js';
import {
  assistSystem, chatQuestion, explainPrompt, KEY_POINT_CATEGORIES, KEYPOINTS_SCHEMA, keyPointsPrompt,
  quickTranslateSystem, summaryPrompt,
} from './prompts.js';
import { recordUsage } from './usage.js';

const KEY_POINTS_MAX = 25;
const KEY_POINT_KINDS = new Set(['body', 'caption']);
const MAX_HISTORY_MESSAGES = 20;
const NEARBY_SENTENCES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude's per-image limit
const TRUNCATED_NOTE = '\n\n> (응답이 최대 길이에 도달해 일부가 잘렸습니다.)';

/**
 * Structured Korean summary of the paper.
 * @param {object} doc PaperDoc
 * @param {{ signal?: AbortSignal, paperId?: string }} [opts]
 * @returns {Promise<{ markdown: string, usage: object, model: string }>}
 */
export async function summarize(doc, { signal, paperId } = {}) {
  requireText(doc);
  const model = settings.model('assist');
  const res = await getProvider().complete({
    task: 'summary', model, system: assistSystem(doc),
    messages: [{ role: 'user', content: summaryPrompt() }],
    maxTokens: 16000, effort: 'medium', signal,
  });
  recordUsage(res.usage, { paperId, task: 'summary' });
  const markdown = res.text.trim();
  if (!markdown) throw aiError('요약 결과가 비어 있습니다. 다시 시도해 주세요.', { code: 'parse' });
  return { markdown: res.stopReason === 'max_tokens' ? markdown + TRUNCATED_NOTE : markdown, usage: res.usage, model };
}

/**
 * Streamed answer to a question about the paper.
 * @param {object} doc PaperDoc
 * @param {{ role: 'user'|'assistant', content: string }[]} history earlier turns (oldest first)
 * @param {string} question
 * @param {{ signal?: AbortSignal, quote?: string, paperId?: string }} [opts]
 */
export async function* chat(doc, history, question, { signal, quote, paperId } = {}) {
  if (!String(question || '').trim()) throw aiError('질문을 입력해 주세요.', { code: 'bad_request' });
  const messages = [...normalizeHistory(history), { role: 'user', content: chatQuestion(question, quote) }];
  yield* streamTask({
    task: 'chat', model: settings.model('assist'), system: assistSystem(doc), messages,
    maxTokens: 32000, effort: 'medium', signal,
  }, { paperId });
}

/**
 * Streamed explanation of a selected passage and/or a captured figure region.
 * @param {object} doc PaperDoc
 * @param {{ quote?: string, imageDataUrl?: string, nearSid?: string }} target
 * @param {{ signal?: AbortSignal, paperId?: string }} [opts]
 */
export async function* explain(doc, { quote, imageDataUrl, nearSid } = {}, { signal, paperId } = {}) {
  const text = String(quote || '').trim();
  if (!text && !imageDataUrl) throw aiError('설명할 텍스트나 그림 영역을 먼저 선택해 주세요.', { code: 'bad_request' });
  const content = [];
  if (imageDataUrl) content.push({ type: 'image', ...parseImageDataUrl(imageDataUrl) });
  content.push({ type: 'text', text: explainPrompt({ quote: text, hasImage: Boolean(imageDataUrl), nearby: nearbySentences(doc, nearSid) }) });
  yield* streamTask({
    task: 'explain', model: settings.model('assist'), system: assistSystem(doc),
    messages: [{ role: 'user', content }], maxTokens: 16000, effort: 'medium', signal,
  }, { paperId });
}

/**
 * Sentences worth underlining (at most ~25, spread across the paper), with a category each.
 * @param {object} doc PaperDoc
 * @param {{ signal?: AbortSignal, paperId?: string }} [opts]
 * @returns {Promise<{ items: { sid: string, category: string }[], usage: object, model: string }>}
 */
export async function keyPoints(doc, { signal, paperId } = {}) {
  requireText(doc);
  const model = settings.model('assist');
  const res = await getProvider().complete({
    task: 'keyPoints', model, system: assistSystem(doc),
    messages: [{ role: 'user', content: keyPointsPrompt(KEY_POINTS_MAX) }],
    json: KEYPOINTS_SCHEMA, maxTokens: 8000, effort: 'low', signal,
  });
  recordUsage(res.usage, { paperId, task: 'keyPoints' });
  return { items: selectKeyPoints(doc, res.json?.items, KEY_POINTS_MAX), usage: res.usage, model };
}

/**
 * Translate an arbitrary passage (selection menu "번역").
 * @param {string} text
 * @param {{ signal?: AbortSignal, paperId?: string }} [opts]
 * @returns {Promise<{ text: string, usage: object }>}
 */
export async function quickTranslate(text, { signal, paperId } = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) throw aiError('번역할 텍스트를 선택해 주세요.', { code: 'bad_request' });
  const res = await getProvider().complete({
    task: 'quickTranslate', model: settings.model('translate'),
    system: quickTranslateSystem(settings.get().translate || {}),
    messages: [{ role: 'user', content: source }],
    maxTokens: 8000, effort: 'low', signal,
  });
  recordUsage(res.usage, { paperId, task: 'quickTranslate' });
  const out = res.text.trim();
  return { text: res.stopReason === 'max_tokens' ? out + TRUNCATED_NOTE : out, usage: res.usage };
}

// ───────────────────────────── helpers ─────────────────────────────

async function* streamTask(opts, { paperId }) {
  throwIfAborted(opts.signal);
  let usage = null;
  let stopReason = null;
  for await (const ev of getProvider().stream(opts)) {
    if (ev.type === 'text' && ev.text) yield ev.text;
    else if (ev.type === 'done') ({ usage, stopReason } = ev);
  }
  if (usage) recordUsage(usage, { paperId, task: opts.task });
  if (stopReason === 'max_tokens') yield TRUNCATED_NOTE;
  yield { done: true, usage, model: opts.model };
}

/** Keep the last turns, start with a user turn, merge consecutive same-role turns, drop empty ones. */
export function normalizeHistory(history) {
  const turns = [];
  for (const h of (history || []).slice(-MAX_HISTORY_MESSAGES)) {
    const role = h?.role === 'assistant' ? 'assistant' : h?.role === 'user' ? 'user' : null;
    const content = typeof h?.content === 'string' ? h.content.trim() : '';
    if (!role || !content) continue;
    const last = turns[turns.length - 1];
    if (last?.role === role) last.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  // A trailing user turn is an unanswered question (e.g. its answer failed): drop it so roles keep alternating.
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
  return turns;
}

/**
 * Validate model-picked key points: existing body/caption sentences, known category, no duplicates, reading
 * order; if there are more than `max`, keep an evenly spaced subset so the marks stay spread across the paper.
 */
export function selectKeyPoints(doc, items, max = KEY_POINTS_MAX) {
  const order = new Map((doc?.sentences || []).map((s, i) => [s.sid, i]));
  const byId = doc?.sentenceById instanceof Map ? doc.sentenceById : new Map((doc?.sentences || []).map((s) => [s.sid, s]));
  const seen = new Set();
  const valid = [];
  for (const it of Array.isArray(items) ? items : []) {
    const sid = typeof it?.sid === 'string' ? it.sid.trim().replace(/^\[|\]$/g, '') : '';
    const s = byId.get(sid);
    if (!s || !KEY_POINT_KINDS.has(s.kind) || seen.has(sid) || !KEY_POINT_CATEGORIES.includes(it.category)) continue;
    seen.add(sid);
    valid.push({ sid, category: it.category });
  }
  valid.sort((a, b) => order.get(a.sid) - order.get(b.sid));
  if (valid.length <= max) return valid;
  return Array.from({ length: max }, (_, i) => valid[Math.floor((i * valid.length) / max)]);
}

function nearbySentences(doc, sid) {
  if (!sid || !doc?.sentences) return [];
  const i = doc.sentences.findIndex((s) => s.sid === sid);
  if (i < 0) return [];
  return doc.sentences
    .slice(Math.max(0, i - NEARBY_SENTENCES), i + NEARBY_SENTENCES + 1)
    .filter((s) => s.kind !== 'furniture' && s.text)
    .map((s) => ({ sid: s.sid, text: s.text }));
}

function parseImageDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw aiError('그림 데이터를 읽지 못했습니다(PNG/JPEG/GIF/WebP만 지원).', { code: 'bad_request' });
  const data = m[2].replace(/\s+/g, '');
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) {
    throw aiError('선택한 영역의 이미지가 너무 큽니다(최대 5MB). 더 작은 영역을 선택해 주세요.', { code: 'bad_request' });
  }
  return { mediaType: m[1], data };
}

function requireText(doc) {
  if (!doc?.sentences?.some((s) => s.kind !== 'furniture' && s.text)) {
    throw aiError('이 PDF에서 텍스트를 추출하지 못해 AI 기능을 사용할 수 없습니다(스캔본일 수 있습니다).', { code: 'bad_request' });
  }
}

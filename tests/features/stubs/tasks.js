// Stub of js/ai/tasks.js (SPEC 3.4) with canned Korean output. Calls are recorded on
// window.__taskCalls; per-chunk delay is window.__chunkDelay (ms). Never touches the network.
import { sidOf } from './doc.js';

const calls = (window.__taskCalls ||= []);
const usage = { model: 'mock', inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('중단', 'AbortError')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('중단', 'AbortError')); }, { once: true });
  });
}

async function* words(text, signal) {
  const parts = text.match(/\S+\s*|\s+/g) || [];
  for (const p of parts) {
    await sleep(window.__chunkDelay ?? 35, signal);
    yield p;
  }
}

export async function summarize(doc, { signal } = {}) {
  calls.push({ fn: 'summarize' });
  await sleep(window.__summaryDelay ?? 300, signal);
  const s = (needle) => sidOf(doc, needle);
  const markdown = [
    '## 연구 목적',
    `인공호흡기를 적용한 성인 중환자에서 **간호사 주도 조기 운동 프로토콜**이 섬망 발생을 줄이는지 평가했다 [${s('We evaluated whether')}].`,
    '',
    '## 방법',
    `- 설계: 6개 중환자실의 계단식(stepped-wedge) 군집 무작위 시험 [${s('stepped-wedge')}]`,
    `- 대상: 48시간 넘게 인공호흡기를 적용한 성인 412명 [${s('412 patients')}]`,
    `- 측정: 훈련받은 간호사가 하루 두 번 CAM-ICU로 섬망 평가 [${s('CAM-ICU')}]`,
    '',
    '## 주요 결과',
    `- 섬망 발생률 **28% vs 41%** (위험비 0.68) [${s('Delirium occurred in 28%')}]`,
    `- 첫 운동 시점 중앙값 2.1일 vs 4.5일, 섬망 없는 날 평균 1.8일 증가 [${s('mobilized earlier')}][${s('Delirium-free days')}]`,
    '',
    '## 한계',
    `결과 평가자 눈가림이 불가능했고, 자원이 적은 지역 병원에서의 검증이 필요하다 [${s('A key limitation')}].`,
    '',
    '## 임상·연구적 시사점',
    `매일 하는 **운동 허들**이 프로토콜 준수를 높였다 [${s('mobility huddles')}]. 간호 인력 부족이 가장 큰 장애 요인이었다 [${s('Staffing shortages')}] [p99-1].`,
  ].join('\n');
  return { markdown, usage };
}

function chatAnswer(doc, question) {
  const s = (needle) => sidOf(doc, needle);
  if (/xss/i.test(question)) {
    return '위험한 출력 테스트: <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script> '
      + '[링크](javascript:window.__xss=3) <a href="https://example.org" onclick="window.__xss=4">외부</a> 끝.';
  }
  return [
    `이 연구에서 섬망은 프로토콜군 **28%**, 일반 치료군 **41%**에서 발생했습니다 [${s('Delirium occurred in 28%')}].`,
    '',
    '간호 실무 관점에서 핵심은 다음과 같습니다.',
    '',
    `1. 병상 간호사가 **매일 운동 허들**을 주도할 때 준수율이 가장 높았습니다 [${s('mobility huddles')}].`,
    `2. 첫 운동까지 걸린 시간이 2.1일로 짧아졌습니다 [${s('mobilized earlier')}].`,
    `3. 우발적 발관 같은 심각한 이상 사건은 없었습니다 [${s('accidental extubation')}].`,
    '',
    '다만 평가자 눈가림이 불가능했다는 한계가 있습니다.',
  ].join('\n');
}

export async function* chat(doc, history, question, { signal, quote } = {}) {
  calls.push({ fn: 'chat', history, question, quote });
  yield* words(chatAnswer(doc, question), signal);
  yield { done: true, usage };
}

export async function* explain(doc, { quote, imageDataUrl, nearSid } = {}, { signal } = {}) {
  calls.push({ fn: 'explain', quote, hasImage: Boolean(imageDataUrl), nearSid });
  const text = imageDataUrl
    ? `이 그림은 프로토콜의 **네 단계 운동 수준**을 보여 줍니다 [${nearSid ?? 'p2-4'}].\n\n`
      + '- 1단계: 수동 관절 가동 범위 운동\n- 2단계: 침상 앉기\n- 3단계: 의자로 이동\n- 4단계: 보행\n\n'
      + '막대가 높을수록 환자의 능동 참여가 큽니다.'
    : `**선택한 문장 설명**: 섬망(delirium)은 급성으로 생기는 주의력·인지 장애입니다 [${nearSid ?? 'p1-2'}].\n\n`
      + '인공호흡기 환자에게 특히 흔하며, 사망률·재원 기간 증가와 관련됩니다. '
      + '간호사는 CAM-ICU 같은 도구로 매일 선별할 수 있습니다.';
  yield* words(text, signal);
  yield { done: true, usage };
}

export async function keyPoints(doc, { signal } = {}) {
  calls.push({ fn: 'keyPoints' });
  await sleep(window.__keyPointsDelay ?? 250, signal);
  const pick = (needle, category) => ({ sid: sidOf(doc, needle), category });
  return {
    items: [
      pick('We evaluated whether', 'contribution'),
      pick('Delirium occurred in 28%', 'result'),
      pick('mobilized earlier', 'result'),
      pick('stepped-wedge', 'method'),
      pick('four mobility levels', 'definition'),
      pick('A key limitation', 'limitation'),
      { sid: 'p99-9', category: 'result' },             // unknown sentence → must be dropped
      { sid: sidOf(doc, 'CAM-ICU'), category: 'bogus' }, // unknown category → must be dropped
    ],
    usage,
  };
}

export async function quickTranslate(text, { signal } = {}) {
  calls.push({ fn: 'quickTranslate', text });
  await sleep(window.__translateDelay ?? 200, signal);
  return { text: `〔빠른 번역〕 ${text.length > 80 ? '선택한 영어 문장을 자연스러운 한국어로 옮긴 결과입니다.' : '짧은 문장의 번역입니다.'}`, usage };
}

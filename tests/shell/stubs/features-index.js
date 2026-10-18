// Test stub for js/features/index.js — minimal panels + toolbar buttons that exercise the feature host ctx.
import { el } from '/js/core/util.js';
import { renderMarkdown, toast } from '/js/ui/components.js';

const SUMMARY_MD = `## 한눈에 보기
- **목적**: 간호사 주도 섬망 예방 번들의 효과 검증 [p1-4]
- **방법**: 8개 중환자실 군집 무작위 시험 [p2-2, p2-3]
- **결과**: 섬망 발생률 18.4% 대 29.7% [p3-3]

| 항목 | 번들군 | 일반 치료군 |
|---|---|---|
| 섬망 발생 | 18.4% | 29.7% |

> 한계: 평가자 눈가림이 되지 않았다 [p4-6].`;

export const panels = [
  {
    id: 'summary', title: '요약', icon: 'sparkles',
    mount(container, ctx) {
      const body = el('div', { class: 'md', style: { padding: '18px 22px', fontSize: '15px' } });
      container.append(body);
      renderMarkdown(SUMMARY_MD).then((frag) => body.replaceChildren(frag));
      window.__summaryMounted = (window.__summaryMounted || 0) + 1;
      return { onShow() { window.__summaryShown = (window.__summaryShown || 0) + 1; }, destroy() { window.__summaryDestroyed = true; } };
    },
  },
  {
    id: 'chat', title: '채팅', icon: 'message',
    mount(container) {
      container.append(el('div', { style: { padding: '18px 22px' } }, el('p', { class: 'muted' }, '논문에 대해 질문해 보세요. (테스트 스텁)')));
      return {};
    },
  },
  {
    id: 'notes', title: '메모', icon: 'note',
    mount(container) {
      container.append(el('div', { style: { padding: '18px 22px' } }, el('p', { class: 'muted' }, '하이라이트와 메모가 여기에 모입니다. (테스트 스텁)')));
      return {};
    },
  },
  {
    id: 'related', title: '관련 논문', icon: 'link',
    mount() { throw new Error('관련 논문 서비스에 연결할 수 없습니다 (테스트용 오류)'); },
  },
];

export function installReaderFeatures(ctx) {
  window.__featureCtx = ctx;
  const ann = [{ id: 'a1', start: ctx.doc.sentenceById.get('p1-9').start, end: ctx.doc.sentenceById.get('p1-9').end, color: 'yellow', style: 'fill', title: '메모: 핵심 통계' },
    { id: 'a2', start: ctx.doc.sentenceById.get('p1-13').start, end: ctx.doc.sentenceById.get('p1-13').end, color: 'green', style: 'fill' }];
  ctx.viewer.setMarks('annotations', ann);
  ctx.pane.setMarks('annotations', ann);
  const auto = ['p1-4', 'p1-8', 'p3-3'].map((sid, i) => {
    const s = ctx.doc.sentenceById.get(sid);
    return { id: `k${i}`, start: s.start, end: s.end, color: 'blue', style: 'underline', title: '핵심: 결과' };
  });
  const hl = ctx.addToolbarButton({
    id: 'autohl', icon: 'underline', title: '핵심 밑줄', toggle: true,
    onClick(active) {
      ctx.viewer.setMarks('auto', active ? auto : []);
      ctx.pane.setMarks('auto', active ? auto : []);
      window.__autoActive = active;
    },
  });
  ctx.addToolbarButton({
    id: 'capture', icon: 'image', title: '그림·표 설명', toggle: true,
    onClick(active) {
      ctx.viewer.setRegionCapture(active);
      if (active) toast('설명할 그림이나 표 영역을 드래그하세요.');
    },
  });
  window.__hlHandle = hl;
  return { dispose() { window.__featuresDisposed = true; } };
}


// Small DOM pieces shared by the 관련 논문 panel and the reference card. External text (titles,
// abstracts, author names) only ever goes in as text nodes.
import { el } from '../core/util.js';
import { paperLinks } from './scholarly.js';
import { externalLink } from './shared.js';

/** "Label: text" lines (structured abstracts) → paragraphs with a bold label; plain lines otherwise. */
export function abstractNodes(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^([A-Za-z][A-Za-z ,&/()-]{1,48}):\s+(.+)$/);
    return m ? el('p', {}, el('strong', {}, `${m[1]}: `), m[2]) : el('p', {}, line);
  });
}

/** 무료 전문 / PubMed / DOI (/ Semantic Scholar) link badges, or null when there is no link. */
export function linkBadges(p, className = 'pf-related__links') {
  const links = paperLinks(p);
  if (!links.length) return null;
  return el('div', { class: className }, links.map((l) => {
    const a = externalLink(l.href, l.label);
    a.className = `pf-linkbadge pf-linkbadge--${l.kind}`;
    a.dataset.link = l.kind;
    return a;
  }));
}

// Extra CSS for the PubMed-based 관련 논문 panel and reference card (sort/folder controls, link badges,
// sectioned abstracts, consent box). Injected once next to styles.js; uses the same --pf-* tokens.

const STYLE_ID = 'pr-features-related-css';

const CSS = String.raw`
.pf-related__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 8px; }
.pf-related__sort { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.pf-related__tools .pf-spacer { min-width: 4px; }
.pf-related__source { font-size: 12px; color: var(--pf-fg-muted); margin: 0 0 4px; line-height: 1.5; }
.pf-related__meta { font-size: 12px; color: var(--pf-fg-muted); line-height: 1.5; }
.pf-related__cites { color: var(--pf-fg); font-weight: 600; }
.pf-related__links, .pf-cite__links { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.pf-linkbadge { display: inline-flex; align-items: center; font-size: 11.5px; line-height: 1.2; padding: 3px 8px; border-radius: 999px;
  border: 1px solid var(--pf-border); color: var(--pf-fg-muted); background: var(--pf-bg); text-decoration: none; white-space: nowrap; }
.pf-linkbadge:hover { border-color: var(--pf-accent); color: var(--pf-accent); }
.pf-linkbadge--free { border-color: var(--pf-hl-green-strong); color: var(--pf-hl-green-strong); font-weight: 600; }
.pf-related__absbox { margin: 6px 0 2px; }
.pf-related__absbox p, .pf-cite__abs p { margin: 0 0 4px; font-size: 13px; line-height: 1.6; }
.pf-related__absbox strong, .pf-cite__abs strong { font-weight: 700; }
.pf-related__folder-note { font-size: 12px; color: var(--pf-fg-muted); }
.pf-related__consent { text-align: left; max-width: 520px; margin: 0 auto; }
.pf-related__consent .pf-empty__title { text-align: center; }
.pf-related__consent ul { margin: 6px 0 12px; padding-left: 18px; font-size: 13px; line-height: 1.6; }
.pf-related__consent .pf-row { justify-content: center; }
.pf-cite__abs { white-space: normal; }
.pf-cite__source { margin-top: 6px; font-size: 11.5px; color: var(--pf-fg-muted); }
.pf-cite__consent p { margin: 0 0 8px; line-height: 1.5; }
`;

/** Inject the related-papers stylesheet once (idempotent). */
export function ensureRelatedStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

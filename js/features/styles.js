// Feature-scoped CSS (pf-* classes), injected once. Features own no stylesheet file, so their
// look lives here. Colours are --pf-* tokens that inherit the shell's design tokens (css/app.css:
// --surface, --text, --accent, --mark-*) and fall back to built-in light/dark values when the
// shell stylesheet is absent (tests). See docs/notes/features.md.

const STYLE_ID = 'pr-features-css';

const CSS = String.raw`
:root {
  --pf-bg: var(--surface, #ffffff); --pf-bg-soft: var(--surface-2, #f6f7f9); --pf-bg-sunk: var(--surface-3, #eef1f4);
  --pf-fg: var(--text, #1f2328); --pf-fg-muted: var(--text-3, #626b75);
  --pf-border: var(--border, #dfe3e8); --pf-border-strong: var(--border-strong, #c9cfd6);
  --pf-accent: var(--accent, #2f6feb); --pf-accent-fg: var(--text-on-accent, #ffffff);
  --pf-accent-soft: var(--accent-soft, rgba(47, 111, 235, 0.10)); --pf-accent-text: var(--accent-text, #2f6feb);
  --pf-danger: var(--danger, #cf222e); --pf-danger-soft: var(--danger-soft, rgba(207, 34, 46, 0.08));
  --pf-radius: var(--radius, 10px); --pf-radius-sm: var(--radius-sm, 6px);
  --pf-shadow: var(--shadow-lg, 0 10px 30px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08));
  --pf-hl-yellow: var(--mark-yellow, #ffe066); --pf-hl-green: var(--mark-green, #8ce99a);
  --pf-hl-blue: var(--mark-blue, #a5d8ff); --pf-hl-pink: var(--mark-pink, #fcc2d7);
  --pf-hl-yellow-strong: var(--mark-yellow-line, #f2b705); --pf-hl-green-strong: var(--mark-green-line, #2f9e44);
  --pf-hl-blue-strong: var(--mark-blue-line, #1c7ed6); --pf-hl-pink-strong: var(--mark-pink-line, #d6336c);
}
:root[data-theme="dark"] {
  --pf-bg: var(--surface, #1d2127); --pf-bg-soft: var(--surface-2, #242930); --pf-bg-sunk: var(--surface-3, #161a1f);
  --pf-fg: var(--text, #e6e8eb); --pf-fg-muted: var(--text-3, #9aa3ad);
  --pf-border: var(--border, #343a42); --pf-border-strong: var(--border-strong, #464e58);
  --pf-accent: var(--accent, #5b8ff9); --pf-accent-fg: var(--text-on-accent, #0d1117);
  --pf-accent-soft: var(--accent-soft, rgba(91, 143, 249, 0.16)); --pf-accent-text: var(--accent-text, #8fb0ff);
  --pf-danger: var(--danger, #ff7b72); --pf-danger-soft: var(--danger-soft, rgba(255, 123, 114, 0.12));
  --pf-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.35));
  --pf-hl-yellow: var(--mark-yellow, #8a7300); --pf-hl-green: var(--mark-green, #2b6e3a);
  --pf-hl-blue: var(--mark-blue, #24578a); --pf-hl-pink: var(--mark-pink, #8a2f55);
}

/* ---------- shared ---------- */
.pf-muted { color: var(--pf-fg-muted); }
.pf-small { font-size: 12px; }
.pf-spacer { flex: 1 1 auto; }
.pf-row { display: flex; gap: 8px; align-items: center; }
.pf-error { color: var(--pf-danger); margin: 6px 0; }
.pf-error-box { border: 1px solid var(--pf-danger); background: var(--pf-danger-soft); color: var(--pf-fg);
  border-radius: var(--pf-radius); padding: 12px 14px; margin: 12px 0; }
.pf-error-box p { margin: 0 0 8px; }
.pf-loading { display: inline-flex; align-items: center; gap: 8px; color: var(--pf-fg-muted); padding: 6px 0; }
.pf-empty { text-align: center; padding: 28px 16px; color: var(--pf-fg); }
.pf-empty p { margin: 0 0 10px; line-height: 1.6; }
.pf-empty__title { font-weight: 600; }
.pf-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font: inherit; font-size: 13px;
  line-height: 1; padding: 8px 12px; border-radius: var(--pf-radius-sm); border: 1px solid var(--pf-border-strong);
  background: var(--pf-bg); color: var(--pf-fg); cursor: pointer; text-decoration: none; white-space: nowrap; }
.pf-btn:hover:not(:disabled) { background: var(--pf-bg-soft); }
.pf-btn:disabled { opacity: .5; cursor: default; }
.pf-btn--sm { font-size: 12px; padding: 6px 9px; }
.pf-btn--primary { background: var(--pf-accent); border-color: var(--pf-accent); color: var(--pf-accent-fg); }
.pf-btn--primary:hover:not(:disabled) { background: var(--pf-accent); filter: brightness(1.08); }
.pf-btn--danger { color: var(--pf-danger); border-color: var(--pf-danger); }
.pf-btn--danger:hover:not(:disabled) { background: var(--pf-danger-soft); }
.pf-btn[hidden], .pf-panel [hidden] { display: none !important; }
.pf-link-btn { font: inherit; font-size: 12px; background: none; border: 0; padding: 2px 4px; color: var(--pf-accent);
  cursor: pointer; border-radius: 4px; }
.pf-link-btn:hover:not(:disabled) { background: var(--pf-accent-soft); }
.pf-link-btn:disabled { color: var(--pf-fg-muted); cursor: default; }
.pf-link-btn--danger { color: var(--pf-danger); }
.pf-link-btn--danger:hover { background: var(--pf-danger-soft); }
.pf-icon-btn { font: inherit; font-size: 18px; line-height: 1; width: 26px; height: 26px; border-radius: 6px;
  border: 0; background: none; color: var(--pf-fg-muted); cursor: pointer; flex: none; }
.pf-icon-btn:hover { background: var(--pf-bg-sunk); color: var(--pf-fg); }
.pf-chip { font: inherit; font-size: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
  border-radius: 999px; border: 1px solid var(--pf-border); background: var(--pf-bg); color: var(--pf-fg); cursor: pointer;
  text-align: left; }
.pf-chip:hover { border-color: var(--pf-accent); }
.pf-chip.is-active { background: var(--pf-accent-soft); border-color: var(--pf-accent); color: var(--pf-accent); font-weight: 600; }
.pf-badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--pf-accent-soft); color: var(--pf-accent); }
.pf-input, .pf-textarea { font: inherit; font-size: 14px; color: var(--pf-fg); background: var(--pf-bg);
  border: 1px solid var(--pf-border-strong); border-radius: var(--pf-radius-sm); padding: 8px 10px; width: 100%; box-sizing: border-box; }
.pf-input:focus, .pf-textarea:focus, .pf-chat__input:focus { outline: 2px solid var(--pf-accent-soft); border-color: var(--pf-accent); }
.pf-textarea { resize: vertical; line-height: 1.5; }
.pf-swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; flex: none; }
.pf-swatch--yellow { background: var(--pf-hl-yellow); box-shadow: inset 0 0 0 1px var(--pf-hl-yellow-strong); }
.pf-swatch--green { background: var(--pf-hl-green); box-shadow: inset 0 0 0 1px var(--pf-hl-green-strong); }
.pf-swatch--blue { background: var(--pf-hl-blue); box-shadow: inset 0 0 0 1px var(--pf-hl-blue-strong); }
.pf-swatch--pink { background: var(--pf-hl-pink); box-shadow: inset 0 0 0 1px var(--pf-hl-pink-strong); }
.pf-swatch-btn { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; flex: none; }
.pf-swatch-btn:hover { transform: scale(1.12); }
.pf-swatch-btn.is-active { border-color: var(--pf-fg); }
.pf-swatches { display: inline-flex; gap: 6px; align-items: center; }

/* ---------- panels ---------- */
.pf-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--pf-fg); background: var(--pf-bg);
  font-size: 14px; }
.pf-panel__head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--pf-border); flex: none; }
.pf-panel__titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.pf-panel__title { font-size: 15px; font-weight: 700; margin: 0; }
.pf-panel__actions { display: flex; gap: 6px; flex: none; }
.pf-panel__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px 24px; overscroll-behavior: contain; }

/* markdown from the model */
.pf-md { line-height: 1.7; word-break: keep-all; overflow-wrap: anywhere; }
.pf-md > :first-child { margin-top: 0; }
.pf-md > :last-child { margin-bottom: 0; }
.pf-md h1, .pf-md h2 { font-size: 15px; margin: 20px 0 8px; padding-left: 10px; border-left: 3px solid var(--pf-accent); }
.pf-md h3 { font-size: 14px; margin: 16px 0 6px; }
.pf-md p { margin: 0 0 10px; }
.pf-md ul, .pf-md ol { margin: 0 0 10px; padding-left: 20px; }
.pf-md li { margin: 3px 0; }
.pf-md blockquote { margin: 0 0 10px; padding: 6px 12px; border-left: 3px solid var(--pf-border-strong); color: var(--pf-fg-muted); }
.pf-md code { font-size: 12.5px; background: var(--pf-bg-sunk); padding: 1px 5px; border-radius: 4px; }
.pf-md pre { background: var(--pf-bg-sunk); padding: 10px; border-radius: var(--pf-radius-sm); overflow-x: auto; }
.pf-md table { border-collapse: collapse; margin: 0 0 10px; font-size: 13px; }
.pf-md th, .pf-md td { border: 1px solid var(--pf-border); padding: 4px 8px; }
.pf-md a { color: var(--pf-accent); }
.pf-sid { display: inline-block; font-size: 11px; font-weight: 600; line-height: 1; padding: 3px 6px; margin: 0 2px;
  border-radius: 999px; background: var(--pf-accent-soft); color: var(--pf-accent-text) !important; text-decoration: none;
  cursor: pointer; vertical-align: 1px; white-space: nowrap; }
.pf-sid:hover, .pf-sid:focus-visible { background: var(--pf-accent); color: var(--pf-accent-fg) !important; outline: none; }
.pf-sid-missing { font-size: 11px; color: var(--pf-fg-muted); }

/* summary */
.pf-paper-card { padding: 12px 14px; border-radius: var(--pf-radius); background: var(--pf-bg-soft); margin-bottom: 12px; }
.pf-paper-card__title { font-weight: 600; line-height: 1.45; margin-bottom: 4px; }
.pf-toc { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.pf-summary__body h2:first-child { margin-top: 4px; }

/* chat */
.pf-chat__scroll { padding-bottom: 12px; }
.pf-chat__list { display: flex; flex-direction: column; gap: 12px; }
.pf-chat__intro { text-align: center; padding: 22px 4px; }
.pf-chat__intro p { margin: 0 0 8px; }
.pf-chat__suggest { display: flex; flex-direction: column; gap: 8px; align-items: stretch; margin-top: 14px; }
.pf-chat__suggest .pf-chip { border-radius: var(--pf-radius); padding: 9px 12px; font-size: 13px; }
.pf-msg { max-width: 92%; border-radius: 14px; padding: 10px 13px; line-height: 1.65; position: relative; }
.pf-msg--user { align-self: flex-end; background: var(--pf-accent); color: var(--pf-accent-fg); border-bottom-right-radius: 4px; }
.pf-msg--user .pf-msg__body { white-space: pre-wrap; }
.pf-msg--assistant { align-self: flex-start; background: var(--pf-bg-soft); border: 1px solid var(--pf-border); border-bottom-left-radius: 4px; }
.pf-msg--error { align-self: flex-start; border: 1px solid var(--pf-danger); background: var(--pf-danger-soft); }
.pf-msg__quote { margin: 0 0 6px; padding: 4px 8px; border-left: 3px solid rgba(255,255,255,.6); font-size: 12.5px; opacity: .92; }
.pf-msg__note { font-size: 12px; color: var(--pf-fg-muted); margin-top: 6px; }
.pf-msg__tools { position: absolute; right: 8px; bottom: -13px; display: flex; gap: 2px; padding: 1px 2px; border-radius: 6px;
  background: var(--pf-bg); border: 1px solid var(--pf-border); opacity: 0; pointer-events: none; transition: opacity .15s; }
.pf-msg:hover .pf-msg__tools, .pf-msg:focus-within .pf-msg__tools { opacity: 1; pointer-events: auto; }
.pf-msg--error .pf-msg__tools { position: static; opacity: 1; pointer-events: auto; border: 0; background: none; margin-top: 6px; }
.pf-msg.is-streaming .pf-msg__body::after { content: ''; display: inline-block; width: 7px; height: 14px; margin-left: 2px;
  vertical-align: -2px; background: var(--pf-accent); animation: pf-blink 1s steps(2) infinite; }
.pf-msg.is-streaming .pf-msg__body:empty::after { width: 7px; }
@keyframes pf-blink { 50% { opacity: 0; } }
.pf-chat__composer { flex: none; border-top: 1px solid var(--pf-border); padding: 10px 12px 12px; background: var(--pf-bg); }
.pf-chat__row { display: flex; gap: 8px; align-items: flex-end; }
.pf-chat__input { flex: 1; font: inherit; font-size: 14px; line-height: 1.5; resize: none; min-height: 38px; max-height: 160px;
  border: 1px solid var(--pf-border-strong); border-radius: var(--pf-radius); padding: 8px 10px; color: var(--pf-fg);
  background: var(--pf-bg); box-sizing: border-box; }
.pf-chat__row .pf-btn { height: 38px; }
.pf-chat__quote { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 6px 6px 6px 10px; border-radius: var(--pf-radius-sm);
  background: var(--pf-accent-soft); border-left: 3px solid var(--pf-accent); font-size: 12.5px; }
.pf-chat__quote-label { font-weight: 700; color: var(--pf-accent); flex: none; }
.pf-chat__quote-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* notes */
.pf-filter { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--pf-border); flex: none; }
.pf-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; margin-left: auto; color: var(--pf-fg-muted); cursor: pointer; }
.pf-notes__group + .pf-notes__group { margin-top: 18px; }
.pf-notes__page { font-size: 12px; font-weight: 700; color: var(--pf-fg-muted); margin: 0 0 8px; letter-spacing: .02em; }
.pf-note { border: 1px solid var(--pf-border); border-left-width: 4px; border-radius: var(--pf-radius-sm); padding: 10px 12px 6px;
  margin-bottom: 8px; cursor: pointer; background: var(--pf-bg); }
.pf-note:hover { background: var(--pf-bg-soft); }
.pf-note:focus-visible { outline: 2px solid var(--pf-accent); }
.pf-note.is-editing { cursor: default; background: var(--pf-bg-soft); }
.pf-note--yellow { border-left-color: var(--pf-hl-yellow-strong); }
.pf-note--green { border-left-color: var(--pf-hl-green-strong); }
.pf-note--blue { border-left-color: var(--pf-hl-blue-strong); }
.pf-note--pink { border-left-color: var(--pf-hl-pink-strong); }
.pf-note__quote { margin: 0; font-size: 13px; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.pf-note__note { margin-top: 8px; font-size: 13px; }
.pf-note__note p { margin: 0; padding: 6px 9px; background: var(--pf-bg-sunk); border-radius: var(--pf-radius-sm); white-space: pre-wrap; }
.pf-note__edit-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.pf-note__foot { display: flex; align-items: center; gap: 4px; margin-top: 6px; }

/* related */
.pf-related__match { padding: 10px 12px; border-radius: var(--pf-radius); background: var(--pf-bg-soft); margin-bottom: 14px; line-height: 1.5; }
.pf-related__match-title { font-weight: 600; margin: 2px 0; }
.pf-related__list { list-style: none; margin: 0; padding: 0; counter-reset: rel; }
.pf-related__item { padding: 12px 0; border-bottom: 1px solid var(--pf-border); }
.pf-related__title { font-weight: 600; line-height: 1.45; margin-bottom: 3px; }
.pf-related__title a, .pf-related__match a, .pf-cite__title a { color: var(--pf-fg); text-decoration: none; }
.pf-related__title a:hover, .pf-related__match a:hover, .pf-cite__title a:hover { color: var(--pf-accent); text-decoration: underline; }
.pf-related__abs { font-size: 13px; line-height: 1.6; margin: 6px 0 2px; color: var(--pf-fg); }
.pf-related__abs.is-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pf-related__ko { font-size: 13px; background: var(--pf-accent-soft); border-radius: var(--pf-radius-sm); padding: 8px 10px; margin-top: 6px; }
.pf-related__actions { display: flex; gap: 4px; margin-top: 4px; }
.pf-related__search .pf-row { max-width: 520px; margin: 12px auto 8px; }

/* ---------- popovers (selection menu, quick translate, link previews) ---------- */
/* The shell's .popover caps width at 400px and pads 6px; our contents pad themselves. */
.popover.pf-pop { padding: 0; max-width: min(560px, calc(100vw - 16px)); }
.pf-selmenu { display: flex; flex-direction: column; gap: 6px; padding: 6px; font-size: 13px; color: var(--pf-fg); }
.pf-selmenu:not(.pf-selmenu--mark), .pf-selmenu__row { display: flex; flex-direction: row; align-items: center; gap: 2px; flex-wrap: wrap; }
.pf-selmenu__colors { display: inline-flex; gap: 5px; padding: 0 6px 0 4px; }
.pf-selmenu__btn { font: inherit; font-size: 13px; background: none; border: 0; color: var(--pf-fg); padding: 6px 9px; border-radius: 6px;
  cursor: pointer; white-space: nowrap; }
.pf-selmenu__btn:hover { background: var(--pf-bg-sunk); }
.pf-selmenu__btn.is-danger { color: var(--pf-danger); }
.pf-selmenu__btn.is-danger:hover { background: var(--pf-danger-soft); }
.pf-selmenu__sep { width: 1px; height: 20px; background: var(--pf-border); margin: 0 4px; }
.pf-selmenu__note { margin: 0 4px 2px; padding: 6px 9px; font-size: 12.5px; background: var(--pf-bg-sunk); border-radius: var(--pf-radius-sm);
  max-width: 460px; white-space: pre-wrap; }
.pf-noteedit, .pf-qt, .pf-cite { width: min(400px, calc(100vw - 32px)); padding: 10px 12px; box-sizing: border-box; color: var(--pf-fg); font-size: 13px; }
.pf-cite--preview { width: auto; }
.pf-pop__head { font-weight: 700; font-size: 13px; margin-bottom: 6px; }
.pf-pop__quote { margin: 0 0 8px; padding: 4px 10px; border-left: 3px solid var(--pf-border-strong); color: var(--pf-fg-muted);
  font-size: 12.5px; line-height: 1.5; }
.pf-pop__foot { display: flex; gap: 6px; justify-content: flex-end; align-items: center; margin-top: 10px; }
.pf-qt__body { line-height: 1.65; font-size: 14px; max-height: 40vh; overflow-y: auto; }
.pf-qt__body p:last-child { margin-bottom: 0; }
.pf-cite__text { margin: 0; line-height: 1.55; max-height: 30vh; overflow-y: auto; }
.pf-cite__url { word-break: break-all; color: var(--pf-fg-muted); }
.pf-cite__s2:not(:empty) { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--pf-border); }
.pf-cite__title { font-weight: 600; line-height: 1.45; margin-bottom: 2px; }
.pf-cite__abs { margin: 6px 0 0; line-height: 1.55; max-height: 24vh; overflow-y: auto; }
.pf-cite__frame { max-width: calc(100vw - 48px); border: 1px solid var(--pf-border); border-radius: var(--pf-radius-sm);
  background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.pf-cite__canvas { display: block; width: 100%; height: auto; }

/* ---------- explanation side card ---------- */
.pf-card { position: fixed; z-index: 60; display: flex; flex-direction: column; max-height: min(640px, calc(100vh - 140px));
  background: var(--pf-bg); color: var(--pf-fg); border: 1px solid var(--pf-border); border-radius: 12px; box-shadow: var(--pf-shadow);
  font-size: 14px; }
.pf-card.is-dragging { user-select: none; opacity: .96; }
.pf-card__head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--pf-border);
  cursor: grab; flex: none; }
.pf-card.is-dragging .pf-card__head { cursor: grabbing; }
.pf-card__title { font-size: 14px; }
.pf-card__body { padding: 12px 14px; overflow-y: auto; min-height: 60px; }
.pf-card__foot { display: flex; gap: 6px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--pf-border); flex: none; flex-wrap: wrap; }
.pf-card__foot:empty { display: none; }
.pf-explain__quote { margin: 0 0 12px; padding: 6px 10px; border-left: 3px solid var(--pf-hl-yellow-strong); background: var(--pf-bg-soft);
  font-size: 12.5px; line-height: 1.55; color: var(--pf-fg-muted); border-radius: 0 6px 6px 0; }
.pf-explain__figure { margin: 0 0 12px; border: 1px solid var(--pf-border); border-radius: var(--pf-radius-sm); overflow: hidden; background: #fff; }
.pf-explain__figure img { display: block; width: 100%; height: auto; max-height: 220px; object-fit: contain; }
.pf-explain.is-streaming .pf-explain__answer > :last-child::after { content: ''; display: inline-block; width: 7px; height: 14px;
  margin-left: 2px; vertical-align: -2px; background: var(--pf-accent); animation: pf-blink 1s steps(2) infinite; }

/* ---------- key-sentence legend ---------- */
.pf-kp-legend { position: fixed; z-index: 55; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; max-width: calc(100vw - 32px);
  padding: 6px 6px 6px 12px; border-radius: 14px; background: var(--pf-bg); color: var(--pf-fg); border: 1px solid var(--pf-border);
  box-shadow: var(--pf-shadow); font-size: 12.5px; box-sizing: border-box; }
.pf-kp-legend__title { font-weight: 700; margin-right: 2px; }
.pf-kp-legend .pf-loading { padding: 0 6px 0 0; }
.pf-kp-chip { font: inherit; font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--pf-border); background: var(--pf-bg); color: var(--pf-fg); cursor: pointer; }
.pf-kp-chip:hover { background: var(--pf-bg-soft); }
.pf-kp-chip.is-off { opacity: .45; text-decoration: line-through; }
.pf-kp-chip__line { width: 14px; height: 3px; border-radius: 2px; display: inline-block; flex: none; }
`;

/** Inject the feature stylesheet once (idempotent). */
export function ensureStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

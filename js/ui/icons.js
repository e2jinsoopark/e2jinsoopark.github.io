// Inline SVG icons (Lucide-style: 24×24 grid, 2px round strokes, currentColor).
// Built with DOM APIs (never innerHTML) so icons are safe to create anywhere.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Shorthand builders for icon shapes. */
const p = (d) => ['path', { d }];
const c = (cx, cy, r) => ['circle', { cx, cy, r }];
const line = (x1, y1, x2, y2) => ['line', { x1, y1, x2, y2 }];
const rect = (x, y, width, height, rx = 0) => ['rect', { x, y, width, height, rx }];
const poly = (points) => ['polyline', { points }];
const polygon = (points) => ['polygon', { points }];

const FOLDER = 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z';
const FILE = 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z';
const FILE_FOLD = 'M14 2v4a2 2 0 0 0 2 2h4';
const CLOUD = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z';

/** name → list of [tag, attrs]. */
const ICONS = {
  'arrow-left': [p('m12 19-7-7 7-7'), p('M19 12H5')],
  'arrow-right': [p('M5 12h14'), p('m12 5 7 7-7 7')],
  'arrow-up-down': [p('m21 16-4 4-4-4'), p('M17 20V4'), p('m3 8 4-4 4 4'), p('M7 4v16')],
  'chevron-left': [p('m15 18-6-6 6-6')],
  'chevron-right': [p('m9 18 6-6-6-6')],
  'chevron-down': [p('m6 9 6 6 6-6')],
  'chevron-up': [p('m18 15-6-6-6 6')],
  plus: [p('M5 12h14'), p('M12 5v14')],
  minus: [p('M5 12h14')],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  check: [p('M20 6 9 17l-5-5')],
  search: [c(11, 11, 8), p('m21 21-4.3-4.3')],
  'zoom-in': [c(11, 11, 8), line(21, 21, 16.65, 16.65), line(11, 8, 11, 14), line(8, 11, 14, 11)],
  'zoom-out': [c(11, 11, 8), line(21, 21, 16.65, 16.65), line(8, 11, 14, 11)],
  'fit-width': [p('M3 5v14'), p('M21 5v14'), p('M7 12h10'), p('m10 9-3 3 3 3'), p('m14 9 3 3-3 3')],
  file: [p(FILE), p(FILE_FOLD)],
  'file-text': [p(FILE), p(FILE_FOLD), p('M10 9H8'), p('M16 13H8'), p('M16 17H8')],
  folder: [p(FOLDER)],
  'folder-open': [p('m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2')],
  'folder-plus': [p(FOLDER), p('M12 10v6'), p('M9 13h6')],
  'folder-input': [p('M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1'), p('M2 13h10'), p('m9 16 3-3-3-3')],
  library: [p('m16 6 4 14'), p('M12 6v14'), p('M8 8v12'), p('M4 4v16')],
  'book-open': [p('M12 7v14'), p('M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z')],
  star: [polygon('12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2')],
  clock: [c(12, 12, 10), poly('12 6 12 12 16 14')],
  settings: [p('M21 4h-7'), p('M10 4H3'), p('M21 12h-9'), p('M8 12H3'), p('M21 20h-5'), p('M12 20H3'), p('M14 2v4'), p('M8 10v4'), p('M16 18v4')],
  upload: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), poly('17 8 12 3 7 8'), line(12, 3, 12, 15)],
  cloud: [p(CLOUD)],
  'cloud-check': [p(CLOUD), p('m9.5 13.5 2 2 3.5-3.5')],
  'cloud-off': [p('m2 2 20 20'), p('M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193'), p('M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07')],
  refresh: [p('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'), p('M21 3v5h-5'), p('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'), p('M8 16H3v5')],
  'rotate-ccw': [p('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), p('M3 3v5h5')],
  'alert-circle': [c(12, 12, 10), line(12, 8, 12, 12), line(12, 16, 12.01, 16)],
  'alert-triangle': [p('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'), p('M12 9v4'), p('M12 17h.01')],
  info: [c(12, 12, 10), p('M12 16v-4'), p('M12 8h.01')],
  'check-circle': [c(12, 12, 10), p('m9 12 2 2 4-4')],
  'more-horizontal': [c(12, 12, 1), c(19, 12, 1), c(5, 12, 1)],
  'more-vertical': [c(12, 12, 1), c(12, 5, 1), c(12, 19, 1)],
  trash: [p('M3 6h18'), p('M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6'), p('M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2'), line(10, 11, 10, 17), line(14, 11, 14, 17)],
  pencil: [p('M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'), p('m15 5 4 4')],
  languages: [p('m5 8 6 6'), p('m4 14 6-6 2-3'), p('M2 5h12'), p('M7 2h1'), p('m22 22-5-10-5 10'), p('M14 18h6')],
  sparkles: [p('M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z'), p('M20 3v4'), p('M22 5h-4'), p('M4 17v2'), p('M5 18H3')],
  message: [p('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
  note: [p('M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z'), p('M15 3v6h6')],
  link: [p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'), p('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71')],
  columns: [rect(3, 3, 18, 18, 2), p('M12 3v18')],
  rows: [rect(3, 3, 18, 18, 2), p('M3 12h18')],
  layers: [p('M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z'), p('m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65'), p('m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65')],
  play: [polygon('6 3 20 12 6 21 6 3')],
  stop: [rect(6, 6, 12, 12, 1.5)],
  key: [p('m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4'), p('m21 2-9.6 9.6'), c(7.5, 15.5, 5.5)],
  'git-branch': [line(6, 3, 6, 15), c(18, 6, 3), c(6, 18, 3), p('M18 9a9 9 0 0 1-9 9')],
  eye: [p('M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'), c(12, 12, 3)],
  'eye-off': [p('M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'), p('M14.084 14.158a3 3 0 0 1-4.242-4.242'), p('M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'), p('m2 2 20 20')],
  sun: [c(12, 12, 4), p('M12 2v2'), p('M12 20v2'), p('m4.93 4.93 1.41 1.41'), p('m17.66 17.66 1.41 1.41'), p('M2 12h2'), p('M20 12h2'), p('m6.34 17.66-1.41 1.41'), p('m19.07 4.93-1.41 1.41')],
  moon: [p('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z')],
  monitor: [rect(2, 3, 20, 14, 2), line(8, 21, 16, 21), line(12, 17, 12, 21)],
  'external-link': [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')],
  grip: [c(9, 12, 1), c(9, 5, 1), c(9, 19, 1), c(15, 12, 1), c(15, 5, 1), c(15, 19, 1)],
  image: [rect(3, 3, 18, 18, 2), c(9, 9, 2), p('m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21')],
  highlighter: [p('m9 11-6 6v3h9l3-3'), p('m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4')],
  underline: [p('M6 4v6a6 6 0 0 0 12 0V4'), line(4, 20, 20, 20)],
  menu: [line(4, 6, 20, 6), line(4, 12, 20, 12), line(4, 18, 20, 18)],
  type: [p('M4 7V4h16v3'), p('M9 20h6'), p('M12 4v16')],
  coins: [c(8, 8, 6), p('M18.09 10.37A6 6 0 1 1 10.34 18'), p('M7 6h1v4'), p('m16.71 13.88.7.71-2.82 2.82')],
  shield: [p('M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z')],
  bot: [p('M12 8V4H8'), rect(4, 8, 16, 12, 2), p('M2 14h2'), p('M20 14h2'), p('M15 13v2'), p('M9 13v2')],
  palette: [p('M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z'), c(13.5, 6.5, 0.5), c(17.5, 10.5, 0.5), c(6.5, 12.5, 0.5), c(8.5, 7.5, 0.5)],
  quote: [p('M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z'), p('M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z')],
  list: [p('M3 12h.01'), p('M3 18h.01'), p('M3 6h.01'), p('M8 12h13'), p('M8 18h13'), p('M8 6h13')],
  inbox: [poly('22 12 16 12 14 15 10 15 8 12 2 12'), p('M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z')],
  copy: [rect(8, 8, 14, 14, 2), p('M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2')],
  'scroll-sync': [p('m7 15 5 5 5-5'), p('m7 9 5-5 5 5')],
  // 홈 화면에 추가 (the square-plus of iOS's own menu item) and the iOS share glyph (a box with an arrow up).
  'square-plus': [rect(3, 3, 18, 18, 2), p('M8 12h8'), p('M12 8v8')],
  share: [p('M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8'), poly('16 6 12 2 8 6'), line(12, 2, 12, 15)],
};

/** All available icon names. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/** True if `name` is a known icon. */
export function hasIcon(name) {
  return typeof name === 'string' && Object.hasOwn(ICONS, name);
}

/**
 * Create an inline SVG icon.
 * @param {string} name   icon name (see ICON_NAMES)
 * @param {{ size?: number, className?: string, title?: string, strokeWidth?: number }} [opts]
 * @returns {SVGSVGElement}  decorative (aria-hidden) unless `title` is given
 */
export function icon(name, { size = 18, className = '', title = '', strokeWidth = 2 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  setAttrs(svg, {
    xmlns: SVG_NS, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': strokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', focusable: 'false',
    class: `icon icon-${name}${className ? ` ${className}` : ''}`,
  });
  if (title) {
    svg.setAttribute('role', 'img');
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = title;
    svg.append(t);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const shapes = ICONS[name];
  if (!shapes) {
    console.warn('[icons] unknown icon', name);
    return svg;
  }
  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(SVG_NS, tag);
    setAttrs(shape, attrs);
    svg.append(shape);
  }
  return svg;
}

/**
 * Resolve an icon spec given by another module: a known icon name, a ready-made Node, or
 * (fallback) a short text glyph such as an emoji.
 * @param {string|Node|null|undefined} spec
 * @param {number} [size]
 * @returns {Node|null}
 */
export function resolveIcon(spec, size = 18) {
  if (spec == null || spec === '') return null;
  if (spec instanceof Node) return spec.cloneNode(true);
  if (hasIcon(spec)) return icon(spec, { size });
  const span = document.createElement('span');
  span.className = 'icon icon-glyph';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = String(spec).slice(0, 2);
  return span;
}

function setAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
}

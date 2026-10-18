// Boots the features against stub viewer/pane/library/tasks with a FeatureContext shaped like
// SPEC 3.5, and exposes everything on window.__h for the Playwright runner.
import { bus } from '/js/core/bus.js';
import { settings } from '/js/core/settings.js';
import { getSession, installReaderFeatures, panels } from '/js/features/index.js';
import { buildDoc } from './stubs/doc.js';
import { StubLibrary } from './stubs/library.js';
import { StubPane } from './stubs/pane.js';
import { StubViewer } from './stubs/viewer.js';

const params = new URLSearchParams(location.search);
if (params.has('reset')) StubLibrary.reset();
if (params.get('theme') === 'dark') document.documentElement.dataset.theme = 'dark';

const doc = buildDoc();
const library = new StubLibrary({
  paper: { id: 'paper1', title: doc.meta.title, authors: doc.meta.authors, year: 2024, fileName: 'mobility.pdf', pages: 3, folderId: null },
});
const paperId = library.paper.id;
const viewer = new StubViewer(document.getElementById('viewer'), { doc });

const tabsEl = document.getElementById('tabs');
const hostsEl = document.getElementById('hosts');
const paneHost = Object.assign(document.createElement('div'), { id: 'pane-host', className: 'host' });
hostsEl.append(paneHost);
const pane = new StubPane(paneHost, { doc });

// Shell-style hover sync, so screenshots look like the real reader.
viewer.addEventListener('sentencehover', (e) => pane.setHoverSentence(e.detail.sid));
pane.addEventListener('sentencehover', (e) => viewer.setHoverSentence(e.detail.sid));

const life = new AbortController();
let ai = (await library.getPaperData(paperId, 'ai')) || { version: 1 };
const jumps = [];
const toolbarButtons = {};

const ctx = {
  paper: library.getPaper(paperId),
  doc,
  pdf: null,
  viewer,
  pane,
  translator: null,
  library,
  settings,
  bus,
  getAi: () => ai,
  saveAi: async (patch) => {
    ai = { ...ai, ...patch };
    await library.savePaperData(paperId, 'ai', ai);
  },
  addToolbarButton({ id, icon, title, toggle = false, onClick }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'tb-btn';
    el.dataset.id = id;
    el.dataset.icon = icon;
    el.textContent = title;
    let active = false;
    const api = {
      el,
      setActive(on) { active = Boolean(on); el.classList.toggle('is-active', active); el.setAttribute('aria-pressed', String(active)); },
    };
    el.addEventListener('click', () => {
      if (toggle) { api.setActive(!active); onClick?.(active); } else onClick?.();
    });
    document.getElementById('tools').append(el);
    toolbarButtons[id] = api;
    return api;
  },
  openPanel: (id) => showTab(id),
  jumpToSentence(sid) {
    jumps.push(sid);
    viewer.scrollToSentence(sid);
    pane.scrollToSentence(sid);
  },
  signal: life.signal,
};

// --- right-pane tabs (shell's job in the real app) ---
const tabs = [{ id: 'translation', title: '번역' }, ...panels];
const mounted = {};
const hosts = { translation: paneHost };
let activeTab = null;

function showTab(id) {
  if (!hosts[id]) {
    const host = Object.assign(document.createElement('div'), { className: 'host' });
    host.dataset.panel = id;
    hostsEl.append(host);
    hosts[id] = host;
    mounted[id] = tabs.find((t) => t.id === id).mount(host, ctx);
  }
  for (const [k, h] of Object.entries(hosts)) h.hidden = k !== id;
  for (const b of tabsEl.children) b.classList.toggle('is-active', b.dataset.tab === id);
  activeTab = id;
  mounted[id]?.onShow?.();
}

for (const t of tabs) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.tab = t.id;
  b.textContent = t.title;
  b.addEventListener('click', () => showTab(t.id));
  tabsEl.append(b);
}
showTab(params.get('tab') || 'translation');

const features = installReaderFeatures(ctx);

window.__h = {
  ctx, doc, viewer, pane, library, jumps, toolbarButtons, mounted, features,
  session: getSession(ctx),
  get ai() { return ai; },
  get activeTab() { return activeTab; },
  showTab,
  closePaper() { life.abort(); },
  unmount(id) { mounted[id]?.destroy?.(); delete mounted[id]; hosts[id]?.remove(); delete hosts[id]; },
};
document.body.dataset.ready = '1';

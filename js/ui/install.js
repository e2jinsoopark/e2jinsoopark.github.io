// 홈 화면에 추가 (docs/notes/onboarding.md): one small button, shown only in a browser tab (not in the installed app)
// and until the person hides it.
//   Android / desktop Chromium: the browser's own install prompt (beforeinstallprompt), kept for the click; without
//     one, on a phone, a one-line hint '브라우저 메뉴 ⋮ → 홈 화면에 추가'.
//   iPhone / iPad: a home-screen app has its OWN storage, separate from Safari, so the invite code has to travel in
//     the saved address. iOS saves the page's current address when there is no web app manifest, so this page
//     exposes the manifest only on other systems (injected here, not in index.html); the click puts
//     '#/join/<CODE>' into the address bar (history.replaceState) and shows '공유 → 홈 화면에 추가'. The home-screen
//     app then starts at its join link; app.js registers that code silently (once) and opens the library.
import { settings } from '../core/settings.js';
import { el } from '../core/util.js';
import { button, popover, uiState } from './components.js';
import { icon } from './icons.js';

const HIDDEN_KEY = 'installHidden';
const LABEL = '홈 화면에 추가';

let started = false;
let deferredPrompt = null; // the browser's install prompt, kept for the click
let installed = false;
const watchers = new Set();

/** iPhone, iPad (also iPadOS's desktop-class Safari, which says "Macintosh"), iPod. Every iOS browser is WebKit. */
export function isIOS() {
  try {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  } catch { return false; }
}

/** Running as an installed / home-screen app (not in a browser tab). */
export function isStandalone() {
  try {
    if (navigator.standalone === true) return true; // iOS home-screen app
    return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
      .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
  } catch { return false; }
}

function isPhoneOrTablet() {
  try {
    if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean' && navigator.userAgentData.mobile) return true;
    return /Android|Mobi/i.test(navigator.userAgent || '');
  } catch { return false; }
}

/**
 * Call once at start-up, before anything else: the web app manifest (not on iOS, see above) and the browser's
 * install events. Chromium decides about the install prompt only after the manifest link exists, so the listener is
 * in place first.
 */
export function setupInstall() {
  if (started) return;
  started = true;
  try {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // no mini-infobar: the button in the library asks instead
      deferredPrompt = e;
      notify();
    });
    window.addEventListener('appinstalled', () => {
      markInstalled();
      notify();
    });
    window.matchMedia('(display-mode: standalone)').addEventListener?.('change', notify);
  } catch (err) { console.warn('[install] events', err); }
  if (!isIOS()) addManifestLink();
}

/** Installed from this browser: the button stays away here from now on (the browser tab is not the app). */
function markInstalled() {
  installed = true;
  deferredPrompt = null;
  uiState.set(HIDDEN_KEY, true);
}

function addManifestLink() {
  try {
    if (document.querySelector('link[rel="manifest"]')) return;
    // Resolved from this module (like the brand images), so test pages under /tests/ find it too.
    const href = new URL('../../manifest.webmanifest', import.meta.url).href;
    document.head.append(el('link', { rel: 'manifest', href }));
  } catch (err) { console.warn('[install] manifest', err); }
}

/** 'prompt' | 'ios' | 'hint' | 'none' — what the button does here, now. */
export function installMode() {
  if (installed || isStandalone()) return 'none';
  if (isIOS()) return 'ios';
  if (deferredPrompt) return 'prompt';
  if (isPhoneOrTablet()) return 'hint';
  return 'none'; // a desktop browser that offers no install: nothing to say
}

function shown() {
  return installMode() !== 'none' && !uiState.get(HIDDEN_KEY, false);
}

function notify() {
  for (const update of [...watchers]) {
    try { update(); } catch (err) { console.warn('[install] update', err); }
  }
}

/**
 * The 홈 화면에 추가 button (hides itself when there is nothing to do or it was hidden). Several may exist at once
 * (the library has one in the sidebar and one in the phone header); they show and hide together.
 * @param {{ className?: string }} [opts]
 * @returns {{ el: HTMLButtonElement, destroy: () => void }}
 */
export function installButton({ className = '' } = {}) {
  let tip = null;
  const btn = button(LABEL, {
    icon: 'square-plus', kind: 'ghost', size: 'sm', className: ['install-btn', className].filter(Boolean).join(' '),
    onClick: () => onClick(),
  });
  const update = () => {
    btn.hidden = !shown();
    if (btn.hidden) tip?.close();
  };
  const onClick = async () => {
    if (tip) { tip.close(); return; }
    const mode = installMode();
    if (mode === 'prompt') {
      const ev = deferredPrompt;
      deferredPrompt = null; // a prompt can be shown once
      try {
        await ev.prompt();
        const choice = await ev.userChoice;
        if (choice?.outcome === 'accepted') markInstalled();
      } catch (err) {
        console.warn('[install] prompt', err);
      }
      notify();
      // Declined, or the prompt failed: on a phone the hint is what is left.
      if (!installed && installMode() === 'hint' && btn.isConnected) showTip('hint');
      return;
    }
    if (mode === 'ios') {
      // The home-screen app starts at the saved address with empty storage: carry the code in it.
      const code = String(settings.get().relay?.code || '').trim();
      if (code) {
        try { history.replaceState(history.state, '', `#/join/${encodeURIComponent(code)}`); } catch (err) { console.warn('[install] address', err); }
      }
      showTip('ios');
      return;
    }
    if (mode === 'hint') showTip('hint');
  };
  const showTip = (mode) => {
    const text = mode === 'ios'
      ? el('span', { class: 'install-tip-text' }, '공유 ', icon('share', { size: 15, className: 'install-tip-share' }), ' → 홈 화면에 추가')
      : el('span', { class: 'install-tip-text' }, '브라우저 메뉴 ⋮ → 홈 화면에 추가');
    const hide = el('button', { type: 'button', class: 'install-tip-hide' }, '버튼 숨기기');
    hide.addEventListener('click', () => {
      uiState.set(HIDDEN_KEY, true);
      tip?.close();
      notify();
    });
    tip = popover(btn.getBoundingClientRect(), el('div', { class: 'install-tip' }, text, hide), {
      placement: 'bottom-start', className: 'install-popover', ignoreOutside: [btn], role: 'status', label: LABEL,
      onClose: () => { tip = null; },
    });
  };
  watchers.add(update);
  update();
  return {
    el: btn,
    destroy: () => {
      watchers.delete(update);
      tip?.close();
    },
  };
}

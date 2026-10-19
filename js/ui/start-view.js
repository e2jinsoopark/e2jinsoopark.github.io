// The first screen (docs/notes/onboarding.md): the 갈피 mark, ONE input for the invite code, [시작], and one small
// link to the own-API-key settings. Nothing else. Shown
//   - as the gate, to a fresh visitor (no usable AI, no invite code, nothing in 내 서재, no GitHub sync), and
//   - for the join link #/join/<CODE>: the code is filled in and registered at once. In a home-screen app (`quiet`:
//     an iPhone one starts at its join link) only the mark and a spinner show while that happens; the form appears
//     only if the code cannot be registered.
// Success goes straight to the library (공용 서재 for invitees). The input takes a bare code, a whole invite link or
// the whole invite message from a messenger (relay.extractInviteCode). The relay helpers arrive as deps.relay.
import { settings } from '../core/settings.js';
import { el } from '../core/util.js';
import { brandImage, spinner, toast } from './components.js';

const NOT_FOUND = '코드를 찾을 수 없어요';
/** relay.js error codes → the first screen's one-line wording (others: the relay's own message). */
const SHORT_ERRORS = {
  auth: NOT_FOUND, // unknown or stopped code (401)
  bad_request: NOT_FOUND, // cannot be a code
  network: '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요',
  timeout: '서버가 응답하지 않아요. 잠시 후 다시 시도해 주세요',
};
/** An invitee's library home is 공용 서재: give GET /shared this long before going to #/ (app.js waits the same). */
const SHARED_WAIT_MS = 2500;

/**
 * @param {HTMLElement} container
 * @param {{ deps: object, navigate: (hash: string, opts?: { replace?: boolean }) => void, code?: string | null,
 *           gate?: boolean, quiet?: boolean, notice?: string }} opts  `code`: from a join link (registered at once);
 *           `gate`: shown instead of the library; `quiet`: with `code`, no form unless registering fails; `notice`: one
 *           line in the error line's place until the person types (the saved code no longer works, app.js)
 * @returns {{ kind: 'start', gate: boolean, busy: () => boolean, destroy: () => void }}
 */
export function mountStartView(container, { deps, navigate, code = null, gate = false, quiet = false, notice = '' }) {
  const view = new StartView(container, deps, navigate, { code, gate, quiet: quiet && code != null, notice });
  return { kind: 'start', gate, busy: () => view.busy, destroy: () => view.destroy() };
}

class StartView {
  #deps;
  #navigate;
  #els = {};
  #controller = null;
  #alive = true;
  #busy = false;
  #root;

  constructor(container, deps, navigate, { code, gate, quiet, notice = '' }) {
    this.#deps = deps;
    this.#navigate = navigate;
    document.title = '갈피';
    this.#root = this.#build({ fromLink: code != null, gate });
    this.#root.classList.toggle('is-quiet', Boolean(quiet));
    container.replaceChildren(this.#root);
    if (notice && code == null) this.#setNotice(notice);
    if (code != null) {
      this.#els.input.value = this.#display(code);
      this.#submit({ fromLink: true });
    } else {
      // Not on a phone: the keyboard would cover the screen before the person has seen it.
      if (!matchMedia('(pointer: coarse)').matches) requestAnimationFrame(() => this.#els.input.focus());
    }
  }

  /** Registering a code (until it has gone on to the library). */
  get busy() { return this.#busy; }

  destroy() {
    this.#alive = false;
    this.#controller?.abort();
    this.#root.remove();
  }

  #build({ fromLink, gate }) {
    const els = this.#els;
    els.input = el('input', {
      class: 'input start-input', id: 'start-code', type: 'text', autocomplete: 'off', autocapitalize: 'characters',
      autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go', inputmode: 'text',
      placeholder: 'PR-XXXX-XXXX 또는 받은 메시지를 붙여넣기', 'aria-describedby': 'start-error',
    });
    els.error = el('p', { class: 'start-error', id: 'start-error', role: 'alert', 'aria-live': 'assertive' });
    els.go = el('button', { type: 'button', class: 'btn btn-primary start-go' }, el('span', { class: 'btn-label' }, '시작'));
    els.go.addEventListener('click', () => this.#submit());
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.#submit(); }
    });
    els.input.addEventListener('input', () => this.#setError(''));
    // A whole invite message pasted: keep only the code (single-line inputs would glue its lines together).
    els.input.addEventListener('paste', (e) => {
      const found = this.#extract(e.clipboardData?.getData('text/plain') || '');
      if (!found) return; // left as pasted; 시작 says what is wrong
      e.preventDefault();
      els.input.value = found;
      this.#setError('');
    });

    // Someone who already has a working setup (a join link opened on their own device): back to their library.
    const fresh = gate || !this.#hasSetup();
    els.link = el('button', { type: 'button', class: 'start-link' }, fresh ? '내 API 키로 쓰기' : '돌아가기');
    els.link.addEventListener('click', () => this.#navigate(fresh ? '#/settings/ai' : '#/', { replace: !fresh && fromLink }));

    return el('main', { class: 'start', 'aria-label': '갈피 시작', 'aria-busy': 'false' },
      el('div', { class: 'start-card' },
        el('div', { class: 'start-brand' },
          brandImage('mark-lg', { size: 72, className: 'start-mark' }),
          el('h1', { class: 'start-name' }, '갈피')),
        el('div', { class: 'start-wait', role: 'status' }, spinner(20), el('span', { class: 'sr-only' }, '여는 중…')),
        el('div', { class: 'start-form' },
          el('label', { class: 'start-label', for: 'start-code' }, '초대 코드'),
          els.input,
          els.error,
          els.go),
        els.link));
  }

  #hasSetup() {
    const s = settings.get();
    return settings.isAiReady() || ['claude', 'openai', 'gemini'].some((id) => String(s[id]?.apiKey || '').trim());
  }

  #extract(text) {
    try { return this.#deps.relay?.extractInviteCode?.(text) || ''; } catch { return ''; }
  }

  /** What the input shows for a join link's code: the canonical code when it is one, else what the link said. */
  #display(code) {
    return this.#extract(code) || String(code || '');
  }

  /** Not an error of what was typed (the saved code stopped working): the same line, without the red. */
  #setNotice(text) {
    this.#els.error.textContent = text;
    this.#els.error.classList.add('is-notice');
  }

  #setError(text) {
    this.#els.error.textContent = text;
    this.#els.error.classList.remove('is-notice');
    if (text) {
      this.#els.input.setAttribute('aria-invalid', 'true');
      this.#root?.classList.remove('is-quiet'); // something to say: the form shows
    } else {
      this.#els.input.removeAttribute('aria-invalid');
    }
  }

  #setBusy(busy) {
    this.#busy = busy;
    this.#root.setAttribute('aria-busy', String(busy));
    if (!busy) this.#root.classList.remove('is-quiet'); // something to say: the form shows
    const { input, go } = this.#els;
    input.readOnly = busy;
    go.disabled = busy;
    go.replaceChildren(...(busy ? [spinner(16), el('span', { class: 'btn-label' }, '확인 중…')] : [el('span', { class: 'btn-label' }, '시작')]));
  }

  async #submit({ fromLink = false } = {}) {
    if (this.#busy) return;
    const relay = this.#deps.relay;
    const { input } = this.#els;
    if (!relay?.registerInviteCode) {
      this.#setError('초대 코드 기능을 불러오지 못했어요. 새로 고침해 주세요.');
      return;
    }
    const code = this.#extract(input.value);
    if (!code) {
      this.#setError(input.value.trim() ? NOT_FOUND : '초대 코드를 넣어 주세요');
      if (!fromLink) input.focus();
      return;
    }
    input.value = code;
    this.#setError('');
    this.#setBusy(true);
    this.#controller = new AbortController();
    let me;
    try {
      me = await relay.registerInviteCode(code, { signal: this.#controller.signal });
    } catch (err) {
      if (!this.#alive || err?.code === 'aborted') return;
      this.#setBusy(false);
      // One short line: the server's own words for anything but an unknown code (e.g. too many tries: "시도가 너무
      // 많습니다. 잠시 후 다시 시도해 주세요."), a short one when the server cannot be reached.
      this.#setError(SHORT_ERRORS[err?.code] || err?.message || NOT_FOUND);
      if (!fromLink) input.select();
      return;
    }
    if (!this.#alive) return;
    // 공용 서재 follows the new code (app.js restarts it on the settings change): let it answer first, so an
    // invitee lands in 공용 서재 rather than an empty 내 서재 (the library view still moves late answers).
    if (!me?.unchanged) {
      try {
        await Promise.race([this.#deps.shared?.settled?.(), new Promise((r) => setTimeout(r, SHARED_WAIT_MS))]);
      } catch { /* the library shows what it has */ }
      if (!this.#alive) return;
      toast('초대 코드를 등록했어요.', { kind: 'success', timeout: 2500 });
    }
    // The code leaves the address bar and the history entry.
    this.#navigate('#/', { replace: true });
  }
}

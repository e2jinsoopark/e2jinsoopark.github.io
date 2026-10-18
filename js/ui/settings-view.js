// Settings view (#/settings): AI provider & keys, GitHub sync, translation options, display, usage, secrets.
import { APP_VERSION, CLAUDE_MODELS, PRICES, STORAGE_KEYS } from '../core/config.js';
import { settings } from '../core/settings.js';
import { debounce, el, formatUsd, safeStorage } from '../core/util.js';
import { button, confirmDialog, iconButton, modal, spinner, toast } from './components.js';
import { icon } from './icons.js';

const SECTIONS = [
  { id: 'ai', label: 'AI 번역', icon: 'bot' },
  { id: 'sync', label: 'GitHub 동기화', icon: 'git-branch' },
  { id: 'translate', label: '번역 옵션', icon: 'languages' },
  { id: 'display', label: '화면', icon: 'palette' },
  { id: 'usage', label: '사용량', icon: 'coins' },
  { id: 'data', label: '보안·데이터', icon: 'shield' },
];

/**
 * @param {HTMLElement} container
 * @param {{ deps: object, navigate: (hash: string) => void, backHref?: string }} opts
 * @returns {{ destroy: () => void }}
 */
export function mountSettingsView(container, { deps, navigate, backHref = '#/', section = null }) {
  const view = new SettingsView(container, deps, navigate, backHref);
  if (section) view.scrollToSection(section);
  return { destroy: () => view.destroy() };
}

class SettingsView {
  #deps;
  #navigate;
  #backHref;
  #root;
  #els = {};
  #cleanup = [];
  #geminiModels = null;

  constructor(container, deps, navigate, backHref) {
    this.#deps = deps;
    this.#navigate = navigate;
    this.#backHref = backHref;
    document.title = '설정 · 논문 리더';
    this.#root = el('div', { class: 'settings' });
    container.replaceChildren(this.#root);
    this.#render();
    const lib = deps.library;
    if (lib) {
      const onStatus = () => this.#renderSyncStatus();
      lib.addEventListener('syncstatus', onStatus);
      this.#cleanup.push(() => lib.removeEventListener('syncstatus', onStatus));
    }
  }

  destroy() {
    for (const off of this.#cleanup) off();
    if (this.#githubUnsaved()) toast('GitHub 동기화 설정은 저장되지 않았습니다. 다시 열어 ‘저장하고 동기화 시작’을 눌러야 적용됩니다.', { kind: 'warning', timeout: 7000 });
    this.#root.remove();
  }

  /** `#/settings/sync` etc.: open at that section. */
  scrollToSection(id) {
    const target = this.#root.querySelector(`#set-${CSS.escape(String(id))}`);
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }

  /** The GitHub fields hold something other than what is saved (e.g. a freshly generated token). */
  #githubUnsaved() {
    const e = this.#els;
    if (!e.gh_owner?.isConnected) return false;
    const saved = settings.get().github || {};
    const form = this.#githubForm();
    return Boolean(form.token) && (form.owner !== (saved.owner || '') || form.repo !== (saved.repo || '')
      || form.branch !== (saved.branch || 'main') || form.token !== (saved.token || ''));
  }

  async #goBack() {
    if (this.#githubUnsaved()) {
      const leave = await confirmDialog('GitHub 동기화 설정(토큰 포함)을 아직 저장하지 않았습니다. GitHub는 토큰을 한 번만 보여 주므로, 저장하지 않으면 새로 만들어야 할 수 있습니다. 저장하지 않고 나갈까요?',
        { okLabel: '저장하지 않고 나가기', danger: true, title: '저장하지 않은 설정' });
      if (!leave) return;
      this.#els.gh_token.value = settings.get().github?.token || ''; // don't warn again on destroy
    }
    this.#navigate(this.#backHref);
  }

  #render() {
    const header = el('header', { class: 'settings-header' },
      iconButton('arrow-left', '뒤로', () => this.#goBack()),
      el('h1', {}, '설정'));
    const nav = el('nav', { class: 'settings-nav', 'aria-label': '설정 항목' },
      SECTIONS.map((s) => button(s.label, {
        icon: s.icon, kind: 'ghost', size: 'sm',
        onClick: () => this.#root.querySelector(`#set-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      })));
    const inner = el('div', { class: 'settings-inner' },
      nav,
      this.#aiSection(),
      this.#syncSection(),
      this.#translateSection(),
      this.#displaySection(),
      this.#usageSection(),
      this.#dataSection(),
      el('p', { class: 'settings-footer' }, `논문 리더 ${APP_VERSION} · 모든 설정은 이 브라우저에만 저장됩니다.`));
    this.#root.replaceChildren(header, inner);
  }

  // ------------------------------------------------------------------- AI

  #aiSection() {
    const s = settings.get();
    const body = el('div', {});
    if (s.provider === 'mock') {
      body.append(note('info', '테스트 모드(주소에 ?mock=1)로 실행 중입니다. 실제 AI 대신 모의 응답이 사용되며 비용이 들지 않습니다.'));
    }
    const cards = el('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'AI 제공자' },
      this.#providerCard('claude', 'Claude (Anthropic)', '논문 번역 품질이 안정적입니다. 번역은 빠르고 저렴한 Haiku를 기본으로 사용합니다.'),
      this.#providerCard('gemini', 'Gemini (Google)', 'Google AI Studio에서 발급한 키를 사용합니다. 모델 목록은 키로 불러옵니다.'));
    this.#els.providerDetail = el('div', {});
    body.append(cards, this.#els.providerDetail);
    this.#renderProviderDetail();
    return section('ai', 'AI 번역', 'bot', '번역·요약·채팅에 사용할 AI 서비스와 API 키를 설정합니다. 키는 이 브라우저에만 저장되고 해당 AI 서비스로만 전송됩니다.', body);
  }

  #providerCard(id, title, desc) {
    const current = settings.get().provider;
    // In test mode (?mock=1) the provider is forced for this session, so the choice is locked.
    const input = el('input', { type: 'radio', name: 'provider', value: id, checked: current === id, disabled: current === 'mock' });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      settings.set({ provider: id });
      this.#renderProviderDetail();
    });
    return el('label', { class: 'radio-card' }, input, el('span', { class: 'radio-title' }, title), el('span', { class: 'radio-desc' }, desc));
  }

  #renderProviderDetail() {
    const p = settings.get().provider;
    const host = this.#els.providerDetail;
    if (p === 'gemini') host.replaceChildren(this.#geminiDetail());
    else if (p === 'claude') host.replaceChildren(this.#claudeDetail());
    else host.replaceChildren(el('p', { class: 'field-hint', style: { marginTop: '14px' } }, '테스트 모드에서는 제공자를 바꿀 수 없습니다. 주소에서 ?mock=1을 빼면 저장된 제공자가 사용됩니다.'), this.#claudeDetail());
  }

  #claudeDetail() {
    const c = settings.get().claude;
    const priceHint = el('p', { class: 'price-hint' });
    const updateHint = () => { priceHint.textContent = priceText(settings.get().claude.translateModel, settings.get().claude.assistModel); };
    const modelSelect = (key, label) => {
      const select = el('select', { class: 'select', 'aria-label': label },
        CLAUDE_MODELS.map((m) => el('option', { value: m.id, selected: c[key] === m.id }, m.label)));
      if (c[key] && !CLAUDE_MODELS.some((m) => m.id === c[key])) select.prepend(el('option', { value: c[key], selected: true }, c[key]));
      select.addEventListener('change', () => { settings.set({ claude: { [key]: select.value } }); updateHint(); savedToast(); });
      return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), select);
    };
    updateHint();
    return el('div', { class: 'subsection' },
      el('h3', { class: 'subsection-title' }, icon('key', { size: 16 }), 'Claude API 키'),
      this.#secretField({
        label: 'API 키', value: c.apiKey, placeholder: 'sk-ant-…',
        onSave: (v) => settings.set({ claude: { apiKey: v } }),
        onTest: () => this.#testProvider('claude'),
      }),
      el('div', { class: 'field-row', style: { marginTop: '14px' } },
        modelSelect('translateModel', '번역 모델'),
        modelSelect('assistModel', '요약·채팅·설명 모델')),
      priceHint,
      el('details', { class: 'howto' },
        el('summary', {}, 'Claude API 키 만드는 법'),
        el('ol', {},
          el('li', {}, extLink('https://platform.claude.com/settings/keys', 'Claude Console → API Keys'), ' 페이지에 로그인합니다.'),
          el('li', {}, el('b', {}, 'Create Key'), '를 눌러 이름(예: paper-reader)을 정하고 키를 만듭니다.'),
          el('li', {}, '표시된 키(', el('code', {}, 'sk-ant-'), '로 시작)를 복사해 위 칸에 붙여 넣고 ', el('b', {}, '테스트'), '를 누릅니다.'),
          el('li', {}, 'API 사용료는 Claude Console 조직의 크레딧으로 청구됩니다. Claude Console의 ', el('b', {}, 'Limits'), '에서 월 사용 한도를 정해 두면 안심입니다.'),
          el('li', {}, el('b', {}, 'Claude Max'), '(5x: 월 $100, 20x: 월 $200) 요금제라면 claude.ai에서 요금제에 포함된 API 크레딧을 Claude Console 조직에 연결하세요. 키는 크레딧이 연결된 그 조직에서 만들어야 합니다. 채팅 사용 한도와는 별개이며, Pro 요금제는 해당되지 않습니다.'))));
  }

  #geminiDetail() {
    const g = settings.get().gemini;
    const translateSel = el('select', { class: 'select', 'aria-label': '번역 모델' });
    const assistSel = el('select', { class: 'select', 'aria-label': '요약·채팅·설명 모델' });
    const status = el('div', { class: 'test-result' });
    const fill = () => {
      const current = settings.get().gemini;
      for (const [sel, key] of [[translateSel, 'translateModel'], [assistSel, 'assistModel']]) {
        const models = this.#geminiModels || [];
        const options = models.map((m) => el('option', { value: m.id, selected: current[key] === m.id }, m.label || m.id));
        if (!current[key]) options.unshift(el('option', { value: '', selected: true }, models.length ? '모델을 선택하세요' : '먼저 모델 목록을 불러오세요'));
        else if (!models.some((m) => m.id === current[key])) options.unshift(el('option', { value: current[key], selected: true }, current[key]));
        sel.replaceChildren(...options);
      }
    };
    translateSel.addEventListener('change', () => { settings.set({ gemini: { translateModel: translateSel.value } }); savedToast(); });
    assistSel.addEventListener('change', () => { settings.set({ gemini: { assistModel: assistSel.value } }); savedToast(); });
    const load = async () => {
      const provider = this.#provider('gemini');
      if (!provider?.listModels) { setResult(status, 'error', 'AI 모듈을 불러오지 못했습니다.'); return; }
      if (!settings.get().gemini.apiKey) { setResult(status, 'error', '먼저 API 키를 입력하세요.'); return; }
      setResult(status, 'busy', '모델 목록을 불러오는 중…');
      try {
        const models = await provider.listModels();
        this.#geminiModels = Array.isArray(models) ? models : [];
        fill();
        const cur = settings.get().gemini;
        // Pick sensible defaults the first time: a "flash" model for translation, a "pro" model for assist.
        if (!cur.translateModel && this.#geminiModels.length) {
          const pick = this.#geminiModels.find((m) => /flash/i.test(m.id) && !/lite|image|tts|live/i.test(m.id)) || this.#geminiModels[0];
          settings.set({ gemini: { translateModel: pick.id } });
        }
        if (!cur.assistModel && this.#geminiModels.length) {
          const pick = this.#geminiModels.find((m) => /pro/i.test(m.id) && !/image|tts|live/i.test(m.id)) || this.#geminiModels[0];
          settings.set({ gemini: { assistModel: pick.id } });
        }
        fill();
        setResult(status, 'ok', `모델 ${this.#geminiModels.length}개를 불러왔습니다.`);
      } catch (err) {
        setResult(status, 'error', err?.message || '모델 목록을 불러오지 못했습니다.');
      }
    };
    fill();
    if (g.apiKey && !this.#geminiModels) queueMicrotask(load);
    return el('div', { class: 'subsection' },
      el('h3', { class: 'subsection-title' }, icon('key', { size: 16 }), 'Gemini API 키'),
      this.#secretField({
        label: 'API 키', value: g.apiKey, placeholder: 'AIza…',
        onSave: (v) => { settings.set({ gemini: { apiKey: v } }); },
        onTest: () => this.#testProvider('gemini'),
      }),
      note('shield', '무료 등급에서는 입력 내용(번역할 문장, 질문)이 Google 제품 개선에 쓰일 수 있습니다. 미출판 원고·민감 자료에는 Claude 또는 Gemini 유료 등급을 쓰세요. Gemini 사용 비용은 이 앱의 사용량에 집계되지 않습니다.'),
      el('div', { class: 'field-row', style: { marginTop: '14px' } },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '번역 모델'), translateSel),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '요약·채팅·설명 모델'), assistSel)),
      el('div', { class: 'btn-row' }, button('모델 목록 불러오기', { icon: 'refresh', size: 'sm', onClick: load })),
      status,
      el('details', { class: 'howto' },
        el('summary', {}, 'Gemini API 키 만드는 법'),
        el('ol', {},
          el('li', {}, extLink('https://aistudio.google.com/apikey', 'Google AI Studio → API keys'), ' 페이지에 Google 계정으로 로그인합니다.'),
          el('li', {}, el('b', {}, 'Create API key'), '를 눌러 키를 만들고 복사합니다.'),
          el('li', {}, '위 칸에 붙여 넣고 ', el('b', {}, '테스트'), ' → ', el('b', {}, '모델 목록 불러오기'), '를 누른 뒤 모델을 고릅니다.'))));
  }

  #provider(id) {
    try {
      return this.#deps.getProvider ? this.#deps.getProvider(id) : null;
    } catch (err) {
      console.warn('[settings-view] getProvider', err);
      return null;
    }
  }

  async #testProvider(id) {
    const provider = this.#provider(id);
    if (!provider?.testKey) return { ok: false, message: 'AI 모듈을 불러오지 못해 테스트할 수 없습니다.' };
    return provider.testKey();
  }

  /**
   * Password-style input with show/hide and an optional 테스트 button.
   * Saves on change (blur / Enter); 테스트 saves first, then runs onTest() → { ok, message }.
   */
  #secretField({ label, value = '', placeholder = '', onSave, onTest, hint }) {
    const input = el('input', {
      class: 'input', type: 'password', value, placeholder, autocomplete: 'off', spellcheck: 'false',
      'aria-label': label, autocapitalize: 'off',
    });
    const result = el('div', { class: 'test-result', 'aria-live': 'polite' });
    const save = () => {
      const v = input.value.trim();
      if (input.value !== v) input.value = v;
      onSave(v);
    };
    input.addEventListener('change', () => { save(); savedToast(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    const reveal = iconButton('eye', '키 보기', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      reveal.setAttribute('aria-label', show ? '키 숨기기' : '키 보기');
      reveal.title = show ? '키 숨기기' : '키 보기';
      reveal.replaceChildren(icon(show ? 'eye-off' : 'eye', { size: 18 }));
    }, { kind: 'default' });
    const controls = [input, reveal];
    if (onTest) {
      const testBtn = button('테스트', { icon: 'check-circle', onClick: async () => {
        save();
        if (!input.value) { setResult(result, 'error', '키를 먼저 입력하세요.'); return; }
        testBtn.disabled = true;
        setResult(result, 'busy', '연결을 확인하는 중…');
        try {
          const r = await onTest();
          setResult(result, r?.ok ? 'ok' : 'error', r?.message || (r?.ok ? '정상적으로 연결되었습니다.' : '연결하지 못했습니다.'));
        } catch (err) {
          setResult(result, 'error', err?.message || '연결하지 못했습니다.');
        } finally {
          testBtn.disabled = false;
        }
      } });
      controls.push(testBtn);
    }
    return el('div', { class: 'field' },
      el('span', { class: 'field-label' }, label),
      el('div', { class: 'input-group' }, ...controls),
      hint ? el('span', { class: 'field-hint' }, hint) : null,
      result);
  }

  // ----------------------------------------------------------------- sync

  #syncSection() {
    const g = settings.get().github;
    const field = (label, key, attrs = {}) => {
      const input = el('input', { class: 'input', type: 'text', value: g[key] || '', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': label, ...attrs });
      this.#els[`gh_${key}`] = input;
      return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input);
    };
    const token = el('input', { class: 'input', type: 'password', value: g.token || '', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'GitHub 토큰' });
    this.#els.gh_token = token;
    const reveal = iconButton('eye', '토큰 보기', () => {
      const show = token.type === 'password';
      token.type = show ? 'text' : 'password';
      reveal.replaceChildren(icon(show ? 'eye-off' : 'eye', { size: 18 }));
      reveal.setAttribute('aria-label', show ? '토큰 숨기기' : '토큰 보기');
    }, { kind: 'default' });
    const result = el('div', { class: 'test-result', 'aria-live': 'polite' });
    this.#els.syncStatus = el('div', { class: 'test-result' });
    this.#els.syncNowBtn = button('지금 동기화', { icon: 'refresh', size: 'sm', onClick: () => this.#syncNow() });

    const owner = field('소유자 (사용자 이름)', 'owner', { placeholder: '예: my-github-id' });
    const repo = field('저장소 이름', 'repo', { placeholder: '예: paper-library' });
    // Accept a pasted repository URL or "owner/repo" in either box.
    for (const input of [this.#els.gh_owner, this.#els.gh_repo]) {
      input.addEventListener('change', () => {
        const m = input.value.trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
        if (m) { this.#els.gh_owner.value = m[1]; this.#els.gh_repo.value = m[2]; }
      });
    }

    const body = el('div', {},
      el('div', { class: 'field-row' }, owner, repo),
      el('div', { class: 'field-row', style: { marginTop: '14px' } },
        field('브랜치', 'branch', { placeholder: 'main' }),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '토큰 (Fine-grained personal access token)'), el('div', { class: 'input-group' }, token, reveal))),
      el('div', { class: 'btn-row' },
        // Like the AI keys' 테스트: a successful test also saves (GitHub shows a new token only once).
        button('연결 테스트', { icon: 'check-circle', onClick: () => this.#testAndSaveGithub(result) }),
        button('저장하고 동기화 시작', { icon: 'cloud', kind: 'primary', onClick: () => this.#saveGithub(result) })),
      result,
      el('div', { class: 'subsection' },
        el('h3', { class: 'subsection-title' }, '현재 상태'),
        el('div', { class: 'input-group', style: { justifyContent: 'space-between', flexWrap: 'wrap' } }, this.#els.syncStatus, this.#els.syncNowBtn)),
      this.#githubHowto(!settings.isSyncReady()));
    this.#renderSyncStatus();
    return section('sync', 'GitHub 동기화', 'git-branch',
      '내 GitHub 비공개 저장소 하나에 라이브러리(PDF·번역·메모)를 저장해 여러 기기에서 같이 씁니다. 선택 사항이며, 꺼져 있어도 이 브라우저에는 그대로 저장됩니다.', body);
  }

  #githubHowto(open) {
    return el('details', { class: 'howto', open },
      el('summary', {}, '처음이라면: 비공개 저장소와 전용 토큰 만드는 법 (약 3분)'),
      el('ol', {},
        el('li', {}, extLink('https://github.com/new', 'GitHub에서 새 저장소 만들기'), '를 엽니다. 이름(예: ', el('code', {}, 'paper-library'), ')을 정하고 ',
          el('b', {}, 'Private'), '을 선택한 뒤, ', el('b', {}, 'Add a README file'), '에 체크하고 만듭니다.'),
        el('li', {}, extLink('https://github.com/settings/personal-access-tokens/new', 'Fine-grained 토큰 만들기'), '를 엽니다. (GitHub 설정 → Developer settings → Personal access tokens → ',
          el('b', {}, 'Fine-grained tokens'), ' → Generate new token)'),
        el('li', {}, el('b', {}, 'Token name'), '에 ', el('code', {}, 'paper-reader'), '처럼 알아보기 쉬운 이름을 넣고, ', el('b', {}, 'Expiration'), '은 원하는 기간(예: 90일)으로 정합니다.'),
        el('li', {}, el('b', {}, 'Repository access'), '에서 ', el('b', {}, 'Only select repositories'), '를 고르고, 1번에서 만든 저장소 ', el('b', {}, '하나만'), ' 선택합니다.'),
        el('li', {}, el('b', {}, 'Permissions → Repository permissions'), '에서 ', el('b', {}, 'Contents'), '를 ', el('b', {}, 'Read and write'),
          '로 바꿉니다. (Metadata: Read-only는 자동으로 붙습니다.) 다른 권한은 주지 않습니다.'),
        el('li', {}, el('b', {}, 'Generate token'), '을 누르고, 표시된 토큰(', el('code', {}, 'github_pat_'), '으로 시작)을 바로 복사합니다. 이 화면을 벗어나면 다시 볼 수 없습니다.'),
        el('li', {}, '위 칸에 소유자(내 GitHub 아이디)·저장소 이름·토큰을 넣고 ', el('b', {}, '연결 테스트'), ' → ', el('b', {}, '저장하고 동기화 시작'), '을 누릅니다.')),
      note('shield', '토큰은 이 브라우저에만 저장되고 GitHub API(api.github.com)로만 전송됩니다. 이 토큰으로는 선택한 저장소 하나의 파일만 읽고 쓸 수 있습니다. 공용 PC에서는 사용 후 아래 ‘이 기기의 데이터 모두 지우기’를 누르세요.'));
  }

  #githubForm() {
    const e = this.#els;
    return {
      owner: e.gh_owner.value.trim(),
      repo: e.gh_repo.value.trim(),
      branch: e.gh_branch.value.trim() || 'main',
      token: e.gh_token.value.trim(),
    };
  }

  async #testGithub(result) {
    const form = this.#githubForm();
    if (!form.owner || !form.repo || !form.token) { setResult(result, 'error', '소유자, 저장소 이름, 토큰을 모두 입력하세요.'); return false; }
    const { GitHubClient } = this.#deps;
    if (!GitHubClient) { setResult(result, 'error', 'GitHub 모듈을 불러오지 못해 테스트할 수 없습니다.'); return false; }
    setResult(result, 'busy', 'GitHub에 연결하는 중…');
    try {
      const r = await new GitHubClient(form).checkAccess();
      if (!r?.ok) { setResult(result, 'error', r?.message || '저장소에 접근할 수 없습니다. 소유자·저장소 이름·토큰 권한을 확인하세요.'); return false; }
      if (r.repoPrivate === false) {
        setResult(result, 'error', '공개(Public) 저장소입니다. 논문 PDF와 메모가 누구에게나 보이게 됩니다. 비공개 저장소를 사용하세요.');
        return false;
      }
      if (r.canPush === false) {
        setResult(result, 'error', '읽기만 가능하고 쓰기 권한이 없습니다. 토큰의 Contents 권한을 ‘Read and write’로 바꾸세요.');
        return false;
      }
      const message = r.message || `연결되었습니다 · 비공개 저장소 · 쓰기 가능 (${form.owner}/${form.repo})`;
      setResult(result, 'ok', message);
      this.#lastTestMessage = message;
      return true;
    } catch (err) {
      setResult(result, 'error', err?.message || 'GitHub에 연결하지 못했습니다.');
      return false;
    }
  }

  #lastTestMessage = '';

  async #testAndSaveGithub(result) {
    const form = this.#githubForm();
    if (!form.owner || !form.repo || !form.token) { setResult(result, 'error', '소유자, 저장소 이름, 토큰을 모두 입력하세요.'); return; }
    await this.#saveGithub(result, { fromTest: true });
  }

  async #saveGithub(result, { fromTest = false } = {}) {
    const form = this.#githubForm();
    if ((form.owner || form.repo || form.token) && !(form.owner && form.repo && form.token)) {
      setResult(result, 'error', '소유자, 저장소 이름, 토큰을 모두 입력하세요. (동기화를 끄려면 세 칸을 모두 비우세요.)');
      return;
    }
    if (form.token && this.#deps.GitHubClient && !(await this.#testGithub(result))) return;
    const tested = this.#lastTestMessage;
    // This device's library came from another repository (or another person used this browser before):
    // upload it to the new one only if the user says so.
    const lib = this.#deps.library;
    let next = { ...form };
    if (form.token && typeof lib?.syncTargetChange === 'function') {
      let change = null;
      try { change = await lib.syncTargetChange(form); } catch (err) { console.warn('[settings-view] syncTargetChange', err); }
      if (change) {
        const choice = await this.#askCarryOver(change, form);
        if (choice === 'cancel') { setResult(result, 'error', '저장하지 않았습니다. 동기화 대상은 바뀌지 않았습니다.'); return; }
        if (choice === 'upload') next = { ...form, carryOver: change.to };
        if (choice === 'wipe') {
          settings.set({ github: { ...form, carryOver: '' } });
          await lib.wipeLocalData?.();
          location.reload();
          return;
        }
      }
    }
    settings.set({ github: { carryOver: '', ...next } });
    try {
      await lib?.reconfigureSync?.();
      if (settings.isSyncReady()) {
        setResult(result, 'ok', fromTest && tested ? `${tested} · 저장했고 동기화를 시작합니다.` : '저장했습니다. 동기화를 시작합니다.');
        toast('GitHub 동기화를 켰습니다.', { kind: 'success' });
      } else {
        setResult(result, 'ok', '저장했습니다. GitHub 동기화가 꺼져 있습니다.');
      }
    } catch (err) {
      setResult(result, 'error', err?.message || '동기화를 시작하지 못했습니다.');
    }
    this.#renderSyncStatus();
  }

  /** @returns {Promise<'upload'|'wipe'|'cancel'>} */
  #askCarryOver(change, form) {
    const repoOf = (target) => String(target || '').replace(/^https?:\/\/[^/]+\//, '').replace(/#.*$/, '');
    return new Promise((resolve) => {
      let choice = 'cancel';
      modal({
        title: '다른 저장소로 바꿉니다',
        size: 'sm',
        body: el('div', {},
          el('p', {}, `이 기기에는 다른 저장소(${repoOf(change.from)})와 동기화하던 논문 ${change.papers}편과 번역·메모가 있습니다.`),
          el('p', {}, `이 데이터를 새 저장소(${form.owner}/${form.repo})에 올릴까요?`),
          el('p', { class: 'field-hint' }, '공용 PC에서 다른 사람이 쓰던 브라우저라면 ‘이 기기 데이터 지우고 시작’을 고르세요. GitHub에 있는 데이터는 지워지지 않습니다.')),
        actions: [
          { label: '취소', onClick: () => { choice = 'cancel'; } },
          { label: '이 기기 데이터 지우고 시작', kind: 'danger', onClick: () => { choice = 'wipe'; } },
          { label: '올리기', kind: 'primary', onClick: () => { choice = 'upload'; } },
        ],
        onClose: () => resolve(choice),
      });
    });
  }

  #renderSyncStatus() {
    const target = this.#els.syncStatus;
    if (!target) return;
    const st = this.#deps.library?.sync?.status || { state: 'disabled' };
    const last = st.lastSyncAt ? ` · 마지막 동기화 ${new Date(st.lastSyncAt).toLocaleString('ko-KR')}` : '';
    const pending = st.pending ? ` · 대기 ${st.pending}개` : '';
    const map = {
      disabled: ['off', '꺼짐 — 이 브라우저에만 저장됩니다'],
      idle: ['ok', `동기화 완료${last}${pending}`],
      syncing: ['busy', `동기화 중…${pending}`],
      error: ['error', `오류: ${st.message || '동기화하지 못했습니다'}${pending}`],
      offline: ['off', `오프라인 — 연결되면 다시 동기화합니다${pending}`],
    };
    const [kind, text] = map[st.state] || map.disabled;
    setResult(target, kind, text);
    if (this.#els.syncNowBtn) this.#els.syncNowBtn.disabled = st.state === 'disabled' || st.state === 'syncing';
  }

  async #syncNow() {
    try {
      await this.#deps.library?.sync?.syncNow();
    } catch (err) {
      toast(err?.message || '동기화하지 못했습니다.', { kind: 'error' });
    }
    this.#renderSyncStatus();
  }

  // ------------------------------------------------------------ translate

  #translateSection() {
    const t = settings.get().translate;
    const glossaryHost = el('div', { class: 'glossary' });
    let rows = (t.glossary || []).map((g) => ({ src: g.src || '', tgt: g.tgt || '' }));
    const persist = debounce(() => {
      settings.set({ translate: { glossary: rows.filter((r) => r.src.trim() && r.tgt.trim()).map((r) => ({ src: r.src.trim(), tgt: r.tgt.trim() })) } });
    }, 400);
    const renderRows = () => {
      glossaryHost.replaceChildren();
      if (!rows.length) glossaryHost.append(el('p', { class: 'glossary-empty' }, '등록된 용어가 없습니다. 자주 나오는 전문용어의 번역어를 정해 두면 논문 전체에서 일관되게 번역됩니다.'));
      rows.forEach((row, i) => {
        const src = el('input', { class: 'input', value: row.src, placeholder: '영어 (예: delirium)', 'aria-label': `${i + 1}번 영어 용어`, spellcheck: 'false' });
        const tgt = el('input', { class: 'input', value: row.tgt, placeholder: '한국어 (예: 섬망)', 'aria-label': `${i + 1}번 한국어 번역어` });
        src.addEventListener('input', () => { row.src = src.value; persist(); });
        tgt.addEventListener('input', () => { row.tgt = tgt.value; persist(); });
        glossaryHost.append(el('div', { class: 'glossary-row' }, src, el('span', { class: 'arrow' }, icon('arrow-right', { size: 15 })), tgt,
          iconButton('trash', `${i + 1}번 용어 삭제`, () => { rows.splice(i, 1); persist.flush(); renderRows(); }, { size: 'sm' })));
      });
    };
    renderRows();
    const addRow = () => {
      rows.push({ src: '', tgt: '' });
      renderRows();
      glossaryHost.querySelector('.glossary-row:last-child input')?.focus();
    };
    const bulk = () => {
      const ta = el('textarea', { class: 'textarea', rows: '8', placeholder: 'delirium = 섬망\nmechanical ventilation = 기계환기\npressure injury = 욕창', 'aria-label': '용어 여러 개 입력' });
      modal({
        title: '용어 여러 개 붙여넣기',
        body: el('div', {}, el('p', { class: 'field-hint', style: { marginTop: 0 } }, '한 줄에 하나씩 “영어 = 한국어” 형식으로 입력하세요. 탭으로 구분된 표(엑셀에서 복사)도 됩니다.'), ta),
        actions: [
          { label: '취소' },
          { label: '추가', kind: 'primary', onClick: () => {
            const parsed = ta.value.split(/\r?\n/).map((line) => line.split(/\s*(?:=|\t|→|->)\s*/)).filter((p) => p.length >= 2 && p[0].trim() && p[1].trim())
              .map((p) => ({ src: p[0].trim(), tgt: p.slice(1).join(' ').trim() }));
            if (!parsed.length) { toast('인식된 용어가 없습니다. “영어 = 한국어” 형식인지 확인하세요.', { kind: 'warning' }); return false; }
            const known = new Set(rows.map((r) => r.src.trim().toLowerCase()));
            rows = rows.concat(parsed.filter((p) => !known.has(p.src.toLowerCase())));
            persist.flush();
            renderRows();
            toast(`용어 ${parsed.length}개를 추가했습니다.`, { kind: 'success' });
            return true;
          } },
        ],
      });
    };

    const concurrency = el('select', { class: 'select', 'aria-label': '동시 요청 수', style: { width: '120px' } },
      [1, 2, 3, 4, 5, 6].map((n) => el('option', { value: String(n), selected: Number(t.concurrency) === n }, `${n}개`)));
    concurrency.addEventListener('change', () => { settings.set({ translate: { concurrency: Number(concurrency.value) } }); savedToast(); });

    const body = el('div', {},
      el('h3', { class: 'subsection-title' }, icon('list', { size: 16 }), '용어집'),
      glossaryHost,
      el('div', { class: 'btn-row' },
        button('용어 추가', { icon: 'plus', size: 'sm', onClick: addRow }),
        button('여러 개 붙여넣기', { icon: 'copy', size: 'sm', kind: 'ghost', onClick: bulk })),
      el('div', { class: 'subsection' },
        switchRow('전문용어 영어 병기', '처음 나올 때 “섬망(delirium)”처럼 원어를 괄호로 함께 적습니다.', t.keepTermsInEnglish,
          (v) => settings.set({ translate: { keepTermsInEnglish: v } })),
        switchRow('참고문헌도 번역', '보통은 끄는 것을 권장합니다. 참고문헌 목록은 원문 그대로 두는 편이 검색에 유리하고 비용도 줄어듭니다.', t.translateReferences,
          (v) => settings.set({ translate: { translateReferences: v } })),
        el('div', { class: 'switch-row' },
          el('div', { class: 'switch-text' },
            el('div', { class: 'switch-title' }, '동시 요청 수'),
            el('div', { class: 'field-hint' }, '높을수록 빠르지만 API 속도 제한에 걸릴 수 있습니다. 기본 3개.')),
          concurrency)),
      el('p', { class: 'field-hint', style: { marginTop: '12px' } }, '바꾼 옵션은 새로 번역하는 문장부터 적용됩니다.'));
    return section('translate', '번역 옵션', 'languages', '번역 말투와 용어를 논문 분야에 맞게 조정합니다.', body);
  }

  // -------------------------------------------------------------- display

  #displaySection() {
    const ui = settings.get().ui;
    const themes = [
      { id: 'light', label: '밝게', icon: 'sun' },
      { id: 'dark', label: '어둡게', icon: 'moon' },
      { id: 'system', label: '시스템 설정', icon: 'monitor' },
    ];
    const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': '테마' });
    const themeBtns = themes.map((t) => {
      const b = button(t.label, { icon: t.icon, size: 'sm', pressed: (ui.theme || 'light') === t.id, onClick: () => {
        settings.set({ ui: { theme: t.id } });
        themeBtns.forEach((x, i) => x.setAttribute('aria-pressed', String(themes[i].id === t.id)));
      } });
      return b;
    });
    seg.append(...themeBtns);

    const sizeLabel = el('span', { class: 'badge is-accent' }, `${ui.fontSize}px`);
    const preview = el('p', { class: 'font-preview', style: { fontSize: `${ui.fontSize}px` } },
      '중환자실 환자의 섬망은 재원 기간 연장 및 사망률 증가와 관련이 있으며, 조기 선별과 비약물적 중재가 권고된다.');
    const range = el('input', { class: 'range', type: 'range', min: '12', max: '22', step: '1', value: String(ui.fontSize), 'aria-label': '번역 글자 크기' });
    const commitSize = debounce((v) => settings.set({ ui: { fontSize: v } }), 150);
    range.addEventListener('input', () => {
      const v = Number(range.value);
      sizeLabel.textContent = `${v}px`;
      preview.style.fontSize = `${v}px`;
      commitSize(v);
    });

    const body = el('div', {},
      el('div', { class: 'field' }, el('span', { class: 'field-label' }, '테마'), el('div', {}, seg)),
      el('div', { class: 'field' },
        el('span', { class: 'field-label' }, '번역 글자 크기 ', sizeLabel),
        range, preview),
      el('div', { class: 'subsection' },
        switchRow('스크롤 연동', 'PDF를 스크롤하거나 문장에 마우스를 올리면 번역 창이 같은 위치로 따라갑니다.', ui.syncScroll,
          (v) => settings.set({ ui: { syncScroll: v } })),
        switchRow('핵심 문장 밑줄 표시', 'AI가 고른 핵심 문장(기여·방법·결과·한계)에 밑줄을 표시합니다.', ui.showAutoHighlights,
          (v) => settings.set({ ui: { showAutoHighlights: v } }))));
    return section('display', '화면', 'palette', '테마와 글자 크기를 조정합니다.', body);
  }

  // ---------------------------------------------------------------- usage

  #usageSection() {
    const host = el('div', {});
    const render = () => {
      const summary = this.#deps.usage?.usageSummary ? safeCall(() => this.#deps.usage.usageSummary()) : null;
      if (!summary) {
        host.replaceChildren(el('p', { class: 'field-hint' }, this.#deps.usage ? '아직 사용 기록이 없습니다.' : '사용량 모듈을 불러오지 못했습니다.'));
        return;
      }
      const isPriced = typeof this.#deps.usage?.isPriced === 'function' ? this.#deps.usage.isPriced : () => true;
      let unpriced = false;
      const rows = Object.entries(summary.byModel || {}).map(([model, v]) => {
        const info = typeof v === 'number' ? { usd: v } : (v || {});
        const priced = isPriced(model);
        if (!priced) unpriced = true;
        return el('tr', {},
          el('td', {}, modelName(model)),
          el('td', { class: 'num' }, fmtInt(info.calls)),
          el('td', { class: 'num' }, fmtInt(info.inputTokens)),
          el('td', { class: 'num' }, fmtInt(info.outputTokens)),
          el('td', { class: 'num', title: priced ? null : '이 모델은 요금 정보가 없어 비용을 계산하지 않습니다.' },
            priced ? formatUsd(info.usd ?? info.costUsd ?? 0) : '비용 미집계'));
      });
      host.replaceChildren(...[
        el('div', { class: 'usage-stats' },
          stat('기간', formatMonth(summary.month)),
          stat('예상 비용', `${formatUsd(summary.usd || 0)}${unpriced ? ' + Gemini' : ''}`),
          stat('AI 호출', `${fmtInt(summary.calls || 0)}회`)),
        rows.length ? el('div', { class: 'md-table-wrap' }, el('table', { class: 'data-table' },
          el('thead', {}, el('tr', {}, el('th', {}, '모델'), el('th', { class: 'num' }, '호출'), el('th', { class: 'num' }, '입력 토큰'), el('th', { class: 'num' }, '출력 토큰'), el('th', { class: 'num' }, '비용'))),
          el('tbody', {}, rows))) : null,
        unpriced ? note('info', 'Gemini 사용 비용은 요금 정보가 없어 예상 비용에 포함되지 않습니다. Google AI Studio의 결제 화면에서 확인하세요.') : null,
        note('info', '토큰 수와 공개 요금표로 계산한 추정치이며 이 브라우저에서 쓴 양만 집계됩니다. 실제 청구액은 각 AI 서비스 콘솔에서 확인하세요.'),
      ].filter(Boolean));
    };
    render();
    const body = el('div', {}, host, el('div', { class: 'btn-row' }, button('새로 고침', { icon: 'refresh', size: 'sm', onClick: render })));
    return section('usage', '이번 달 사용량', 'coins', '번역·요약·채팅에 쓴 AI 사용량과 예상 비용입니다.', body);
  }

  // ----------------------------------------------------------------- data

  #dataSection() {
    const s2 = this.#secretField({
      label: 'Semantic Scholar API 키 (선택)', value: settings.get().semanticScholar?.apiKey || '', placeholder: '없어도 됩니다',
      onSave: (v) => settings.set({ semanticScholar: { apiKey: v } }),
      hint: '‘관련 논문’과 인용 정보 조회에 씁니다. 키가 없으면 공용 한도로 동작합니다.',
    });
    const clearBtn = button('이 기기에서 키·토큰 지우기', { icon: 'trash', kind: 'danger', onClick: () => this.#clearSecrets() });
    const wipeBtn = button('이 기기의 데이터 모두 지우기', { icon: 'trash', kind: 'danger', onClick: () => this.#wipeDevice() });
    const persisted = el('p', { class: 'field-hint', style: { margin: '0 0 12px' } });
    this.#deps.library?.storagePersisted?.().then((granted) => {
      if (granted === false) {
        persisted.textContent = '주의: 브라우저가 이 사이트의 저장 공간을 “영구 보관”으로 허용하지 않았습니다. 디스크가 부족하면 아직 GitHub에 올라가지 않은 변경 내용이 지워질 수 있으니 동기화를 켜 두세요.';
      }
    }).catch(() => {});
    const shared = sharedOriginWarning();
    const body = el('div', {},
      s2,
      el('div', { class: 'subsection' },
        el('h3', { class: 'subsection-title' }, icon('shield', { size: 16 }), '저장 위치'),
        el('p', { class: 'field-hint', style: { margin: '0 0 12px' } },
          'API 키와 GitHub 토큰은 이 브라우저의 저장소(localStorage)에만 보관되며, 각각 해당 서비스로 요청할 때만 사용됩니다. 논문 PDF와 번역은 이 브라우저(IndexedDB)와, 동기화를 켠 경우 내 GitHub 비공개 저장소에 저장됩니다.'),
        el('p', { class: 'field-hint', style: { margin: '0 0 12px' } },
          '보내는 곳: 번역·요약·채팅할 문장 → 선택한 AI(Anthropic 또는 Google) · 라이브러리와 메모 → 내 GitHub 저장소(동기화를 켠 경우) · ‘관련 논문’을 찾을 때 논문 제목 → Semantic Scholar.'),
        shared ? note('alert-triangle', shared) : null,
        persisted,
        el('div', { class: 'btn-row' }, clearBtn, wipeBtn),
        el('p', { class: 'field-hint' }, '공용 PC에서는 사용 후 ‘이 기기의 데이터 모두 지우기’를 누르세요. 키·토큰과 함께 이 브라우저에 있는 논문·번역·메모·사용 기록까지 지웁니다(GitHub 저장소의 데이터는 그대로입니다).')));
    return section('data', '보안·데이터', 'shield', '키 관리와 저장 위치를 확인합니다.', body);
  }

  async #wipeDevice() {
    const ok = await confirmDialog('이 브라우저에 저장된 논문 PDF, 번역, 하이라이트·메모, AI 요약·채팅, 사용 기록과 모든 설정(API 키·GitHub 토큰 포함)을 지울까요?\nGitHub 저장소에 동기화된 데이터는 지워지지 않습니다. 아직 올라가지 않은 변경 내용은 사라집니다.',
      { okLabel: '모두 지우기', danger: true, title: '이 기기의 데이터 모두 지우기' });
    if (!ok) return;
    try {
      await this.#deps.library?.wipeLocalData?.();
    } catch (err) {
      console.warn('[settings-view] wipeLocalData', err);
      toast(`일부 데이터를 지우지 못했습니다: ${err?.message || err}`, { kind: 'error' });
    }
    for (const key of Object.values(STORAGE_KEYS)) safeStorage.remove(key);
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('pr.')) localStorage.removeItem(key);
    } catch { /* storage blocked */ }
    location.hash = '#/';
    location.reload();
  }

  async #clearSecrets() {
    const ok = await confirmDialog('이 기기에 저장된 Claude·Gemini·Semantic Scholar API 키와 GitHub 토큰을 모두 지울까요?\n라이브러리와 번역 데이터는 지워지지 않습니다.',
      { okLabel: '지우기', danger: true, title: '키·토큰 지우기' });
    if (!ok) return;
    settings.set({ claude: { apiKey: '' }, gemini: { apiKey: '' }, github: { token: '' }, semanticScholar: { apiKey: '' } });
    try { await this.#deps.library?.reconfigureSync?.(); } catch (err) { console.warn('[settings-view] reconfigureSync', err); }
    toast('이 기기에서 키와 토큰을 지웠습니다.', { kind: 'success' });
    this.#render();
  }
}

// ------------------------------------------------------------------ helpers

/**
 * GitHub Pages project sites of one account share one origin (user.github.io/a, user.github.io/b): localStorage
 * and IndexedDB are per origin, so every page there could read this app's keys, token and library.
 */
function sharedOriginWarning() {
  try {
    const { hostname, pathname } = location;
    if (!/\.github\.io$/i.test(hostname)) return '';
    const firstSegment = pathname.split('/').filter(Boolean)[0] || '';
    if (!firstSegment || /\.html?$/i.test(firstSegment)) return '';
    return `이 앱은 ${hostname} 아래의 한 프로젝트 페이지(/${firstSegment}/)에서 열려 있습니다. 같은 계정의 다른 GitHub Pages 사이트와 브라우저 저장소를 함께 쓰므로, 그 사이트의 스크립트가 API 키·토큰·논문을 읽을 수 있습니다. 이 앱 전용 주소(전용 계정의 ${'<이름>'}.github.io 또는 사용자 도메인)에서 쓰는 것을 권장합니다.`;
  } catch { return ''; }
}

function section(id, title, iconName, desc, body) {
  return el('section', { class: 'settings-section', id: `set-${id}`, 'aria-labelledby': `set-${id}-title` },
    el('div', { class: 'section-head' },
      el('span', { class: 'section-icon' }, icon(iconName, { size: 18 })),
      el('div', {}, el('h2', { class: 'section-title', id: `set-${id}-title` }, title), desc ? el('p', { class: 'section-desc' }, desc) : null)),
    body);
}

function switchRow(title, desc, checked, onChange) {
  const input = el('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: Boolean(checked), 'aria-label': title });
  input.addEventListener('change', () => { onChange(input.checked); savedToast(); });
  return el('label', { class: 'switch-row' },
    el('div', { class: 'switch-text' }, el('div', { class: 'switch-title' }, title), el('div', { class: 'field-hint' }, desc)),
    input);
}

function note(iconName, text) {
  return el('div', { class: 'note' }, icon(iconName, { size: 16 }), el('div', {}, text));
}

function stat(label, value) {
  return el('div', { class: 'stat' }, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value));
}

function extLink(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text, ' ', icon('external-link', { size: 12 }));
}

function setResult(node, kind, text) {
  node.className = `test-result is-${kind}`;
  const glyph = kind === 'busy' ? spinner(14) : icon(kind === 'ok' ? 'check-circle' : kind === 'error' ? 'alert-circle' : 'info', { size: 16 });
  node.replaceChildren(glyph, el('span', {}, text));
}

let savedTimer = null;
/** A quiet "saved" confirmation, coalesced so typing doesn't spam toasts. */
function savedToast() {
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => toast('저장했습니다.', { kind: 'success', timeout: 1600 }), 250);
}

/** 'Claude Haiku 5.5' for a known Claude model id; other ids as they are. */
function modelName(id) {
  const known = CLAUDE_MODELS.find((m) => m.id === id);
  return known ? known.label.replace(/\s*\(.*\)$/, '') : id;
}

function priceText(translateModel, assistModel) {
  const fmt = (id) => {
    const p = PRICES[id];
    return p ? `${modelName(id)}: 입력 $${p.input} / 출력 $${p.output}` : null;
  };
  const parts = [...new Set([translateModel, assistModel])].map(fmt).filter(Boolean);
  return parts.length ? `요금(100만 토큰당): ${parts.join(' · ')}` : '';
}

function formatMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  return m ? `${m[1]}년 ${Number(m[2])}월` : month || '-';
}

function fmtInt(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '-';
}

function safeCall(fn) {
  try { return fn(); } catch (err) { console.warn('[settings-view]', err); return null; }
}

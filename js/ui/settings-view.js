// Settings view (#/settings): AI provider & keys (incl. the invite-code relay), GitHub sync, translation options,
// display, usage, secrets, invite-code admin. Also the invite join screen (#/join/<CODE>, mountJoinView).
// The relay helpers (js/ai/relay.js) arrive as deps.relay with the dynamically loaded AI modules.
import { APP_VERSION, CLAUDE_MODELS, DEFAULT_MODELS, PRICES, STORAGE_KEYS } from '../core/config.js';
import { bus } from '../core/bus.js';
import { settings } from '../core/settings.js';
import { debounce, el, formatUsd, safeStorage } from '../core/util.js';
import { button, confirmDialog, iconButton, messageScreen, modal, progressBar, spinner, toast } from './components.js';
import { icon } from './icons.js';

const SECTIONS = [
  { id: 'ai', label: 'AI 번역', icon: 'bot' },
  { id: 'sync', label: 'GitHub 동기화', icon: 'git-branch' },
  { id: 'translate', label: '번역 옵션', icon: 'languages' },
  { id: 'display', label: '화면', icon: 'palette' },
  { id: 'usage', label: '사용량', icon: 'coins' },
  { id: 'data', label: '보안·데이터', icon: 'shield' },
];

const RELAY_CARD_TITLE = '키 없이 쓰기 (초대 코드)';
// After a key is saved (blur/Enter), its model list is read unless 테스트 is pressed within this delay.
const KEY_LIST_DELAY_MS = 400;
/** Own-key providers, in card order. */
const KEY_PROVIDER_IDS = ['claude', 'openai', 'gemini'];
const bold = (text) => el('b', {}, text);
const mono = (text) => el('code', {}, text);
const KEY_PROVIDERS = {
  claude: {
    card: 'Claude', title: 'Claude API 키', placeholder: 'sk-ant-…', priced: true,
    desc: '논문 번역 품질이 안정적입니다. 예상 비용이 이 앱의 사용량에 집계됩니다.',
    autoHint: '‘자동 선택’은 키로 쓸 수 있는 모델 중 번역에 최신 Haiku, 요약·채팅에 최신 Sonnet을 고릅니다(키를 저장하면 목록을 불러옵니다).',
    keyUrl: 'https://platform.claude.com/settings/keys', keyLink: 'Claude Console → API Keys',
    howto: (link) => ['키 만들기: ', link, '에 로그인해 ', bold('Create Key'), '로 키를 만들고, ', mono('sk-ant-'), '로 시작하는 키를 위 칸에 붙여 넣은 뒤 ',
      bold('테스트'), '를 누르세요. 사용료는 Claude Console 조직의 크레딧으로 청구되며 ', bold('Limits'), '에서 월 한도를 정해 둘 수 있습니다. ',
      bold('Claude Max'), ' 요금제라면 claude.ai에서 요금제에 포함된 API 크레딧을 Console 조직에 연결하고, 그 조직에서 키를 만드세요(Pro 요금제는 해당되지 않습니다).'],
  },
  openai: {
    card: 'GPT (OpenAI)', title: 'OpenAI API 키', placeholder: 'sk-…', priced: false,
    desc: '내 OpenAI API 키로 GPT를 씁니다. 모델은 키로 불러와 자동으로 고릅니다.',
    autoHint: '‘자동 선택’은 키를 저장하면 그 키로 쓸 수 있는 GPT 모델 중 번역에 빠르고 저렴한 모델, 요약·채팅에 표준 모델을 고릅니다.',
    keyUrl: 'https://platform.openai.com/api-keys', keyLink: 'OpenAI Platform → API keys',
    howto: (link) => ['키 만들기: ', link, '에 로그인해 ', bold('Create new secret key'), '로 키를 만들고, ', mono('sk-'), '로 시작하는 키를 위 칸에 붙여 넣은 뒤 ',
      bold('테스트'), '를 누르세요. API 사용료는 ChatGPT 구독(Plus·Pro)과 별개로, OpenAI Platform의 ', bold('Billing'), '에 충전한 크레딧에서 나갑니다.'],
  },
  gemini: {
    card: 'Gemini', title: 'Gemini API 키', placeholder: 'AIza…', priced: false,
    desc: 'Google AI Studio에서 만든 키를 씁니다. 무료 등급이 있습니다.',
    autoHint: '‘자동 선택’은 키를 저장하면 그 키로 쓸 수 있는 최신 Flash 모델을 고릅니다(무료 등급에서도 쓸 수 있는 모델).',
    keyUrl: 'https://aistudio.google.com/apikey', keyLink: 'Google AI Studio → API keys',
    privacy: '무료 등급에서는 입력 내용(번역할 문장, 질문)이 Google 제품 개선에 쓰일 수 있습니다. 미출판 원고·민감 자료에는 Claude·GPT 또는 Gemini 유료 등급을 쓰세요.',
    howto: (link) => ['키 만들기: ', link, '에 Google 계정으로 로그인해 ', bold('Create API key'), '로 키를 만들고, 위 칸에 붙여 넣은 뒤 ',
      bold('테스트'), '를 누르세요. 모델은 키로 불러온 목록에서 자동으로 고릅니다.'],
  },
};

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
  #models = {}; // provider id → the key's live model list (newest first), while the view is open
  #mePromise = null; // GET /relay/me shared by the AI and usage sections while the view is open
  #renderUsage = () => {};
  #shownProvider = null; // the provider the AI section shows (another tab may switch it)

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
    // Another tab picked another provider: show it here too (a stale checked card could not be clicked back).
    this.#cleanup.push(bus.on('settings:change', ({ external } = {}) => {
      if (!external || settings.get().provider === this.#shownProvider) return;
      this.#renderProviderCards();
      this.#renderProviderDetail();
      this.#renderUsage();
    }));
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
      this.#invitesSection(),
      el('p', { class: 'settings-footer' }, `논문 리더 ${APP_VERSION} · 모든 설정은 이 브라우저에만 저장됩니다.`));
    this.#root.replaceChildren(header, inner);
  }

  // ------------------------------------------------------------------- AI

  #aiSection() {
    const body = el('div', {});
    if (settings.get().provider === 'mock') {
      body.append(note('info', '테스트 모드(주소에 ?mock=1)로 실행 중입니다. 실제 AI 대신 모의 응답이 사용되며 비용이 들지 않습니다.'));
    }
    this.#els.providerCards = el('div', { class: 'provider-picker-host' });
    this.#els.providerDetail = el('div', {});
    body.append(this.#els.providerCards, this.#els.providerDetail);
    this.#renderProviderCards();
    this.#renderProviderDetail();
    return section('ai', 'AI 번역', 'bot', '번역·요약·채팅에 쓸 AI를 고릅니다. 초대 코드가 있으면 키 없이 쓸 수 있고, 내 Claude·GPT·Gemini API 키로 직접 연결할 수도 있습니다. API 키는 이 브라우저에만 저장되어 해당 AI 서비스로만 전송됩니다.', body);
  }

  /** Someone who registered an invite code (join link or typed code): their own API keys are the alternative. */
  #isInvitee() {
    return Boolean(String(settings.get().relay?.code || '').trim());
  }

  /**
   * Provider cards: 키 없이 쓰기 (초대 코드) · Claude · GPT (OpenAI) · Gemini. For an invitee the invite card comes
   * first with their name and today's usage, and the own-key providers sit under '내 API 키 쓰기'; switching keeps the
   * invite code saved, so the invite card switches back with one click.
   */
  #renderProviderCards() {
    const host = this.#els.providerCards;
    if (!host) return;
    const s = settings.get();
    const own = KEY_PROVIDER_IDS.map((id) => this.#providerCard(id, KEY_PROVIDERS[id].card, KEY_PROVIDERS[id].desc,
      String(s[id]?.apiKey || '').trim() ? '키 저장됨' : ''));
    this.#els.relayCardStatus = null;
    if (!this.#isInvitee()) {
      host.replaceChildren(el('div', { class: 'radio-cards provider-cards is-all', role: 'radiogroup', 'aria-label': 'AI 제공자' },
        this.#providerCard('relay', RELAY_CARD_TITLE, '초대받았다면 API 키 없이 초대 코드만으로 번역·요약·채팅을 쓸 수 있습니다. 하루 사용 한도가 있습니다.'),
        ...own));
      return;
    }
    const usingRelay = s.provider === 'relay';
    this.#els.relayCardStatus = el('span', { class: 'radio-desc' }, this.#relayCardText(null));
    host.replaceChildren(el('div', { class: 'provider-picker is-invitee', role: 'radiogroup', 'aria-label': 'AI 제공자' },
      el('div', { class: 'radio-cards' }, this.#providerCard('relay', RELAY_CARD_TITLE, this.#els.relayCardStatus, '초대 코드 저장됨')),
      el('div', { class: 'own-keys' },
        el('div', { class: 'own-keys-head' },
          el('span', { class: 'own-keys-title' }, icon('key', { size: 15 }), '내 API 키 쓰기'),
          el('span', { class: 'field-hint' }, usingRelay
            ? '내 Claude·GPT·Gemini API 키가 있으면 직접 연결할 수도 있습니다. 바꿔도 초대 코드는 지워지지 않아, 위 카드를 누르면 언제든 한 번에 돌아옵니다.'
            : '지금은 내 API 키로 연결되어 있습니다. 초대 코드는 그대로 저장되어 있어, 위 카드를 누르면 바로 초대 코드로 돌아갑니다.')),
        el('div', { class: 'radio-cards provider-cards' }, ...own))));
    // Not in a ?mock=1 session: tests and demos never reach a real server by themselves.
    if (this.#deps.relay && settings.relayUrl() && !settings.isMockSession) this.#loadMe().then((me) => this.#updateRelayCard(me), () => {});
  }

  /** '홍길동님 · 오늘 $0.03 / $0.50', plus how to come back while another provider is selected. */
  #relayCardText(me) {
    const name = me ? me.name : settings.get().relay?.name;
    const parts = [name ? `${name}님` : '초대 코드 등록됨'];
    if (me) parts.push(`오늘 ${formatUsd(me.todayUsd)} / ${formatUsd(me.dailyLimitUsd)}`);
    if (settings.get().provider !== 'relay') parts.push('누르면 초대 코드로 돌아갑니다');
    return parts.join(' · ');
  }

  #updateRelayCard(me) {
    const node = this.#els.relayCardStatus;
    if (node?.isConnected) node.textContent = this.#relayCardText(me);
  }

  #providerCard(id, title, desc, badge = '') {
    const current = settings.get().provider;
    // In test mode (?mock=1) the provider is forced for this session, so the choice is locked.
    const input = el('input', { type: 'radio', name: 'provider', value: id, checked: current === id, disabled: current === 'mock' });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const hadFocus = document.activeElement === input;
      settings.set({ provider: id });
      this.#renderProviderCards();
      this.#renderProviderDetail();
      this.#renderUsage();
      if (hadFocus) this.#els.providerCards.querySelector(`input[name="provider"][value="${id}"]`)?.focus();
    });
    return el('label', { class: 'radio-card', dataset: { provider: id } }, input,
      el('span', { class: 'radio-title' }, title),
      typeof desc === 'string' ? el('span', { class: 'radio-desc' }, desc) : desc,
      badge ? el('span', { class: 'badge is-ok radio-badge' }, badge) : null);
  }

  #renderProviderDetail() {
    const p = settings.get().provider;
    this.#shownProvider = p;
    const host = this.#els.providerDetail;
    if (p === 'relay') host.replaceChildren(this.#relayDetail());
    else if (KEY_PROVIDERS[p]) host.replaceChildren(this.#keyDetail(p));
    else host.replaceChildren(el('p', { class: 'field-hint', style: { marginTop: '14px' } }, '테스트 모드에서는 제공자를 바꿀 수 없습니다. 주소에서 ?mock=1을 빼면 저장된 제공자가 사용됩니다.'), this.#keyDetail('claude'));
  }

  /**
   * Claude / GPT / Gemini: API key (password) + 테스트, model selectors from the key's live list (newest first; the
   * automatic pick is the '자동 선택' entry), cost note and how to get a key. Saving or testing a key reads the
   * model list and picks the models (js/ai/models.js).
   */
  #keyDetail(id) {
    const meta = KEY_PROVIDERS[id];
    const conf = () => settings.get()[id] || {};
    const result = el('div', { class: 'test-result', 'aria-live': 'polite' });
    const translateSel = el('select', { class: 'select', 'aria-label': '번역 모델' });
    const assistSel = el('select', { class: 'select', 'aria-label': '요약·채팅·설명 모델' });
    const modelHint = el('p', { class: 'field-hint model-hint' });
    const costNote = meta.priced ? el('p', { class: 'price-hint' })
      : note('coins', `비용 미집계 — 각 회사 결제 화면에서 확인하세요. 이 앱은 ${meta.card} 요금을 계산하지 않고 토큰 수만 집계합니다.`);
    let timer = null;
    let seq = 0; // newest model-list request or key test; older answers are dropped

    const listed = () => this.#models[id] || (id === 'claude' ? CLAUDE_MODELS : null);
    const labelOf = (modelId) => (listed() || []).find((m) => m.id === modelId)?.label
      || CLAUDE_MODELS.find((m) => m.id === modelId)?.label || modelId;
    const renderModels = () => {
      const c = conf();
      const provider = this.#provider(id);
      // Legacy ids (new keys typically cannot use them) are not offered.
      const models = (listed() || []).filter((m) => !provider?.isLegacyModel?.(m.id));
      for (const [sel, kind, key] of [[translateSel, 'translate', 'translateModel'], [assistSel, 'assist', 'assistModel']]) {
        const chosen = c[key] || '';
        const auto = c.autoModels?.[kind] || DEFAULT_MODELS[id]?.[kind] || '';
        const autoLabel = auto ? `자동 선택 — ${labelOf(auto)}`
          : `자동 선택 (${String(c.apiKey || '').trim() ? '모델 목록을 불러오면 고릅니다' : '키를 저장하면 고릅니다'})`;
        const options = [el('option', { value: '', selected: !chosen }, autoLabel)];
        if (chosen && !models.some((m) => m.id === chosen)) options.push(el('option', { value: chosen, selected: true }, labelOf(chosen)));
        for (const m of models) options.push(el('option', { value: m.id, selected: m.id === chosen }, m.label || m.id));
        sel.replaceChildren(...options);
      }
      const n = this.#models[id]?.length;
      modelHint.textContent = n
        ? `이 키로 쓸 수 있는 모델 ${n}개(최신순)입니다. ‘자동 선택’은 번역에 빠르고 저렴한 모델, 요약·채팅에 더 좋은 모델을 고르고, 쓰던 모델이 없어지면 다른 모델로 바꿉니다.`
        : meta.autoHint;
      if (meta.priced) {
        costNote.textContent = [priceText(settings.model('translate', id), settings.model('assist', id)), '예상 비용이 이 앱의 사용량에 집계됩니다.']
          .filter(Boolean).join(' · ');
      }
    };
    for (const [sel, key] of [[translateSel, 'translateModel'], [assistSel, 'assistModel']]) {
      sel.addEventListener('change', () => { settings.set({ [id]: { [key]: sel.value } }); savedToast(); renderModels(); });
    }

    const load = async ({ announce = true } = {}) => {
      clearTimeout(timer);
      if (!String(conf().apiKey || '').trim()) {
        if (announce) setResult(result, 'error', '먼저 API 키를 입력하세요.');
        return;
      }
      const mine = ++seq;
      if (announce) setResult(result, 'busy', '모델 목록을 불러오는 중…');
      try {
        const { models, changes } = await this.#refreshModels(id);
        if (mine !== seq || !result.isConnected) return;
        this.#models[id] = Array.isArray(models) ? models : [];
        renderModels();
        const changed = this.#describeChanges(changes);
        if (announce || changed) setResult(result, 'ok', `모델 ${this.#models[id].length}개를 불러왔습니다.${changed ? ` ${changed}` : ''}`);
      } catch (err) {
        if (mine === seq && result.isConnected) setResult(result, 'error', err?.message || '모델 목록을 불러오지 못했습니다.');
      }
    };

    renderModels();
    // Automatic listing only outside a ?mock=1 session (tests and demos never reach a real API by themselves).
    const listAutomatically = !settings.isMockSession;
    if (listAutomatically && String(conf().apiKey || '').trim() && !this.#models[id]) queueMicrotask(() => load({ announce: false }));
    return el('div', { class: 'subsection' },
      el('h3', { class: 'subsection-title' }, icon('key', { size: 16 }), meta.title),
      this.#secretField({
        label: 'API 키', value: conf().apiKey || '', placeholder: meta.placeholder, result,
        onSave: (v) => {
          if (v === (conf().apiKey || '')) return;
          settings.set({ [id]: { apiKey: v } });
          delete this.#models[id];
          renderModels(); // (the cards' '키 저장됨' badge follows on their next render: no layout shift above 테스트)
          clearTimeout(timer);
          // A new key: read its models (unless 테스트 follows right away, which reads them anyway).
          if (v && listAutomatically) timer = setTimeout(() => load(), KEY_LIST_DELAY_MS);
        },
        onTest: async () => {
          clearTimeout(timer);
          const mine = ++seq;
          const res = await this.#testProvider(id);
          if (res?.ok && mine === seq) {
            if (Array.isArray(res.models)) {
              this.#models[id] = res.models;
              renderModels();
            } else {
              load({ announce: false });
            }
          }
          return res;
        },
      }),
      el('div', { class: 'field-row', style: { marginTop: '14px' } },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '번역 모델'), translateSel),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '요약·채팅·설명 모델'), assistSel)),
      modelHint,
      el('div', { class: 'btn-row' }, button('모델 목록 불러오기', { icon: 'refresh', size: 'sm', onClick: () => load() })),
      costNote,
      meta.privacy ? note('shield', meta.privacy) : null,
      el('p', { class: 'howto key-howto' }, ...meta.howto(extLink(meta.keyUrl, meta.keyLink))));
  }

  /** The key's live models and what changed in the model choice (deps.refreshModels, js/ai/models.js). */
  async #refreshModels(id) {
    if (this.#deps.refreshModels) return this.#deps.refreshModels(id);
    const provider = this.#provider(id);
    if (!provider?.listModels) throw new Error('AI 모듈을 불러오지 못했습니다.');
    return { models: await provider.listModels(), changes: [] };
  }

  #describeChanges(changes) {
    try {
      return changes?.length ? this.#deps.describeModelChanges?.(changes) || '' : '';
    } catch (err) {
      console.warn('[settings-view] describeModelChanges', err);
      return '';
    }
  }

  #relayDetail() {
    const relay = this.#deps.relay;
    if (!relay) {
      return el('div', { class: 'subsection' },
        note('alert-triangle', '초대 코드 모듈을 불러오지 못했습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.', 'is-warning'));
    }
    const r = settings.get().relay || {};
    const urlInput = el('input', {
      class: 'input', type: 'url', value: settings.relayUrl(), placeholder: 'https://….workers.dev', autocomplete: 'off',
      spellcheck: 'false', autocapitalize: 'off', 'aria-label': '서버 주소',
    });
    const urlResult = el('div', { class: 'test-result', 'aria-live': 'polite' });
    const showUrlState = () => {
      const url = settings.relayUrl();
      if (!url) setResult(urlResult, 'error', '서버 주소가 없습니다. 초대해 준 분에게 서버 주소를 받아 입력하세요.');
      else if (!relay.isRelayOriginAllowed(url)) setResult(urlResult, 'error', '이 주소는 앱의 보안 정책(CSP connect-src)에 없어 브라우저가 연결을 막습니다. 기본 서버 주소를 쓰거나, 관리자가 index.html의 connect-src에 이 주소를 추가해야 합니다.');
      else clearResult(urlResult);
    };
    urlInput.addEventListener('change', () => {
      const raw = urlInput.value.trim();
      if (raw && !/^https?:\/\/[^\s/]+/i.test(raw)) {
        setResult(urlResult, 'error', '서버 주소는 https://로 시작하는 전체 주소로 입력하세요.');
        return;
      }
      relay.saveRelayUrl(raw);
      urlInput.value = settings.relayUrl();
      this.#mePromise = null;
      showUrlState();
      savedToast();
    });
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); urlInput.blur(); } });
    showUrlState();

    const codeResult = el('div', { class: 'test-result', 'aria-live': 'polite' });
    const models = el('div', { class: 'field-row', style: { marginTop: '14px' } });
    const modelHint = el('p', { class: 'price-hint' });
    const renderModels = () => {
      const allowed = settings.get().relay?.allowedModels || [];
      const select = (kind, key, label) => {
        const current = settings.model(kind);
        const ids = allowed.length ? allowed : [current];
        const node = el('select', { class: 'select', 'aria-label': label, disabled: ids.length < 2 },
          ids.map((id) => el('option', { value: id, selected: id === current }, modelLabel(id))));
        node.addEventListener('change', () => { settings.set({ relay: { [key]: node.value } }); savedToast(); renderModels(); });
        return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), node);
      };
      models.replaceChildren(select('translate', 'translateModel', '번역 모델'), select('assist', 'assistModel', '요약·채팅·설명 모델'));
      modelHint.textContent = !allowed.length ? '테스트를 누르면 이 초대 코드로 쓸 수 있는 모델이 표시됩니다.'
        : allowed.length === 1 ? `이 초대 코드로는 ${relay.modelShortName(allowed[0])}만 쓸 수 있습니다. ${priceText(allowed[0], allowed[0])}`
          : `이 초대 코드로 쓸 수 있는 모델만 표시됩니다. ${priceText(settings.model('translate'), settings.model('assist'))}`;
    };
    renderModels();

    const showMe = (promise) => {
      setResult(codeResult, 'busy', '초대 코드를 확인하는 중…');
      promise.then((me) => {
        if (!codeResult.isConnected) return;
        setResult(codeResult, 'ok', relay.formatMe(me));
        renderModels();
        this.#updateRelayCard(me);
      }, (err) => {
        if (codeResult.isConnected) setResult(codeResult, 'error', err?.message || '초대 코드를 확인하지 못했습니다.');
      });
    };
    if (r.code && settings.relayUrl()) queueMicrotask(() => showMe(this.#loadMe()));

    return el('div', { class: 'subsection' },
      el('h3', { class: 'subsection-title' }, icon('key', { size: 16 }), '초대 코드'),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, '서버 주소'), urlInput,
        el('span', { class: 'field-hint' }, '초대해 준 분이 알려 준 주소입니다. 보통은 바꿀 필요가 없습니다.')),
      urlResult,
      el('div', { style: { marginTop: '14px' } }, this.#secretField({
        label: '초대 코드', value: r.code || '', placeholder: 'PR-XXXX-XXXX', result: codeResult, emptyMessage: '초대 코드를 먼저 입력하세요.',
        normalize: (v) => relay.normalizeInviteCode(v),
        onSave: (v) => {
          if (v === (settings.get().relay?.code || '')) return;
          relay.saveInviteCode(v);
          this.#mePromise = null;
          clearResult(codeResult);
          renderModels();
          this.#renderUsage();
          // The cards above are left as they are: a layout change here would move the 테스트 button between
          // mousedown and click. They show the invitee layout from the next provider switch or visit.
        },
        onTest: async () => {
          const code = settings.get().relay?.code || '';
          if (!relay.isInviteCode(code)) return { ok: false, message: '초대 코드 형식이 올바르지 않습니다. PR-XXXX-XXXX 형식인지 확인해 주세요.' };
          try {
            const me = await this.#loadMe(true);
            renderModels();
            this.#renderUsage();
            this.#updateRelayCard(me);
            return { ok: true, message: relay.formatMe(me) };
          } catch (err) {
            return { ok: false, message: err?.message || '초대 코드를 확인하지 못했습니다.' };
          }
        },
      })),
      models,
      modelHint,
      note('shield', '번역·요약·채팅할 문장은 초대 코드 서버(Cloudflare)를 거쳐 Anthropic의 Claude로 전송됩니다. 서버에는 사용량(토큰 수·금액)만 기록되며, 하루 사용 한도는 초대한 분이 정합니다.'),
      el('details', { class: 'howto' },
        el('summary', {}, '초대 코드 쓰는 법'),
        el('ol', {},
          el('li', {}, '초대해 준 분에게 받은 링크(', el('code', {}, '…/#/join/PR-…'), ')를 이 브라우저에서 열면 자동으로 등록됩니다.'),
          el('li', {}, '코드만 받았다면 위 칸에 붙여 넣고 ', el('b', {}, '테스트'), '를 누르세요. 이름과 오늘 사용량이 보이면 준비가 끝났습니다.'),
          el('li', {}, '하루 한도를 다 쓰면 그날은 번역·요약·채팅이 멈추고, 한국 시간 0시에 다시 열립니다.'))));
  }

  /** GET /relay/me once per view (force: a fresh check, e.g. 테스트). */
  #loadMe(force = false) {
    const relay = this.#deps.relay;
    if (!relay) return Promise.reject(new Error('초대 코드 모듈을 불러오지 못했습니다.'));
    if (force || !this.#mePromise) {
      const promise = relay.refreshMe();
      this.#mePromise = promise;
      promise.catch(() => { if (this.#mePromise === promise) this.#mePromise = null; });
    }
    return this.#mePromise;
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
  #secretField({ label, value = '', placeholder = '', onSave, onTest, hint, result = null, normalize = null, emptyMessage = '키를 먼저 입력하세요.' }) {
    const input = el('input', {
      class: 'input', type: 'password', value, placeholder, autocomplete: 'off', spellcheck: 'false',
      'aria-label': label, autocapitalize: 'off',
    });
    result ||= el('div', { class: 'test-result', 'aria-live': 'polite' });
    const save = () => {
      const v = normalize ? normalize(input.value) : input.value.trim();
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
        if (!input.value) { setResult(result, 'error', emptyMessage); return; }
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
    this.#renderUsage = (force = false) => {
      if (settings.get().provider === 'relay') this.#renderRelayUsage(host, force);
      else this.#renderLocalUsage(host);
    };
    this.#renderUsage();
    const body = el('div', {}, host, el('div', { class: 'btn-row' }, button('새로 고침', { icon: 'refresh', size: 'sm', onClick: () => this.#renderUsage(true) })));
    return section('usage', '사용량', 'coins', '번역·요약·채팅에 쓴 AI 사용량과 비용입니다.', body);
  }

  /** Invite-code users: the relay's own count for today (KST), not this browser's estimates. */
  async #renderRelayUsage(host, force) {
    const relay = this.#deps.relay;
    if (!relay) { host.replaceChildren(el('p', { class: 'field-hint' }, '초대 코드 모듈을 불러오지 못했습니다.')); return; }
    if (!settings.isAiReady()) { host.replaceChildren(el('p', { class: 'field-hint' }, '초대 코드를 입력하면 오늘 사용량이 표시됩니다.')); return; }
    const busy = el('div', {});
    setResult(busy, 'busy', '초대 코드 서버에서 오늘 사용량을 불러오는 중…');
    host.replaceChildren(busy);
    const promise = this.#loadMe(force);
    let me;
    try {
      me = await promise;
    } catch (err) {
      if (this.#mePromise !== null && this.#mePromise !== promise) return; // a newer request owns the panel
      const failed = el('div', {});
      setResult(failed, 'error', err?.message || '사용량을 불러오지 못했습니다.');
      host.replaceChildren(failed);
      return;
    }
    if (this.#mePromise !== promise || !host.isConnected) return;
    const ratio = me.dailyLimitUsd > 0 ? me.todayUsd / me.dailyLimitUsd : me.todayUsd > 0 ? 1 : 0;
    host.replaceChildren(
      el('div', { class: 'usage-stats' },
        stat('기간', '오늘 (한국 시간)'),
        stat('사용 / 하루 한도', `${formatUsd(me.todayUsd)} / ${formatUsd(me.dailyLimitUsd)}`),
        stat('AI 호출', `${fmtInt(me.todayRequests)}회`)),
      el('div', { class: 'relay-meter' },
        progressBar(ratio, { label: '하루 한도 대비 오늘 사용량' }).el,
        el('span', { class: 'field-hint' }, `${me.name ? `${me.name}님 · ` : ''}${resetText(me.resetsAt)}`)),
      note('info', '초대 코드 서버가 집계한 금액입니다. 하루 한도는 초대한 분이 정하며, 다 쓰면 그날은 번역·요약·채팅이 멈춥니다.'));
  }

  #renderLocalUsage(host) {
    const summary = this.#deps.usage?.usageSummary ? safeCall(() => this.#deps.usage.usageSummary()) : null;
    if (!summary) {
      host.replaceChildren(el('p', { class: 'field-hint' }, this.#deps.usage ? '아직 사용 기록이 없습니다.' : '사용량 모듈을 불러오지 못했습니다.'));
      return;
    }
    const isPriced = typeof this.#deps.usage?.isPriced === 'function' ? this.#deps.usage.isPriced : () => true;
    const unpriced = new Set(); // 'GPT', 'Gemini', …: no prices in the app
    const rows = Object.entries(summary.byModel || {}).map(([model, v]) => {
      const info = typeof v === 'number' ? { usd: v } : (v || {});
      const priced = isPriced(model);
      if (!priced) unpriced.add(unpricedFamily(model));
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
        stat('예상 비용', `${formatUsd(summary.usd || 0)}${unpriced.size ? ` + ${[...unpriced].join('·')}` : ''}`),
        stat('AI 호출', `${fmtInt(summary.calls || 0)}회`)),
      rows.length ? el('div', { class: 'md-table-wrap' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, el('th', {}, '모델'), el('th', { class: 'num' }, '호출'), el('th', { class: 'num' }, '입력 토큰'), el('th', { class: 'num' }, '출력 토큰'), el('th', { class: 'num' }, '비용'))),
        el('tbody', {}, rows))) : null,
      unpriced.size ? note('info', `${[...unpriced].join('·')} 사용 비용은 요금 정보가 없어 예상 비용에 포함되지 않습니다(비용 미집계). 각 회사 결제 화면(OpenAI Platform, Google AI Studio)에서 확인하세요.`) : null,
      note('info', '토큰 수와 공개 요금표로 계산한 추정치이며 이 브라우저에서 쓴 양만 집계됩니다. 실제 청구액은 각 AI 서비스 콘솔에서 확인하세요.'),
    ].filter(Boolean));
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
          'API 키·초대 코드와 GitHub 토큰은 이 브라우저의 저장소(localStorage)에만 보관되며, 각각 해당 서비스로 요청할 때만 사용됩니다. 논문 PDF와 번역은 이 브라우저(IndexedDB)와, 동기화를 켠 경우 내 GitHub 비공개 저장소에 저장됩니다.'),
        el('p', { class: 'field-hint', style: { margin: '0 0 12px' } },
          '보내는 곳: 번역·요약·채팅할 문장 → 선택한 AI(Anthropic·OpenAI·Google 중 하나, 초대 코드를 쓰면 초대 코드 서버를 거쳐 Anthropic) · 라이브러리와 메모 → 내 GitHub 저장소(동기화를 켠 경우) · ‘관련 논문’을 찾을 때 논문 제목 → Semantic Scholar.'),
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
    const ok = await confirmDialog('이 기기에 저장된 Claude·GPT·Gemini·Semantic Scholar API 키, 초대 코드·관리자 토큰과 GitHub 토큰을 모두 지울까요?\n라이브러리와 번역 데이터는 지워지지 않습니다.',
      { okLabel: '지우기', danger: true, title: '키·토큰 지우기' });
    if (!ok) return;
    settings.set({
      claude: { apiKey: '' }, openai: { apiKey: '' }, gemini: { apiKey: '' }, github: { token: '' }, semanticScholar: { apiKey: '' },
      relay: { code: '', adminToken: '', name: '', allowedModels: [], translateModel: '', assistModel: '', autoModels: { translate: '', assist: '' } },
    });
    this.#mePromise = null;
    this.#models = {};
    try { await this.#deps.library?.reconfigureSync?.(); } catch (err) { console.warn('[settings-view] reconfigureSync', err); }
    toast('이 기기에서 키와 토큰을 지웠습니다.', { kind: 'success' });
    this.#render();
  }

  // -------------------------------------------------------------- invites

  /** 초대 코드 관리 (owner): collapsed; loads nothing until opened with an admin token saved. */
  #invitesSection() {
    const body = el('div', { class: 'relay-admin-body' });
    const summary = el('summary', {}, '관리 화면 열기');
    const panel = el('details', { class: 'relay-admin' }, summary, body);
    panel.addEventListener('toggle', () => {
      summary.textContent = panel.open ? '관리 화면 닫기' : '관리 화면 열기';
      if (panel.open) this.#renderAdmin(body);
    });
    return section('invites', '초대 코드 관리 (관리자)', 'key',
      '동료에게 나눠 줄 초대 코드를 만들고 사용량을 봅니다. 초대 코드 서버의 관리자 토큰이 있어야 쓸 수 있습니다.', panel);
  }

  #renderAdmin(host) {
    const relay = this.#deps.relay;
    if (!relay) {
      host.replaceChildren(note('alert-triangle', '초대 코드 모듈을 불러오지 못해 관리 화면을 쓸 수 없습니다.', 'is-warning'));
      return;
    }
    if (!settings.get().relay?.adminToken) {
      host.replaceChildren(this.#adminTokenForm(host),
        el('p', { class: 'field-hint' }, '관리자 토큰은 초대 코드 서버(Cloudflare Worker)를 배포할 때 ADMIN_TOKEN 비밀 값으로 정한 문자열입니다.'));
      return;
    }
    const list = el('div', { class: 'relay-codes', 'aria-live': 'polite' });
    const created = el('div', {});
    host.replaceChildren(
      this.#adminTokenSaved(host),
      this.#adminCreateForm(list, created),
      created,
      el('div', { class: 'subsection' }, el('h3', { class: 'subsection-title' }, icon('list', { size: 16 }), '초대 코드 목록'), list),
      this.#adminUsage());
    this.#loadCodes(list);
  }

  /** The token is checked against the server before it is saved, and never shown again. */
  #adminTokenForm(host) {
    const relay = this.#deps.relay;
    const input = el('input', {
      class: 'input', type: 'password', placeholder: '관리자 토큰', autocomplete: 'off', spellcheck: 'false',
      autocapitalize: 'off', 'aria-label': '관리자 토큰',
    });
    const result = el('div', { class: 'test-result', 'aria-live': 'polite' });
    const save = button('확인하고 저장', { icon: 'check-circle', kind: 'primary', onClick: async () => {
      const token = input.value.trim();
      if (!token) { setResult(result, 'error', '관리자 토큰을 입력하세요.'); return; }
      save.disabled = true;
      setResult(result, 'busy', '관리자 토큰을 확인하는 중…');
      try {
        await relay.listCodes({ token });
        input.value = '';
        settings.set({ relay: { adminToken: token } });
        toast('관리자 토큰을 저장했습니다.', { kind: 'success' });
        this.#renderAdmin(host);
      } catch (err) {
        setResult(result, 'error', err?.message || '관리자 토큰을 확인하지 못했습니다.');
      } finally {
        save.disabled = false;
      }
    } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
    return el('div', { class: 'field' },
      el('span', { class: 'field-label' }, '관리자 토큰'),
      el('div', { class: 'input-group' }, input, save),
      el('span', { class: 'field-hint' }, '저장한 토큰은 다시 표시되지 않습니다. 내 기기에만 저장하고, 공용 PC에는 저장하지 마세요.'),
      result);
  }

  #adminTokenSaved(host) {
    return el('div', { class: 'relay-token' },
      el('span', { class: 'badge is-ok' }, icon('check', { size: 12 }), '관리자 토큰 저장됨'),
      el('span', { class: 'field-hint' }, '이 기기에만 저장되어 있으며 다시 표시되지 않습니다.'),
      button('지우기', { icon: 'trash', size: 'sm', kind: 'ghost', onClick: () => {
        settings.set({ relay: { adminToken: '' } });
        toast('이 기기에서 관리자 토큰을 지웠습니다.', { kind: 'success' });
        this.#renderAdmin(host);
      } }));
  }

  #adminCreateForm(list, created) {
    const relay = this.#deps.relay;
    const name = el('input', { class: 'input', type: 'text', maxlength: String(relay.NAME_MAX), placeholder: '예: 김간호', 'aria-label': '이름', autocomplete: 'off' });
    const limit = el('input', { class: 'input', type: 'number', min: '0', max: String(relay.DAILY_LIMIT_MAX), step: '0.1', value: '0.5', 'aria-label': '하루 한도 (달러)' });
    const pick = modelSetPicker(relay, relay.MODEL_SETS[0].models);
    const result = el('div', { class: 'test-result', 'aria-live': 'polite' });
    const submit = button('코드 만들기', { icon: 'plus', kind: 'primary', onClick: async () => {
      submit.disabled = true;
      setResult(result, 'busy', '초대 코드를 만드는 중…');
      try {
        const v = limit.value.trim();
        const code = await relay.createCode({ name: name.value, dailyLimitUsd: v === '' ? undefined : Number(v), allowedModels: pick.value() });
        clearResult(result);
        name.value = '';
        this.#showCreated(created, code);
        await this.#loadCodes(list);
      } catch (err) {
        setResult(result, 'error', err?.message || '초대 코드를 만들지 못했습니다.');
      } finally {
        submit.disabled = false;
      }
    } });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit.click(); } });
    const ratio = Math.round(PRICES['claude-sonnet-5-5'].input / PRICES['claude-haiku-5-5'].input);
    return el('div', { class: 'subsection' },
      el('h3', { class: 'subsection-title' }, icon('plus', { size: 16 }), '새 초대 코드'),
      el('div', { class: 'relay-create' },
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '이름'), name),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '하루 한도 ($)'), limit),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, '모델'), pick.el)),
      el('p', { class: 'field-hint' }, `하루 한도는 $0~$${relay.DAILY_LIMIT_MAX}이며 한국 시간 0시에 초기화됩니다. Sonnet은 요금이 Haiku의 약 ${ratio}배라 한도가 빨리 찹니다.`),
      el('div', { class: 'btn-row' }, submit),
      result);
  }

  #showCreated(host, c) {
    const relay = this.#deps.relay;
    host.replaceChildren(el('div', { class: 'note is-success relay-created', role: 'status' },
      icon('check-circle', { size: 16 }),
      el('div', {},
        el('div', {}, `${c.name}님의 초대 코드를 만들었습니다: `, el('code', {}, c.code)),
        el('div', { class: 'btn-row' },
          copyButton('초대 메시지 복사', () => relay.inviteMessage(c), '초대 메시지를 복사했습니다. 메신저에 붙여 넣어 보내세요.', 'primary'),
          copyButton('코드 복사', () => c.code, '초대 코드를 복사했습니다.')))));
  }

  async #loadCodes(list) {
    const relay = this.#deps.relay;
    const busy = el('div', {});
    setResult(busy, 'busy', '초대 코드 목록을 불러오는 중…');
    list.replaceChildren(busy);
    let data;
    try {
      data = await relay.listCodes();
    } catch (err) {
      const failed = el('div', {});
      setResult(failed, 'error', err?.message || '초대 코드 목록을 불러오지 못했습니다.');
      list.replaceChildren(failed, el('div', { class: 'btn-row' }, button('다시 불러오기', { icon: 'refresh', size: 'sm', onClick: () => this.#loadCodes(list) })));
      return;
    }
    const codes = [...data.codes].sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt);
    const active = codes.filter((c) => c.active).length;
    list.replaceChildren(
      el('div', { class: 'usage-stats' },
        stat('오늘 전체', `${formatUsd(data.todayTotalUsd)} / ${formatUsd(data.globalDailyLimitUsd)}`),
        stat('이번 달 전체', formatUsd(data.monthTotalUsd)),
        stat('사용 중인 코드', `${active} / ${codes.length}개`)),
      codes.length
        ? el('ul', { class: 'relay-code-list' }, codes.map((c) => this.#codeItem(c, list)))
        : el('p', { class: 'field-hint' }, '아직 만든 초대 코드가 없습니다. 위에서 이름과 하루 한도를 정해 만들어 보세요.'),
      el('div', { class: 'btn-row' }, button('새로 고침', { icon: 'refresh', size: 'sm', onClick: () => this.#loadCodes(list) })));
  }

  #codeItem(c, list) {
    const relay = this.#deps.relay;
    return el('li', { class: `relay-code${c.active ? '' : ' is-inactive'}`, dataset: { code: c.code } },
      el('div', { class: 'relay-code-head' },
        el('span', { class: 'relay-code-name' }, c.name || '(이름 없음)'),
        el('code', { class: 'relay-code-value' }, c.code),
        el('span', { class: `badge ${c.active ? 'is-ok' : 'is-error'}` }, c.active ? '사용 중' : '중지됨')),
      el('div', { class: 'relay-code-meta' },
        el('span', {}, `모델 ${relay.modelSetLabel(c.allowedModels)}`),
        el('span', {}, `하루 한도 ${formatUsd(c.dailyLimitUsd)}`),
        el('span', {}, `오늘 ${formatUsd(c.todayUsd)}`),
        el('span', {}, `이번 달 ${formatUsd(c.monthUsd)}`),
        el('span', {}, `누적 ${formatUsd(c.totalUsd)} · ${fmtInt(c.totalRequests)}회`),
        el('span', {}, c.lastUsedAt ? `마지막 사용 ${formatKst(c.lastUsedAt)}` : '아직 사용하지 않음')),
      el('div', { class: 'relay-code-actions' },
        copyButton('초대 메시지 복사', () => relay.inviteMessage(c), '초대 메시지를 복사했습니다. 메신저에 붙여 넣어 보내세요.'),
        copyButton('코드 복사', () => c.code, '초대 코드를 복사했습니다.'),
        button('한도·모델 수정', { icon: 'pencil', size: 'sm', kind: 'ghost', onClick: () => this.#editCode(c, list) }),
        button(c.active ? '중지' : '다시 사용', { icon: c.active ? 'stop' : 'play', size: 'sm', kind: 'ghost', onClick: () => this.#toggleCode(c, list) })));
  }

  #editCode(c, list) {
    const relay = this.#deps.relay;
    const name = el('input', { class: 'input', type: 'text', value: c.name, maxlength: String(relay.NAME_MAX), 'aria-label': '이름', autocomplete: 'off' });
    const limit = el('input', { class: 'input', type: 'number', min: '0', max: String(relay.DAILY_LIMIT_MAX), step: '0.1', value: String(c.dailyLimitUsd), 'aria-label': '하루 한도 (달러)' });
    const pick = modelSetPicker(relay, c.allowedModels);
    modal({
      title: '초대 코드 수정',
      size: 'sm',
      body: el('div', { class: 'relay-edit' },
        el('p', { class: 'field-hint', style: { marginTop: 0 } }, el('code', {}, c.code), ' · 바꾼 내용은 바로 적용됩니다.'),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '이름'), name),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, '하루 한도 ($)'), limit),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, '모델'), pick.el)),
      actions: [
        { label: '취소' },
        { label: '저장', kind: 'primary', onClick: async () => {
          const patch = {};
          if (name.value.trim() !== c.name) patch.name = name.value;
          const v = limit.value.trim();
          if (v === '' || Number(v) !== c.dailyLimitUsd) patch.dailyLimitUsd = v === '' ? NaN : Number(v);
          const models = pick.value();
          if (models.join(',') !== c.allowedModels.join(',')) patch.allowedModels = models;
          if (!Object.keys(patch).length) return true;
          await relay.updateCode(c.code, patch); // a Korean validation/server error keeps the dialog open (toast)
          toast('초대 코드를 수정했습니다.', { kind: 'success' });
          this.#loadCodes(list);
          return true;
        } },
      ],
    });
  }

  async #toggleCode(c, list) {
    const relay = this.#deps.relay;
    if (c.active) {
      const ok = await confirmDialog(`${c.name}님의 초대 코드(${c.code})를 중지할까요?\n중지하면 이 코드로는 바로 번역·요약·채팅을 쓸 수 없습니다. ‘다시 사용’으로 되돌릴 수 있습니다.`,
        { okLabel: '중지', danger: true, title: '초대 코드 중지' });
      if (!ok) return;
    }
    try {
      await relay.updateCode(c.code, { active: !c.active });
      toast(c.active ? '초대 코드를 중지했습니다.' : '초대 코드를 다시 쓸 수 있게 했습니다.', { kind: 'success' });
    } catch (err) {
      toast(err?.message || '초대 코드를 바꾸지 못했습니다.', { kind: 'error' });
    }
    await this.#loadCodes(list);
  }

  /** Daily totals, loaded when opened. */
  #adminUsage() {
    const relay = this.#deps.relay;
    const body = el('div', {});
    const details = el('details', { class: 'howto' }, el('summary', {}, '날짜별 사용량 (최근 30일)'), body);
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      setResult(body, 'busy', '사용량을 불러오는 중…');
      try {
        const { days } = await relay.usage({ days: 30 });
        const rows = days.filter((d) => d.requests || d.usd).sort((a, b) => b.day.localeCompare(a.day));
        body.className = '';
        body.replaceChildren(rows.length
          ? el('div', { class: 'md-table-wrap' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, el('th', {}, '날짜'), el('th', { class: 'num' }, '요청'), el('th', { class: 'num' }, '금액'), el('th', {}, '모델별'))),
            el('tbody', {}, rows.map((d) => el('tr', {},
              el('td', {}, d.day),
              el('td', { class: 'num' }, fmtInt(d.requests)),
              el('td', { class: 'num' }, formatUsd(d.usd)),
              el('td', {}, byModelText(relay, d.byModel)))))))
          : el('p', { class: 'field-hint' }, '최근 30일 동안 사용 기록이 없습니다.'));
      } catch (err) {
        setResult(body, 'error', err?.message || '사용량을 불러오지 못했습니다.');
      }
    });
    return details;
  }
}

// ------------------------------------------------------------------- join

/**
 * #/join/<CODE>: check the invite code, switch this browser to it, welcome the person by name. The code is taken
 * out of the address bar once registered; an invalid code leaves the settings as they were.
 * @param {HTMLElement} container
 * @param {{ code: string, deps: object, navigate: (hash: string) => void }} opts
 * @returns {{ destroy: () => void }}
 */
export function mountJoinView(container, { code, deps, navigate }) {
  document.title = '초대 코드 · 논문 리더';
  const controller = new AbortController();
  let alive = true;
  const show = (node) => { if (alive) container.replaceChildren(node); };
  const toLibrary = { label: '라이브러리로', icon: 'arrow-left', onClick: () => navigate('#/') };
  const toSettings = { label: '코드 직접 입력', icon: 'key', onClick: () => navigate('#/settings/ai') };
  const run = async () => {
    show(el('div', { class: 'boot' }, el('div', { class: 'boot-inner' }, spinner(18), '초대 코드를 확인하는 중…')));
    const relay = deps.relay;
    if (!relay) {
      show(messageScreen({
        title: '초대 코드 기능을 불러오지 못했습니다',
        message: '페이지를 새로 고친 뒤 다시 시도해 주세요. 계속되면 초대해 준 분에게 알려 주세요.',
        actions: [{ label: '새로 고침', kind: 'primary', icon: 'refresh', onClick: () => location.reload() }, toLibrary],
      }));
      return;
    }
    const normalized = relay.normalizeInviteCode(code);
    if (!relay.isInviteCode(normalized)) {
      show(messageScreen({
        title: '초대 링크가 올바르지 않습니다',
        message: `링크에 들어 있는 코드(${code || '없음'})가 초대 코드 형식(PR-XXXX-XXXX)이 아닙니다.\n받은 링크 전체가 복사되었는지 확인하거나, 설정에서 코드를 직접 입력해 주세요.`,
        actions: [{ ...toSettings, kind: 'primary' }, toLibrary],
      }));
      return;
    }
    const s = settings.get();
    const hadKey = Boolean(s.claude?.apiKey || s.openai?.apiKey || s.gemini?.apiKey);
    try {
      const me = await relay.registerInviteCode(normalized, { signal: controller.signal });
      if (!alive) return;
      history.replaceState(null, '', '#/');
      const who = me.name ? `${me.name}님, ` : '';
      const models = me.allowedModels.map(relay.modelShortName).join(', ') || '-';
      show(messageScreen({
        iconName: 'check-circle', tone: 'success',
        title: me.name ? `환영합니다, ${me.name}님` : '환영합니다',
        message: [
          `${who}초대 코드가 등록되었습니다. 이제 키 없이 번역·요약·채팅을 쓸 수 있습니다.`,
          `하루 한도 ${formatUsd(me.dailyLimitUsd)} · 모델: ${models} · 한도는 매일 0시(한국 시간)에 초기화됩니다.`,
          hadKey ? '원래 쓰던 API 키는 그대로 있어 설정 → AI 번역에서 언제든 다시 고를 수 있습니다.' : '',
        ].filter(Boolean).join('\n'),
        actions: [{ label: '논문 읽으러 가기', kind: 'primary', icon: 'arrow-right', onClick: () => navigate('#/') }],
      }));
    } catch (err) {
      if (!alive || err?.code === 'aborted') return;
      show(messageScreen({
        title: '초대 코드를 확인하지 못했습니다',
        message: `${err?.message || '초대 코드를 확인하지 못했습니다.'}\n코드: ${normalized}`,
        actions: [{ label: '다시 시도', kind: 'primary', icon: 'refresh', onClick: run }, toSettings, toLibrary],
      }));
    }
  };
  run();
  return { destroy: () => { alive = false; controller.abort(); } };
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

function note(iconName, text, kind = '') {
  return el('div', { class: kind ? `note ${kind}` : 'note' }, icon(iconName, { size: 16 }), el('div', {}, text));
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

function clearResult(node) {
  node.className = 'test-result';
  node.replaceChildren();
}

/** Segmented 'Haiku만' / 'Haiku + Sonnet'; a code with another set keeps it until a button is pressed. */
function modelSetPicker(relay, initial) {
  let models = [...(initial || [])];
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': '모델' });
  const buttons = relay.MODEL_SETS.map((set) => button(set.label, {
    size: 'sm',
    pressed: set.models.length === models.length && set.models.every((m) => models.includes(m)),
    onClick: () => {
      models = [...set.models];
      buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(relay.MODEL_SETS[i] === set)));
    },
  }));
  group.append(...buttons);
  return { el: group, value: () => [...models] };
}

/** A small button that copies `text()`; when the clipboard is unavailable the text is shown to copy by hand. */
function copyButton(label, text, done, kind = 'ghost') {
  return button(label, { icon: 'copy', size: 'sm', kind, onClick: async () => {
    const value = text();
    if (await copyToClipboard(value)) { toast(done, { kind: 'success' }); return; }
    const area = el('textarea', { class: 'textarea', rows: String(Math.min(8, value.split('\n').length + 1)), readonly: true, 'aria-label': label });
    area.value = value;
    modal({
      title: '직접 복사해 주세요',
      size: 'sm',
      body: el('div', {}, el('p', { class: 'field-hint', style: { marginTop: 0 } }, '브라우저가 클립보드 복사를 막았습니다. 아래 내용을 선택해 복사하세요(Ctrl+C).'), area),
      actions: [{ label: '닫기', kind: 'primary' }],
    });
    area.select();
  } });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall back below */ }
  const ta = el('textarea', { readonly: true, style: { position: 'fixed', left: '-9999px', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** '10월 18일 14:05' in Korea time. */
function formatKst(ms) {
  try { return KST.format(new Date(ms)); } catch { return '-'; }
}

function resetText(resetsAt) {
  const t = Date.parse(resetsAt || '');
  return Number.isFinite(t) ? `한도는 ${formatKst(t)}(한국 시간)에 초기화됩니다.` : '한도는 매일 0시(한국 시간)에 초기화됩니다.';
}

function byModelText(relay, byModel) {
  return Object.entries(byModel || {}).map(([model, v]) => {
    const usd = typeof v === 'number' ? v : Number(v?.usd);
    return `${relay.modelShortName(model)} ${Number.isFinite(usd) ? formatUsd(usd) : ''}`.trim();
  }).join(' · ') || '-';
}

/** 'Claude Haiku 5.5 (빠름·저렴)' for a known Claude model id; other ids as they are. */
function modelLabel(id) {
  return CLAUDE_MODELS.find((m) => m.id === id)?.label || id;
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

/** 'GPT' / 'Gemini' for a model without prices in the app (its id otherwise). */
function unpricedFamily(model) {
  const id = String(model || '');
  if (/^(models\/)?gemini/i.test(id)) return 'Gemini';
  if (/^(ft:)?(gpt|o\d|chatgpt)/i.test(id)) return 'GPT';
  return id || '기타';
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

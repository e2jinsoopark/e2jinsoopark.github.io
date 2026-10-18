# Automatic model choice and self-healing (`js/ai/models.js`)

Why: a model id saved in settings stops working when the provider retires it or a new key may not use it
(Gemini answered "gemini-2.5-flash … not found" for new keys). Nobody should have to pick model ids by hand, and a
vanished model must not break translation, summaries or chat.

## Settings shape

Per provider (`claude`, `openai`, `gemini`, `relay`):

| Field | Meaning |
|---|---|
| `translateModel`, `assistModel` | The model the **user** picked in 설정. `''` = 자동 선택. |
| `autoModels: { translate, assist }` | The automatic picks from the key's last live model list. |

`settings.model(kind, provider = active)` = the user's pick, else `autoModels[kind]`, else `DEFAULT_MODELS[provider][kind]`
(Claude: Haiku 5.5 / Sonnet 5.5; GPT and Gemini: `''` until the first list). The relay keeps its own rule on top: a
pick or automatic model the code does not allow is skipped (`relayModel()`), with the old Haiku/Sonnet ladder last.
`isAiReady()` needs only a key (or a code): a model is picked on first use when none is known yet.

**Migration** (`settings.js` `migrate()`, settings written before `autoModels` existed): Claude fields equal to the old
prefilled defaults (`claude-haiku-5-5` / `claude-sonnet-5-5`) become 자동 선택; Gemini values the old automatic pick
produced (a plain `gemini-N-flash`, `gemini-flash-latest`) move to `autoModels`, and 2.x Gemini ids are dropped (the
first use picks a current model). Any other saved model stays the user's choice (e.g. a Gemini Pro).

## Picking (`provider.pickDefaultModel(models, kind)`, `provider.isLegacyModel(id)`)

| Provider | translate (fast/cheap) | assist (stronger) | legacy |
|---|---|---|---|
| Claude (`pickClaudeModel`) | newest Haiku | newest Sonnet → Haiku → Opus | old naming `claude-3-…`, `claude-2.x`, `claude-instant-…` |
| Relay | same as Claude, over the code's allowed models (`/relay/me`) | | same as Claude |
| Gemini (`pickGeminiModel`) | newest stable plain Flash → `gemini-flash-latest` → preview Flash → any Flash → another text model (never TTS/image/live/embedding) | same; a `-lite` Flash only when nothing else | `gemini-0/1/2.x-…` |
| GPT (`openai.js`, see `openai.md`) | newest Luna/mini class | newest Sol/standard class | GPT-3.5/4.x, o1, previews, … |

Legacy ids are picked only when the key lists nothing newer (GPT and Gemini both search the legacy ids the same way
as a last resort: an old project may only have `gpt-4o` or `gemini-2.5-flash`). A list with no text model at all
(only speech, image or embedding ids) gives `''`, and the first call fails before any paid request with “이 API 키로
쓸 수 있는 <제공자> 모델을 찾지 못했습니다…” (`not_found`, no `err.model`, so nothing is healed).

Claude picks sort by version (`claude-<family>-<major>[-<minor>][-<YYYYMMDD>]`), the undated alias before dated
snapshots; an empty or failed list falls back to `DEFAULT_MODELS.claude`. Gemini **never auto-picks Pro**: the model
list does not tell whether a key may call it (free-tier keys list Pro models but cannot use them), so Flash is the
safe default for both tasks; the user can still choose Pro, and that choice is kept.

## When the list is read (`syncModels` / `applyModelList`)

- A key is **saved** (blur/Enter; 400 ms later unless 테스트 follows) or **tested** (`getProvider(id).testKey()` lists
  the models after a successful check; the test's own list is reused when it returns `models`, as Gemini and the relay
  do), **모델 목록 불러오기**, and opening 설정 with a saved key (quietly; the status line speaks only when something
  changed or failed). Nothing is read automatically in a `?mock=1` session (no model list, and the invitee card does
  not call `/relay/me` either).
- An invite code is **registered** (`registerInviteCode`, join link) and on every visit (`refreshMe` in `app.js`): the
  list is the code's `allowedModels`, so a code that gains or loses Sonnet is followed.
- `autoModels` is set to the provider's pick for both kinds every time (자동 선택 follows the newest default). A user
  pick is reset to 자동 선택 only when the list no longer has it, it is a legacy id, or it answered not_found recently
  (see *Missing-model memory*). Legacy ids are not offered in the dropdowns, so a legacy pick can only come from old
  data. When every listed model is known to be missing, an automatic pick that is itself missing is cleared rather
  than sent again.
- The result's `changes` (`{ kind, from, to, reason: 'auto'|'unlisted'|'legacy'|'missing' }`) become the status line
  via `describeModelChanges()`: "새 키로는 쓸 수 없는 이전 모델(x)을 y(으)로 바꿨습니다.", "x 모델을 쓸 수 없어 y(으)로
  바꿨습니다.", "자동 선택: 번역 a, 요약·채팅 b."

## Self-healing (`withModelHealing`, used by `getProvider()`)

`getProvider()` returns the provider wrapped once (`rawProvider()` is the plain one; the mock is never wrapped), so
the Translator, every task (summary, chat, explain, keyPoints, quickTranslate) and `testKey()` go through it.

1. A call without a model (GPT/Gemini before any list) lists the models first and uses the pick. Calls that arrive
   while that list is being read share it (one request); each waits with its own abort signal. No usable model →
   the Korean `not_found` error above, before any paid request.
2. `err.code === 'not_found'` with `err.model` equal to the request's model, and that model is the one configured
   for a task (`settings.model(kind)`) → the model is marked missing (see below), the list is read again,
   `applyModelList` drops it (also as a user pick), and the task's new model is persisted.
3. If the new model differs: bus `'ai:model-change'` `{ provider, kind, from, to, message }` (app.js shows one warning
   toast "<old> 모델을 쓸 수 없어 <new>(으)로 바꿨습니다.") and the call is retried **once** with it. A second
   not_found is thrown as is — no loop. The next call heals again from the model it now uses, so a key whose first
   two candidates are both unusable reaches a working third model on the following call (tested).
4. Concurrent and late failures of the same model share one heal for 60 s (one list request, one toast; each request
   retried once). A heal that found nothing (the list could not be read — 401, connection failure — or there is no
   other model) is shared for 5 s only, so a later request tries again once the list is readable. A model a caller
   passed explicitly (not a configured one) is never replaced; other error codes (auth, permission, billing, quota,
   bad_request, …) are never healed.
5. Streams heal only when the error comes before the first text chunk; the final `done` event (and the tasks' results)
   name the model that answered.

Providers must report a model this key/code cannot use as `not_found` with `err.model`:
- Claude: `NotFoundError` on a Messages request.
- Relay: Anthropic's 404 "model: …" passed through, **and the relay's own 403 "이 초대 코드로는 <model>을 쓸 수
  없습니다."** (the owner removed the model from the code while a tab still asks for it; the relay's message is kept,
  `/relay/me` is re-read in the background). The relay's own 404s are about the server address and carry no model.
- Gemini: 404.
- GPT: 404 / `model_not_found` at any status, a 403 "Your organization must be verified to use the model …" (the
  verification message is kept), and the free `/v1/models` probe after an unreadable POST. A verification message
  about *streaming* is not a model problem: `stream()` falls back to one non-streaming request.

### Missing-model memory

Models that answered not_found are remembered in localStorage (`STORAGE_KEYS.models` = `pr.models.v1`):
`{ [provider]: { cred, ids: { [model]: timestamp } } }`, where `cred` is an FNV fingerprint of the API key (relay:
server address + code) — never the key itself. Entries expire after 30 days (`MISSING_TTL_MS`). Effects:
- `applyModelList` skips them in every tab and after a reload (a listed-but-unusable model is not picked again on the
  next visit; before this it cost one failed request and one toast per page load, and for the relay until the owner
  changed the code).
- Another key or code has other models: its fingerprint differs, so the memory does not apply.
- Choosing a model in 설정 (a `settings:change` patch with a non-empty `translateModel`/`assistModel`) drops its
  mark: the user wants to try it again (e.g. after verifying the OpenAI organization). If it fails again it is healed
  and remembered again.
- Blocked storage (private window): the memory lives for the page load only.

## Settings UI (`js/ui/settings-view.js`)

Cards in this order: 키 없이 쓰기 (초대 코드) · Claude · GPT (OpenAI) · Gemini (2 × 2). An **invitee** (a code is saved)
sees the invite card first with "이름님 · 오늘 $x / $y" (from `/relay/me`) and the three own-key cards under
**내 API 키 쓰기**; picking one keeps the code saved, and the invite card ("누르면 초대 코드로 돌아갑니다") switches
back in one click. The layout switches on the next card render (provider change or visit), never while a click is in
progress: re-rendering above the 테스트 button between mousedown and click made the click miss (caught by
`tests/relay-client`). A provider picked in **another tab** re-renders the cards and the detail here (bus
`settings:change` with `external: true`); before, the old card stayed checked and clicking it did nothing.

Own-key detail (one generic builder): key (password) + 테스트; 번역 모델 / 요약·채팅·설명 모델 with **자동 선택 — <label>**
first, then the key's live list newest first (legacy ids hidden; Claude shows `CLAUDE_MODELS` until a list is read);
one paragraph on how to get a key with the official page (Claude Console, OpenAI Platform API keys, Google AI Studio);
cost: Claude prices + "예상 비용이 이 앱의 사용량에 집계됩니다", GPT/Gemini "비용 미집계 — 각 회사 결제 화면에서
확인하세요". 사용량: unpriced rows say 비용 미집계, the total says "+ GPT·Gemini".

## Tests

```
node tests/models/run.mjs     # port 8172; results + screenshots: C:/Users/dindoo/Projects/pr-tools/out/models/
```

Real app in Edge; Anthropic, OpenAI and Gemini fakes (documented response shapes, CORS, JSON + SSE, 404 "model not
found" for unlisted ids; hooks for error answers, failing model lists and slow answers) and the relay fake from
`tests/relay-client`, all by route interception. `MODELS_ONLY=<regex>` runs a subset. Covers: card order
and copy for a new user; auto-pick on key save for Claude, GPT, Gemini and on code registration (incl. a saved model
that disappeared, a legacy pick, the Gemini 2.x migration, an explicit Pro kept, a code losing Sonnet); self-healing
for translation (Claude), a chat stream (GPT, plus three concurrent 404s → one heal) and a relay stream; no healing
after the first chunk, on 403/400/quota, or for an explicitly requested model; an invitee switching to GPT and back;
375 px. Screenshots `settings-ai-new-user.png`, `settings-ai-invitee-relay.png`, `settings-ai-invitee-gpt.png`.

Adversarial regressions (integration pass): the missing-model memory across a reload, a second tab, an explicit
re-pick and another key; heals whose model list fails (Claude 401, GPT connection failure) — no retry, no switch,
no second list within 5 s, healed once the list works; a healed model that 404s too (one retry per call, the next
call reaches a third model); keys with no text model (GPT non-chat ids, Gemini speech ids → one Korean error, one
shared list, no POST) and legacy-/preview-only lists; the relay's 403 for a model the code no longer allows and
OpenAI's "must be verified to use the model" 403 (both healed); switching provider in another tab mid-translation
(later batches go to the new provider with its automatic pick, the run completes); a `?mock=1` session with a saved
code and keys sends nothing to the relay or any AI API (it used to call `/relay/me` from the invitee card).

# 초대 코드 서버 (paper-relay)

동료가 **자기 API 키 없이** 논문 리더의 번역·요약·채팅을 쓰게 해 주는 작은 Cloudflare Worker입니다.

- 동료는 앱 설정에 **초대 코드**(`PR-XXXX-XXXX`)를 넣거나 초대 링크를 엽니다.
- 앱은 Claude 요청을 이 서버로 보냅니다. 서버는 코드를 확인하고, 하루 사용 한도를 지키게 하고, **소유자의 Anthropic API 키**(Cloudflare 비밀값)로 Anthropic에 전달한 뒤, 응답을 그대로(스트리밍은 실시간으로) 돌려주고 사용량을 D1 데이터베이스에 기록합니다.
- 초대 코드는 소유자가 앱 설정의 **초대 코드 관리(관리자)** 에서 관리자 토큰으로 만들고, 끄고, 한도를 바꿉니다.

API 계약(엔드포인트·오류 형식·CORS)은 `docs/RELAY.md` §1에 있습니다. 이 폴더(`relay/`)는 GitHub Pages에 올라가지 않습니다.

| 파일 | 내용 |
|---|---|
| `src/index.js` | 라우터와 엔드포인트 (`/v1/messages`, `/v1/models`, `/relay/me`, `/relay/admin/*`) |
| `src/pricing.js` | 가격표 — 앱의 `js/core/config.js` `PRICES`와 **똑같아야** 합니다 (테스트가 확인) |
| `src/meter.js` | 응답을 그대로 흘려보내면서 토큰 사용량을 읽는 부분 |
| `src/db.js`, `schema.sql` | D1 쿼리와 테이블 |
| `wrangler.jsonc` | Worker 이름·D1 연결·설정값(vars) |
| `test/` | 테스트 (`node relay/test/run.mjs`) |

## 한 번만 하는 배포 절차

Node.js가 설치된 컴퓨터에서, 터미널을 이 `relay` 폴더에서 엽니다. Cloudflare 무료 계정이면 충분합니다.

1. **Cloudflare 로그인**
   ```
   npx wrangler login
   ```
   브라우저가 열리면 Cloudflare 계정으로 로그인하고 허용합니다.

2. **데이터베이스 만들기**
   ```
   npx wrangler d1 create paper-relay
   ```
   출력에 나오는 `database_id`(긴 영문·숫자)를 복사해 `wrangler.jsonc`의 `"database_id": "00000000-0000-0000-0000-000000000000"` 자리에 붙여 넣습니다.
   (설정 파일에 자동으로 추가할지 물으면 `n`을 고르고 직접 붙여 넣는 편이 안전합니다. 연결 이름은 반드시 `DB`여야 합니다.)

3. **테이블 만들기**
   ```
   npx wrangler d1 execute paper-relay --remote --file schema.sql
   ```

4. **비밀값 넣기** — 값을 입력하라는 안내가 나오면 붙여 넣고 Enter를 누릅니다.
   ```
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ADMIN_TOKEN
   ```
   - `ANTHROPIC_API_KEY`: Claude Console에서 만든 API 키(`sk-ant-...`). 이 서버 전용 키를 따로 만드는 것을 권합니다.
   - `ADMIN_TOKEN`: 관리자용 긴 무작위 문자열(16자 이상). 예: `node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`. 앱의 초대 코드 관리 화면에 이 값을 넣습니다. 비밀번호처럼 보관하세요.
   - 아직 배포 전이라 "Worker가 없으니 새로 만들까요?"라고 물으면 `y`를 고릅니다.

5. **배포**
   ```
   npx wrangler deploy
   ```
   마지막에 `https://paper-relay.<계정 이름>.workers.dev` 주소가 나옵니다. 브라우저로 열어 `{"service":"paper-relay","ok":true}`가 보이면 정상입니다.

6. **앱에 주소 알려 주기** — 이 주소를 앱의 `RELAY_DEFAULT_URL`(`js/core/config.js`)과 `index.html` CSP의 `connect-src`(그리고 `tests/shell/run.mjs`의 `CSP` 상수)에 넣어 앱을 다시 배포합니다. 정확한 위치와 확인할 테스트는 `docs/notes/relay.md`의 "Deploy checklist"에 있습니다.

7. 앱 설정 → 초대 코드 관리(관리자)에서 관리자 토큰을 넣고 첫 초대 코드를 만들어 봅니다.

코드만 고친 뒤에는 `npx wrangler deploy`만 다시 하면 됩니다. 데이터베이스와 비밀값은 그대로 남습니다.

## 키 바꾸기(교체)

- **Anthropic API 키**: Console에서 새 키를 만든 뒤 `npx wrangler secret put ANTHROPIC_API_KEY`로 새 키를 넣습니다. 바로 적용됩니다(재배포 불필요). 그다음 Console에서 옛 키를 삭제합니다. 동료의 초대 코드는 바뀌지 않습니다.
- **관리자 토큰**: `npx wrangler secret put ADMIN_TOKEN`으로 새 값을 넣고, 앱의 초대 코드 관리 화면에 새 토큰을 다시 저장합니다. 옛 토큰은 그 즉시 거부됩니다.
- **초대 코드가 새어 나갔을 때**: 관리 화면에서 그 코드를 **사용 중지**하고 새 코드를 만들어 전달합니다. 중지된 코드는 즉시 401로 거부됩니다(기록은 남습니다).

## 한도는 이렇게 작동합니다

- **코드별 하루 한도** (`dailyLimitUsd`, 0~20달러, 기본 `DEFAULT_DAILY_LIMIT_USD` = $0.50): 오늘 그 코드로 쓴 금액이 한도 이상이면 요청을 Anthropic에 보내지 않고 429로 거절합니다 — "오늘 사용 한도($0.50)를 모두 썼습니다. 내일 오전 0시(한국 시간)에 다시 열립니다."
- **서버 전체 하루 한도** (`GLOBAL_DAILY_LIMIT_USD`, 기본 $5): 모든 코드의 오늘 합계가 이 값 이상이면 모든 코드가 429를 받습니다. 키 주인의 최대 하루 비용을 묶어 두는 안전장치입니다.
- **"오늘"은 한국 시간 달력 기준**입니다. 매일 0시(KST)에 두 한도가 모두 다시 열립니다.
- 한도는 요청을 **보내기 전에** 확인하고, 금액은 응답이 끝난 **뒤에** 기록합니다. 그래서 한도 직전의 마지막 요청 하나(또는 동시에 보낸 몇 개)만큼은 한도를 조금 넘을 수 있습니다.
- 한도 거절(429)에는 `x-should-retry: false`가 붙어 있어 Anthropic SDK가 헛되이 재시도하지 않습니다.
- **모델**: 코드마다 허용 모델(`allowedModels`: Haiku 5.5 / Sonnet 5.5 / Opus 5.5)이 있고, 허용되지 않은 모델은 403입니다. 새 코드의 기본값은 `DEFAULT_MODELS`(Haiku 5.5)입니다.
- **요청 크기**: `max_tokens`는 `MAX_TOKENS_CAP`(32000) 이하, 요청 본문은 6MB 이하.
- **토큰 말고 따로 요금이 붙는 기능은 막습니다**: 서버 도구(웹 검색 등), MCP 서버, 코드 실행 컨테이너, 빠른 모드(`speed`), 모델을 직접 지정한 `fallbacks` 목록. 앱이 쓰는 `fallbacks: "default"`(거절 시 서버가 다른 모델로 재시도)는 허용하며, 그때 실제로 쓴 모델별 요금으로 기록합니다.
- **금액 계산**: 앱과 같은 가격표(`src/pricing.js`)로 입력·출력·캐시 읽기·캐시 쓰기 토큰을 계산합니다(Haiku 5.5는 프롬프트 10만 토큰 초과 시 장문 요금). 가격표에 없는 모델은 Sonnet 5.5 요금으로 칩니다. Anthropic의 실제 청구서와 조금 다를 수 있으니 정확한 금액은 Claude Console에서 확인하세요.
- 실패한 호출(Anthropic이 4xx/5xx로 답한 경우)은 요청 수에는 들어가지만 토큰·금액은 0입니다. 스트리밍 도중 연결이 끊기면 그때까지 받은 사용량을 기록합니다.

설정값(`vars`)을 바꾸려면 `wrangler.jsonc`를 고치고 `npx wrangler deploy`를 다시 합니다. (Cloudflare 대시보드의 Worker 설정에서 바꿀 수도 있지만, 다음 `wrangler deploy` 때 `wrangler.jsonc`의 값으로 되돌아갑니다.)

| 설정값 | 기본값 | 뜻 |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://e2jinsoopark.github.io,http://localhost:*,http://127.0.0.1:*` | 이 서버를 부를 수 있는 웹사이트(쉼표 목록, `:*`는 모든 포트) |
| `UPSTREAM_URL` | `https://api.anthropic.com` | 전달할 곳(테스트에서만 바꿈) |
| `DEFAULT_MODELS` | `claude-haiku-5-5` | 새 코드의 기본 허용 모델(쉼표 목록) |
| `DEFAULT_DAILY_LIMIT_USD` | `0.5` | 새 코드의 기본 하루 한도($) |
| `GLOBAL_DAILY_LIMIT_USD` | `5` | 서버 전체 하루 한도($) |
| `MAX_TOKENS_CAP` | `32000` | 요청 하나의 `max_tokens` 상한 |

무료 요금제에 맞춰, 요청 하나마다 D1 읽기 1번(코드+오늘 사용액)과 쓰기 1번(사용량 기록)만 합니다. 다만 그림이 많이 든 아주 큰 요청은 무료 요금제의 요청당 CPU 시간 한도를 넘을 수 있습니다.

## 관리자 API (앱의 관리 화면이 쓰는 것)

모두 `Authorization: Bearer <ADMIN_TOKEN>`이 필요합니다. 금액은 달러, 시각은 ISO 문자열입니다.

| 요청 | 내용 |
|---|---|
| `GET /relay/admin/codes` | 코드 목록(최근 것 먼저)과 오늘·이번 달(KST)·누적 사용액, `todayTotalUsd`, `monthTotalUsd`, `globalDailyLimitUsd` |
| `POST /relay/admin/codes` `{ name, allowedModels?, dailyLimitUsd? }` | 새 코드(201). 이름 1~40자 |
| `PATCH /relay/admin/codes/PR-XXXX-XXXX` `{ name?, active?, allowedModels?, dailyLimitUsd? }` | 고친 코드 |
| `GET /relay/admin/usage?days=30[&code=PR-XXXX-XXXX]` | 날짜별(최근 날 먼저, 쓴 적 없는 날도 0으로 포함)·모델별 사용량 |

예 (PowerShell이나 터미널의 `curl`):
```
curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://paper-relay.<계정>.workers.dev/relay/admin/codes
curl -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" -d "{\"name\":\"Hong\",\"dailyLimitUsd\":0.5}" https://paper-relay.<계정>.workers.dev/relay/admin/codes
```

한글 이름은 앱의 초대 코드 관리 화면에서 만드는 것이 안전합니다. 한국어 Windows 콘솔의 `curl -d "…한글…"`은 본문을
CP949로 보내는 일이 있어, 받는 쪽에서는 이름이 `������님`처럼 깨집니다. 그래서 관리자 API는 UTF-8이 아닌 본문과
깨진 글자(U+FFFD)·제어 문자가 든 이름을 400(한국어 안내)으로 거절합니다. curl을 쓸 때는 UTF-8로 저장한 파일을
보내세요: `curl … --data-binary @code.json …`. 이미 깨진 이름은 `PATCH`로 새 이름을 보내면 고쳐집니다.

초대 코드를 쓰는 쪽(`x-api-key: <코드>` 또는 `Authorization: Bearer <코드>`): `POST /v1/messages`(Anthropic과 같은 형식, `?beta=true` 포함), `GET /v1/models`(허용 모델만), `GET /relay/me`(이름·허용 모델·한도·오늘 사용액·초기화 시각).

## 로컬에서 실행·테스트

```
cp .dev.vars.example .dev.vars        # 값 채우기 (.dev.vars는 git에 올라가지 않습니다)
npx wrangler d1 execute paper-relay --local --file schema.sql
npx wrangler dev                      # http://127.0.0.1:8787
```

자동 테스트(실제 Anthropic API는 부르지 않습니다 — 가짜 Anthropic 서버를 씁니다):
```
node relay/test/run.mjs               # 전부 (unit, http, sdk)
node relay/test/run.mjs unit          # 서버 없이 도는 것만
```
- wrangler와 Playwright는 `C:/Users/dindoo/Projects/pr-tools`에서 가져옵니다(다른 위치면 환경변수 `PR_TOOLS`). SDK 테스트는 Edge와 jsDelivr 접속이 필요합니다.
- 포트: Worker 8787, 가짜 Anthropic 8788, 테스트 페이지 8789. 결과는 `pr-tools/out/relay/results.json`, 로그는 같은 폴더의 `run.log`·`wrangler.log`.
- 테스트는 `TEST_MODE=1`로 띄워 `x-relay-test-now` 헤더로 시계를 옮깁니다(날짜 바뀜·한도 초기화 확인용). **운영 환경에는 `TEST_MODE`를 절대 넣지 마세요** — 넣으면 누구나 날짜를 바꿔 하루 한도를 피할 수 있습니다.

앱과 Worker를 함께 돌리는 끝-대-끝 테스트(실제 앱 + `wrangler dev` + 가짜 Anthropic, 포트 8160·8787·8788 — 위 테스트와 동시에 돌리지 마세요):
```
node tests/relay-e2e/run.mjs
```
앱의 CSP는 로컬 주소를 허용하지 않으므로, 이 테스트는 사이트 사본을 따로 만들어 씁니다. 방식은 `docs/notes/relay.md`에 있습니다.

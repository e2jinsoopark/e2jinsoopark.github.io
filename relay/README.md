# 초대 코드 서버 (paper-relay)

동료가 **자기 API 키 없이** 논문 리더의 번역·요약·채팅을 쓰게 해 주는 작은 Cloudflare Worker입니다.

- 동료는 앱 설정에 **초대 코드**(`PR-XXXX-XXXX`, 또는 소유자가 직접 정한 `EICU-2026` 같은 코드)를 넣거나 초대 링크를 엽니다.
- 앱은 Claude 요청을 이 서버로 보냅니다. 서버는 코드를 확인하고, 하루 사용 한도를 지키게 하고, **소유자의 Anthropic API 키**(Cloudflare 비밀값)로 Anthropic에 전달한 뒤, 응답을 그대로(스트리밍은 실시간으로) 돌려주고 사용량을 D1 데이터베이스에 기록합니다.
- 초대 코드는 소유자가 앱 설정의 **초대 코드 관리(관리자)** 에서 관리자 토큰으로 만들고, 끄고, 한도를 바꾸고, 지웁니다.

- 같은 초대 코드로 **공용 서재**(팀이 함께 쓰는 논문 서재)도 엽니다. 서재 데이터는 소유자의 비공개 GitHub 저장소(`dindoopark/paper-team-library`)에 있고, 이 서버가 GitHub와 똑같이 생긴 주소(`/shared/<서재>/gh/...`)로 중계합니다. GitHub 토큰은 서버에만 있고 동료의 브라우저에는 가지 않습니다. 아래 "공용 서재" 절을 보세요.

API 계약(엔드포인트·오류 형식·CORS)은 `docs/RELAY.md` §1, 공용 서재는 `docs/SHARED.md` §2에 있습니다. 이 폴더(`relay/`)는 GitHub Pages에 올라가지 않습니다.

| 파일 | 내용 |
|---|---|
| `src/index.js` | 라우터와 엔드포인트 (`/v1/messages`, `/v1/models`, `/relay/me`, `/relay/admin/*`, `/shared*`로 넘김) |
| `src/codes.js` | 초대 코드 두 종류(자동 `PR-XXXX-XXXX` / 직접 정한 코드): 만들기, 입력 정규화, 검사 |
| `src/auth.js`, `src/limiter.js` | 초대 코드·관리자 토큰 확인과 잘못된 시도 제한(IP별) |
| `src/shared.js` | 공용 서재: GitHub 호환 중계(`/shared/<서재>/gh/...`), `/shared`, `/shared/<서재>/activity`, 관리자 통계·휴지통 비우기, 삭제한 코드의 개인 기록 정리 |
| `src/shared-paths.js` | 공용 서재 규칙(누가 어떤 경로를 보고·쓰고·지울 수 있는지, 커밋 메시지) — 입출력 없는 순수 함수 |
| `src/github.js` | 팀 저장소용 GitHub 호출(서버 토큰)과 짧은 캐시 |
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
(단, `schema.sql`에 테이블이 새로 생긴 버전으로 올릴 때는 3번을 한 번 더 합니다. 이미 있는 테이블은 건드리지 않습니다.)

> **2026-10-19 업데이트(직접 정하는 코드 + 잘못된 시도 제한)를 올릴 때는 순서가 중요합니다.**
> 먼저 `npx wrangler d1 execute paper-relay --remote --file schema.sql`(새 `auth_failures` 테이블과 `codes_by_key` 색인 추가),
> **그다음** `npx wrangler deploy`. 거꾸로 하면 새 서버가 없는 테이블을 찾느라 모든 초대 코드 요청이 500 오류가 됩니다.
> 이미 있는 `PR-XXXX-XXXX` 코드·사용량·공용 서재(personId)는 그대로입니다.

> **초대 코드 삭제 업데이트(2026-10-19)**: **서버를 앱보다 먼저** 올립니다(`npx wrangler deploy`). 옛 서버는 `DELETE`를
> 모르므로(브라우저에서는 연결 오류로 보임) 새 앱의 삭제 버튼이 실패합니다. `schema.sql`은 다시 실행해도 되지만 이번에는
> 꼭 필요하지 않습니다: 새 칸 `codes.person_salt`는 **새 서버가 업데이트 뒤 첫 코드를 만들 때 스스로 추가**합니다
> (SQLite/D1에는 "칸이 없을 때만 추가"가 없어서 `schema.sql`에 `ALTER TABLE`을 넣으면 두 번째 실행부터 오류가 납니다).
> 새 데이터베이스는 `schema.sql`이 처음부터 그 칸을 만듭니다. 이미 있는 코드는 소금값(salt)이 비어 있어 personId·메모가
> 그대로입니다. 순서(정확히): ① `npx wrangler d1 execute paper-relay --remote --file schema.sql`(해가 없음 — 앞선 업데이트의
> 테이블이 아직 없을 때만 실제로 무언가를 만듦) ② `npx wrangler deploy` ③ 주소와 기존 코드의 `/relay/me` 확인 ④ 지금 앱에서
> 시험용 코드를 하나 만든 뒤
> `npx wrangler d1 execute paper-relay --remote --command "SELECT code, person_salt IS NOT NULL AS salted FROM codes ORDER BY created_at DESC LIMIT 3"`
> → 새 코드만 `salted`가 1 ⑤ 앱 배포(`main`에 push) ⑥ 새 앱에서 시험용 코드를 **삭제** → "삭제했습니다.". 자세한 설명은
> `docs/RELAY.md` §5, `docs/notes/relay.md` "Updating a deployed Worker for code deletion".

## 공용 서재 켜기 (한 번만)

공용 서재는 초대 코드를 가진 모든 사람이 **똑같은 권한**으로 쓰는 서재입니다(폴더·논문 추가/이동/삭제 모두 가능, 삭제는 휴지통으로).
폴더·논문(PDF)·번역은 모두와 공유되고, 하이라이트·메모·AI 기록은 사람마다 따로 저장됩니다.
데이터는 비공개 GitHub 저장소 `dindoopark/paper-team-library`에 들어가고, 서버가 GitHub에 접속할 때 쓰는 토큰은 **서버에만** 있습니다.

1. **GitHub 토큰 만들기** (저장소 소유자 계정으로)
   - GitHub → 오른쪽 위 프로필 → **Settings** → 맨 아래 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
   - Token name: `paper-relay 공용 서재` 같은 이름, Expiration: 원하는 기간(만료 전에 아래 "토큰 바꾸기"로 교체)
   - **Repository access**: **Only select repositories** → `dindoopark/paper-team-library` **하나만** 고릅니다.
   - **Permissions** → Repository permissions → **Contents: Read and write** (Metadata: Read-only는 자동으로 붙습니다). 다른 권한은 주지 않습니다.
   - **Generate token**을 누르고 나온 `github_pat_...` 값을 복사합니다. 이 화면을 닫으면 다시 볼 수 없습니다.
   - 저장소는 반드시 **비공개(Private)** 여야 합니다. 공개로 바뀌면 서버가 공용 서재를 멈춥니다(503).

2. **토큰을 서버 비밀값으로 넣기** — `relay` 폴더에서:
   ```
   npx wrangler secret put TEAM_GITHUB_TOKEN
   ```
   안내가 나오면 `github_pat_...`를 붙여 넣고 Enter. 복사해 둔 토큰은 다른 곳에 저장하지 말고 지웁니다.

3. **테이블 추가** (공용 서재용 `shared_trees` 테이블):
   ```
   npx wrangler d1 execute paper-relay --remote --file schema.sql
   ```

4. **설정 확인** — `wrangler.jsonc`의 `SHARED_LIBRARIES`에 저장소 이름(`repo`), 브랜치(`branch`, 기본 `main`), 용량 상한(`maxBytes`, 기본 4 GB)이 맞는지 봅니다. `GITHUB_API_BASE`는 `https://api.github.com` 그대로 둡니다.

5. **배포**
   ```
   npx wrangler deploy
   ```

6. **확인** — 초대 코드 하나로:
   ```
   curl -H "Authorization: Bearer PR-XXXX-XXXX" https://paper-relay.<계정>.workers.dev/shared
   ```
   `{"libraries":[{"id":"team","name":"공용 서재"}],"personId":"…","name":"…"}`가 나오면 준비된 것입니다. 저장소가 비어 있어도 됩니다 — 첫 사용자가 저장할 때 `README.md`를 만들고 시작합니다.

**토큰 바꾸기**: GitHub에서 새 토큰을 같은 조건으로 만들고 `npx wrangler secret put TEAM_GITHUB_TOKEN`으로 넣은 뒤(바로 적용) 옛 토큰을 GitHub에서 삭제합니다. 토큰이 만료되거나 틀리면 서버는 502와 함께 "공용 서재 서버의 GitHub 연결에 문제가 있습니다(…TEAM_GITHUB_TOKEN…). 관리자에게 알려 주세요."를 돌려주고, 앱은 잠시 뒤 자동으로 다시 시도합니다 — 동료의 초대 코드는 그대로 둬도 됩니다.

### 서버가 지키는 규칙

앱은 공용 서재를 `apiBase = <서버>/shared/team/gh`, 저장소 `team/library`로 보고, 개인 서재와 똑같은 GitHub 동기화 코드로 씁니다. 서버는 그중 정해진 요청만 통과시킵니다(그 밖의 주소는 모두 404).

- **볼 수 있는 것**: 공유 파일 전부. `people/<다른 사람>/` 아래(다른 사람의 하이라이트·메모·AI 기록)는 목록에서 빠지고, 그 폴더를 직접 요청해도 404입니다. `personId`는 저장된 초대 코드(`PR-XXXX-XXXX` 또는 `EICU-2026`)와 그 코드의 소금값(`codes.person_salt`, 코드를 만들 때 정하는 무작위 128비트)을 `PERSON_ID_SECRET`으로 HMAC-SHA-256한 앞 16자리입니다(비밀값이 없는 로컬 테스트에서는 SHA-256). 2026-10-19 전에 만든 코드는 소금값이 없어 예전 값(코드만으로 계산) 그대로입니다. 계산은 `src/shared-paths.js`의 `personIdForRow` 한 곳에서만 합니다. 다른 사람에게 보이지 않게 커밋 메시지에서도 지웁니다. 직접 정한 코드는 어떻게 입력하든(대소문자·하이픈) 같은 personId이고, **그 코드를 함께 쓰는 사람들은 한 사람으로 취급**됩니다(메모·하이라이트를 같이 씀).
- **쓸 수 있는 경로**: `library.json`, `papers/<id>/paper.pdf`(새 PDF만 — 이미 있는 PDF는 바꿀 수 없음), `papers/<id>/translation.json`, `people/<나>/papers/<id>/annotations.json`·`ai.json`. `<id>`는 영문·숫자·`_`·`-` 1~64자.
- **지울 수 있는 것**: 내 `people/<나>/` 파일만. 논문·번역은 지워지지 않고 앱의 휴지통(묘비 기록)으로만 갑니다. PDF는 30일이 지나 관리자가 비울 때까지 남습니다.
- **현재 상태 위에만 저장**: 트리는 현재 커밋의 트리(또는 10분 안에 현재였던 트리) 위에서만, 커밋은 현재 커밋을 부모로, 이 사람이 이 서버를 거쳐 그 트리 위에 만든 트리로만 만들 수 있습니다. 그사이 다른 사람이 저장했으면 409를 돌려주고, 앱은 새로 받아 합친 뒤 다시 저장합니다. 강제 덮어쓰기(`force`)는 403, 빨리감기가 아닌 브랜치 갱신은 GitHub의 422가 그대로 갑니다.
- **커밋 메시지**: `[초대 코드 이름] 앱이 쓴 첫 줄`(200자 이내)로 바꿔 기록합니다. 최근 활동은 여기서 읽습니다.
- **용량**: 파일 하나는 100MB까지. PDF(또는 8MB가 넘는 파일)를 올리면 저장소 크기가 `maxBytes`를 넘을 때 413("공용 서재 저장 공간이 부족해…")으로 거절합니다. JSON 파일(목록·메모 등)은 꽉 차도 저장되므로 지우기·휴지통 비우기는 언제나 됩니다.
- GitHub에는 서버 토큰·`Accept`·`X-GitHub-Api-Version: 2022-11-28`·`User-Agent: paper-relay`만 보내고 초대 코드는 절대 보내지 않습니다. GitHub의 요청 한도 헤더(`X-RateLimit-*`, `Retry-After`)와 `ETag`(304 조건부 요청)는 앱에 그대로 전달합니다.

| 요청 | 누가 | 내용 |
|---|---|---|
| `GET /shared` | 초대 코드 | `{ libraries: [{ id, name }], personId, name }` |
| `GET /shared/<서재>/activity?limit=50` | 초대 코드 | 최근 커밋에서 만든 `{ items: [{ ts, who, summary }] }` (최신 먼저, 이메일·토큰 없음) |
| `/shared/<서재>/gh/repos/team/library/...` | 초대 코드 (`Authorization: Bearer`) | GitHub 호환 중계 (`docs/SHARED.md` §2.1의 표) |
| `GET /relay/admin/shared/<서재>/stats` | 관리자 토큰 | `{ bytes, papers, people, maxBytes }` (현재 커밋 기준 전체 파일 크기, PDF 수, 사람 수) |
| `POST /relay/admin/shared/<서재>/purge` | 관리자 토큰 | 휴지통에 들어간 지 30일 지난 논문의 파일(`papers/<id>/*`, 모두의 `people/*/papers/<id>/*`)을 지우는 커밋 하나. 묘비 기록은 `library.json`에 남습니다. → `{ purged: [논문 id], files, freedBytes, commitSha }` |

초대 코드를 **사용 중지**하면 그 사람은 공용 서재에도 바로 401입니다(메모는 저장소에 남아 다시 켜면 그대로. 다만 앱은 이 401을 받으면 기기에서 코드를 지우므로, 다시 켠 뒤에는 그 사람이 초대 링크를 한 번 더 열거나 코드를 다시 넣어야 합니다). **삭제**하면 그 사람의 `people/<personId>/` 파일까지 지웁니다 — 아래 "초대 코드 삭제". 지금은 활성 초대 코드 모두가 `SHARED_LIBRARIES`의 모든 서재를 씁니다(코드별로 제한하려면 `src/shared.js`의 `librariesFor`만 바꾸면 됩니다).

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

- **잘못된 시도 제한**: 같은 IP에서 없는 초대 코드로 20번 실패하면(관리자 토큰은 따로 10번) 첫 실패부터 10분이 지날 때까지 429 "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요."를 돌려줍니다. 아래 "직접 정하는 코드와 잘못된 시도 제한"을 보세요.

설정값(`vars`)을 바꾸려면 `wrangler.jsonc`를 고치고 `npx wrangler deploy`를 다시 합니다. (Cloudflare 대시보드의 Worker 설정에서 바꿀 수도 있지만, 다음 `wrangler deploy` 때 `wrangler.jsonc`의 값으로 되돌아갑니다.)

| 설정값 | 기본값 | 뜻 |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://e2jinsoopark.github.io,http://localhost:*,http://127.0.0.1:*` | 이 서버를 부를 수 있는 웹사이트(쉼표 목록, `:*`는 모든 포트) |
| `UPSTREAM_URL` | `https://api.anthropic.com` | 전달할 곳(테스트에서만 바꿈) |
| `DEFAULT_MODELS` | `claude-haiku-5-5` | 새 코드의 기본 허용 모델(쉼표 목록) |
| `DEFAULT_DAILY_LIMIT_USD` | `0.5` | 새 코드의 기본 하루 한도($) |
| `GLOBAL_DAILY_LIMIT_USD` | `5` | 서버 전체 하루 한도($) |
| `MAX_TOKENS_CAP` | `32000` | 요청 하나의 `max_tokens` 상한 |
| `GITHUB_API_BASE` | `https://api.github.com` | 공용 서재 저장소가 있는 GitHub API(테스트에서만 바꿈) |
| `SHARED_LIBRARIES` | `[{ "id": "team", "name": "공용 서재", "repo": "dindoopark/paper-team-library", "branch": "main", "maxBytes": 4000000000 }]` | 공용 서재 목록(JSON). `id`는 영문 소문자·숫자·`-`, `maxBytes`는 저장소 전체 파일 크기 상한 |

무료 요금제에 맞춰, 요청 하나마다 D1 호출 1번(코드+오늘 사용액+잘못된 시도 횟수, 있는 코드면 아무것도 쓰지 않음)과 쓰기 1번(사용량 기록)만 합니다. 다만 그림이 많이 든 아주 큰 요청은 무료 요금제의 요청당 CPU 시간 한도를 넘을 수 있습니다.

## 관리자 API (앱의 관리 화면이 쓰는 것)

모두 `Authorization: Bearer <ADMIN_TOKEN>`이 필요합니다. 금액은 달러, 시각은 ISO 문자열입니다.

| 요청 | 내용 |
|---|---|
| `GET /relay/admin/codes` | 코드 목록(최근 것 먼저)과 오늘·이번 달(KST)·누적 사용액, `todayTotalUsd`, `monthTotalUsd`(삭제한 코드의 사용액 포함), `globalDailyLimitUsd`, `deletedUsage: { todayUsd, monthUsd, totalUsd, totalRequests }`(삭제한 코드들의 사용액 합계 — 목록의 "삭제된 코드" 줄) |
| `POST /relay/admin/codes` `{ name, code?, allowedModels?, dailyLimitUsd? }` | 새 코드(201). 이름 1~40자. `code`를 주면 그 코드로(아래 규칙), 비우면 무작위 `PR-XXXX-XXXX`. 이미 있는 코드면 409 |
| `PATCH /relay/admin/codes/<코드>` `{ name?, active?, allowedModels?, dailyLimitUsd? }` | 고친 코드. `<코드>`는 대소문자·하이픈 상관없음. 코드 자체(`code`)는 바꿀 수 없음(400) |
| `DELETE /relay/admin/codes/<코드>` | 코드 삭제(아래 "초대 코드 삭제"). `<코드>`는 대소문자·하이픈 상관없음. → `{ deleted: true, purgedFiles }`, 없는 코드 404, GitHub 연결 실패 502(코드는 그대로) |
| `GET /relay/admin/usage?days=30[&code=<코드>]` | 날짜별(최근 날 먼저, 쓴 적 없는 날도 0으로 포함)·모델별 사용량(삭제한 코드의 사용량도 날짜별 합계에 들어감) |

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

## 초대 코드 삭제

`DELETE /relay/admin/codes/<코드>`(앱: 초대 코드 관리 → 삭제). **사용 중지**와 달리 되돌릴 수 없습니다.

1. 먼저 코드를 **사용 중지**합니다. 지우는 동안 그 사람이 새 메모를 저장하지 못하게 하려는 것입니다(공용 서재의 요청은
   매번 코드를 확인합니다. 그 사이 끼어든 저장은 GitHub의 빨리감기 검사에 걸려 새 상태에서 다시 정리합니다).
2. `SHARED_LIBRARIES`의 **모든 서재**에서 그 사람의 `people/<personId>/` 아래 파일(하이라이트·메모·AI 기록)을 지우는
   서버 커밋을 **서재마다 하나** 만듭니다. 메시지는 `[관리자] 초대 코드 삭제에 따라 개인 기록 정리` — 최근 활동에 이 줄이
   보이고, personId는 들어가지 않습니다. 그 사람의 파일이 없는 서재에는 커밋하지 않습니다. 공유 파일(`library.json`,
   `papers/*`: 논문·폴더·번역)과 다른 사람의 폴더는 건드리지 않습니다. 2026-10-19 전에 만든 코드는, `PERSON_ID_SECRET`을
   나중에 넣었을 때 생겼을 수 있는 예전 폴더(비밀값 없이 계산한 personId)도 함께 지웁니다.
3. 그다음 D1에서 코드와 그 사람의 `shared_trees` 기록을 지웁니다. **사용량 기록은 남깁니다**: `usage.code`를
   `deleted:<삭제 시각>:<코드>`로 바꿔 두므로 오늘·이번 달 합계와 서버 전체 하루 한도에는 계속 들어가지만, 같은 글자로
   다시 만든 코드에는 붙지 않습니다. → `{ "deleted": true, "purgedFiles": <지운 파일 수> }`

- **GitHub에 연결하지 못하면**(장애·토큰 문제) 코드를 지우지 않고 원래 상태(켜짐/중지)로 되돌린 뒤 502
  "공용 서재(GitHub)에 연결하지 못해 이 코드의 개인 기록을 지우지 못했습니다. 코드는 그대로 두었으니 잠시 후 다시 삭제해
  주세요."를 돌려줍니다. 코드는 없어졌는데 메모만 저장소에 남는 일은 없습니다. 다시 삭제하면 이미 정리된 서재는 건너뜁니다.
- `TEAM_GITHUB_TOKEN`이 없으면 공용 서재가 꺼져 있는 것이므로(이 서버로는 아무것도 저장할 수 없음) 정리할 것 없이 코드만
  지웁니다. 토큰을 지우기 전에 저장된 메모가 있었다면 저장소에 남습니다.
- 삭제한 코드는 모든 곳(`/v1/*`, `/relay/me`, `/shared`, 최근 활동, GitHub 중계)에서 401 "초대 코드가 올바르지 않거나 사용이
  중지되었습니다."입니다. 그 사람이 이미 받아 둔 기기 안의 사본은 서버가 지울 수 없습니다.
- **같은 직접 정한 코드를 다시 만들면 새 사람**입니다: 코드마다 새 소금값을 정하므로 personId가 달라지고, 예전 메모·사용량은
  보이지 않습니다.
- 삭제한 코드도 잘못된 시도 제한에서는 "없는 코드"로 셉니다(중지한 코드와 다름). 앱은 이 401을 받으면 코드를 지우고 다시
  묻지 않지만, 예전 앱을 쓰는 기기 여러 대가 같은 병원 IP에서 계속 접속하면 그 IP의 실패 횟수가 찰 수 있습니다.

## 직접 정하는 코드와 잘못된 시도 제한

**직접 정하는 코드(그룹 코드)** — 관리 화면의 "코드 직접 정하기" 칸, 또는 `POST /relay/admin/codes`의 `code`.

- 영문·숫자·하이픈(-)으로 **6~24자**(하이픈 포함). 대문자로 저장합니다: `eicu-2026` → `EICU-2026`. 띄어쓰기와 여러 개의 하이픈은 하이픈 하나로, 앞뒤 하이픈은 지웁니다. 전각 글자(한글 키보드의 ＡＢＣ)도 받습니다.
- 동료가 입력할 때는 **대소문자와 하이픈·띄어쓰기를 구분하지 않습니다**: `eicu 2026`, `EICU2026`, `Eicu-2026` 모두 `EICU-2026`입니다. 그래서 하이픈만 다른 코드(`EICU2026`와 `EICU-2026`)는 함께 만들 수 없습니다(409 "이미 있는 코드입니다").
- 자동 코드와 달리 글자를 바꿔 읽지 않습니다(O는 O, I는 I). 자동 코드 모양(`PR` + 영문·숫자 8자)은 자동 코드용이라 쓸 수 없습니다.
- 쓸 수 없는 코드(400): 예약어(ADMIN, TEST, PASSWORD, TEAM, GALPI 등 — 목록은 `src/codes.js`의 `RESERVED_CODES`), 같은 글자 반복(`AAAAAA`), `123456`·`ABCDEF`·`QWERTY` 같은 순서.
- **여러 명이 같은 코드를 쓰면 메모와 사용 한도도 함께 씁니다**: 하루 한도는 코드 하나에 걸리고, 공용 서재에서는 한 사람으로 취급됩니다(personId가 같음). 사람마다 따로 쓰게 하려면 자동 코드를 사람마다 만드세요.
- 짧고 쉬운 단어일수록 남이 맞히기 쉽습니다. 아래 제한이 추측을 느리게 하지만, 새어 나간 코드는 관리 화면에서 **사용 중지**하세요.

**잘못된 시도 제한** — 직접 정한 코드는 추측될 수 있어서, IP마다 실패 횟수를 셉니다(D1 `auth_failures` 테이블).

| | 초대 코드 | 관리자 토큰 |
|---|---|---|
| 허용 실패 | 10분에 20번 | 10분에 10번 |
| 세는 곳 | `/v1/messages`, `/v1/models`, `/relay/me`, `/shared`, `/shared/<서재>/activity`, 공용 서재 GitHub 중계 — 모두 합쳐서 | `/relay/admin/*` |
| 다 쓰면 | 429 "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." (`x-should-retry: false`, `retry-after`: 남은 초) | 같음 — 맞는 토큰도 10분 동안 거절 |

- 10분은 그 IP의 **첫 실패부터** 셉니다. 지나면 다시 처음부터입니다.
- 세지 않는 것: 코드를 아예 안 보낸 요청, **사용 중지된 코드**(예전 기기가 계속 접속해도 병원 네트워크 전체가 막히지 않게), 바로 앞 실패와 똑같은 잘못된 코드(멈춘 앱이 같은 값을 계속 보내는 경우). 성공한 요청은 세지도, 횟수를 지우지도 않습니다.
- 막힌 동안에도 **자동 코드(`PR-XXXX-XXXX`)는 그대로 됩니다**(무작위 40비트라 추측이 불가능하므로, 같은 와이파이의 동료를 막을 이유가 없음). **직접 정한 코드는 막힙니다** — 그렇지 않으면 "이 단어는 200, 저 단어는 429"로 어떤 단어가 코드인지 알려 주게 됩니다. 그래서 병원처럼 여러 명이 한 IP를 쓰는 곳에서 누군가 틀린 코드를 20번 넣으면, 그 IP의 그룹 코드 사용자는 최대 10분 기다려야 합니다.
- IPv6 주소는 앞 64비트(/64)를 한 사람으로 봅니다. 동시에 여러 요청을 보내도 20번을 넘겨 확인할 수 없습니다(실패 기록과 코드 조회를 한 번의 D1 트랜잭션으로 처리).
- 예산 초과 429에는 `retry-after`가 없고, 이 제한의 429에는 있습니다(앱이 "내일"과 "잠시 후"를 구분하는 데 씀).

## 로컬에서 실행·테스트

```
cp .dev.vars.example .dev.vars        # 값 채우기 (.dev.vars는 git에 올라가지 않습니다)
npx wrangler d1 execute paper-relay --local --file schema.sql
npx wrangler dev                      # http://127.0.0.1:8787
```

자동 테스트(실제 Anthropic API는 부르지 않습니다 — 가짜 Anthropic 서버를 씁니다):
```
node relay/test/run.mjs               # 전부 (unit, http, codes, sdk, shared, shared-client, code-delete)
node relay/test/run.mjs codes         # 직접 정하는 코드와 잘못된 시도 제한
node relay/test/run.mjs unit          # 서버 없이 도는 것만
node relay/test/run.mjs shared shared-client   # 공용 서재만
node relay/test/run.mjs code-delete   # 초대 코드 삭제·소금값·스키마 이전
```
- 테스트용 D1은 **삭제 기능 전의 스키마로 만든 뒤 지금의 `schema.sql`을 두 번** 실행해 씁니다(`test/legacy-schema.sql`,
  `lib.mjs`의 `migratedDatabase`) — 운영 데이터베이스가 업데이트 뒤 놓이는 모양 그대로이고, 예전 코드 두 개
  (`PR-01DC-0DE5`, `OLD-WARD-7B`, 소금값 없음)가 들어 있습니다. 테스트는 Worker의 D1 파일(SQLite)을 읽기 전용으로 열어
  소금값·사용량 기록을 확인합니다(Node 22.5 이상의 `node:sqlite`).
- wrangler와 Playwright는 `C:/Users/dindoo/Projects/pr-tools`에서 가져옵니다(다른 위치면 환경변수 `PR_TOOLS`). SDK 테스트는 Edge와 jsDelivr 접속이 필요합니다.
- 포트: Worker 8787, 가짜 Anthropic 8788, 테스트 페이지 8789, 가짜 GitHub 8792(`tests/store/fake-github.mjs`). 결과는 `pr-tools/out/relay/results.json`, 로그는 같은 폴더의 `run.log`·`wrangler.log`.
- 공용 서재 테스트: `shared`는 중계의 허용·거절 규칙(경로, 다른 사람 파일, PDF 삭제·교체, base_tree·parents·force, 경로 조작, 용량, 비활성 코드), 목록 숨김, 최근 활동, 관리자 통계·비우기, 토큰·코드가 새지 않는지를 HTTP로 확인합니다. `shared-client`는 앱의 `GitHubClient`(`js/store/github.js`)를 Node와 Edge에서 그대로 써서 빈 저장소 시작·커밋·304·충돌(409/422)까지 확인합니다. 실제 GitHub에는 접속하지 않습니다.
- 테스트는 `TEST_MODE=1`로 띄워 `x-relay-test-now` 헤더로 시계를 옮깁니다(날짜 바뀜·한도 초기화·10분 제한 확인용). **운영 환경에는 `TEST_MODE`를 절대 넣지 마세요** — 넣으면 누구나 날짜를 바꿔 하루 한도와 잘못된 시도 제한을 피할 수 있습니다.
- 잘못된 시도 제한 테스트는 IP마다 따로 셉니다: `wrangler dev`는 요청에 넣은 `CF-Connecting-IP`를 그대로 Worker에 넘기므로(wrangler 4.145에서 확인) 테스트가 IP를 골라 보냅니다. 운영 환경에서는 Cloudflare가 이 값을 실제 접속 IP로 채웁니다.
- 결과·로그·임시 D1을 다른 폴더에 두려면 환경변수 `RELAY_OUT_DIR`.

앱과 Worker를 함께 돌리는 끝-대-끝 테스트(실제 앱 + `wrangler dev` + 가짜 Anthropic, 포트 8160·8787·8788 — 위 테스트와 동시에 돌리지 마세요):
```
node tests/relay-e2e/run.mjs
```
앱의 CSP는 로컬 주소를 허용하지 않으므로, 이 테스트는 사이트 사본을 따로 만들어 씁니다. 방식은 `docs/notes/relay.md`에 있습니다.

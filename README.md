# 논문 리더 (Paper Reader)

영어 논문 PDF를 올리면 **왼쪽에 원문, 오른쪽에 한국어 번역**을 나란히 보여 주는 개인용 논문 뷰어입니다.
어느 쪽이든 문장에 마우스를 올리면 반대쪽의 짝 문장이 함께 표시됩니다.
GitHub Pages에서 바로 열리는 정적 웹앱이라 설치할 것이 없습니다.

**바로 열기: <https://e2jinsoopark.github.io/>** (가짜 AI로 둘러보기: <https://e2jinsoopark.github.io/?mock=1>)

## 주요 기능

| 기능 | 설명 |
|---|---|
| 문장 1:1 번역 | 문장 단위로 번역하고 원문↔번역 문장을 마우스 올림으로 서로 표시 |
| 번역 겹쳐보기 | PDF 레이아웃 위에 번역문을 덮어서 보기 |
| 라이브러리 | 폴더(하위 폴더 포함)별 정리, 검색, 즐겨찾기, 최근 읽음 |
| 기기 간 동기화 | 내 **비공개** GitHub 저장소에 논문·번역·메모를 저장 → 데스크톱·노트북 어디서나 같은 라이브러리 |
| 요약 | 연구 목적·방법·결과·한계·시사점 구조 요약 |
| AI 채팅 | 논문 내용에 근거한 질의응답, 근거 문장으로 바로 이동 |
| AI 설명 | 선택한 문장, 그림·표·수식 영역을 드래그해서 설명 |
| 스마트 인용 | 본문 인용 번호에 마우스를 올리면 참고문헌 정보 표시 |
| 미리보기 | Figure·Table·Section 링크를 누르지 않고 미리보기 |
| 핵심 밑줄 | 핵심 기여·방법·결과·한계 문장 자동 밑줄 |
| 하이라이트·메모 | 4색 하이라이트, 메모, 메모 모아보기 |
| 관련 논문 | Semantic Scholar 기반 추천 |

## 처음 설정 (기기마다 한 번)

API 키와 GitHub 토큰은 **그 브라우저에만** 저장됩니다. 다른 기기에서는 한 번 더 입력해야 합니다.

### 1. AI 연결 (넷 중 하나)

**설정 → AI 번역**에서 고릅니다. 나중에 언제든 바꿀 수 있고, 바꿔도 다른 키·초대 코드는 지워지지 않습니다.

| 선택 | 필요한 것 | 키 만드는 곳 | 비용 |
|---|---|---|---|
| 키 없이 쓰기 (초대 코드) | 초대 링크 또는 코드 `PR-XXXX-XXXX` | (초대한 분이 줌) | 초대한 분이 냄, 하루 한도 있음 |
| Claude | Anthropic API 키 | <https://platform.claude.com/settings/keys> | 내 Claude Console 크레딧 (앱이 추정 비용 집계) |
| GPT (OpenAI) | OpenAI API 키 (`sk-…`) | <https://platform.openai.com/api-keys> | 내 OpenAI Platform 크레딧 (비용 미집계) |
| Gemini | Google AI Studio API 키 | <https://aistudio.google.com/apikey> | 무료 등급 가능 (비용 미집계) |

**초대 코드 (키 없이 쓰기)**
초대받았다면 받은 링크(`https://e2jinsoopark.github.io/#/join/PR-…`)를 열면 끝입니다. 코드만 받았다면
**설정 → AI 번역 → 키 없이 쓰기**에 넣고 **테스트**를 누르세요. 초대 코드로는 초대한 분의 Claude(보통 Haiku, 코드에 따라
Sonnet도)를 쓰며, 하루 사용 한도는 초대한 분이 정하고 한국 시간 0시에 다시 열립니다.
초대받은 분도 원하면 **내 API 키 쓰기**에서 Claude·GPT·Gemini 키를 등록해 직접 연결할 수 있습니다. 이때도 초대 코드는
그대로 저장되어 있어, 맨 위 초대 코드 카드를 누르면 한 번에 돌아옵니다.
(초대 코드 서버를 운영하는 방법: `relay/README.md`, `docs/notes/relay.md`)

**Claude**
1. <https://platform.claude.com> 에 로그인 → **API Keys** → **Create Key**
2. 만든 키를 앱의 **설정 → AI 번역 → Claude** 에 붙여넣고 **테스트**를 누릅니다.
3. Claude **Max** 요금제라면 claude.ai **설정 → 결제 → API 크레딧**에서 Console 조직을 연결하면
   요금제에 포함된 API 크레딧(Max 5x: 월 $100 / Max 20x: 월 $200)을 쓸 수 있습니다. 키는 크레딧이 연결된 그 조직에서
   만들어야 합니다. 채팅·Claude Code 사용 한도와는 별개입니다. Pro 요금제는 해당이 없어 Console에서 따로 충전해야 합니다.
4. **테스트**는 키가 유효한지만 확인합니다(크레딧 잔액은 확인하지 않음). 번역할 때 “크레딧이 없거나 부족합니다”가 나오면
   Claude Console의 Billing을 확인하세요.

**GPT (OpenAI)**
1. <https://platform.openai.com/api-keys> 에 로그인 → **Create new secret key**
2. 만든 키(`sk-`로 시작)를 **설정 → AI 번역 → GPT (OpenAI)** 에 붙여넣고 **테스트**를 누릅니다.
3. API 사용료는 ChatGPT 구독(Plus·Pro)과 별개로 OpenAI Platform의 Billing 크레딧에서 나갑니다. 이 앱은 GPT 비용을
   계산하지 않으니(비용 미집계) OpenAI 결제 화면에서 확인하세요.
4. 일부 최신 GPT 모델은 OpenAI **조직 인증**(Settings → Organization → General)을 마쳐야 쓸 수 있습니다. 인증 전에는 앱이
   그 키로 쓸 수 있는 다른 GPT 모델로 바꿔 계속합니다.

**Gemini (무료 등급 가능)**
1. <https://aistudio.google.com/apikey> → **Create API key**
2. 무료 등급은 하루 요청 수 제한이 있고, 입력 내용이 Google 제품 개선에 쓰일 수 있습니다.
   출판된 논문은 괜찮지만 **미출판 원고·민감 자료는 넣지 마세요.**

**모델은 자동으로 고릅니다(‘자동 선택’).** 모델 이름을 직접 넣을 필요가 없습니다.
- 키를 저장하거나 **테스트**하면 그 키로 쓸 수 있는 모델 목록을 회사 서버에서 불러와, 번역에는 빠르고 저렴한 모델
  (Claude Haiku, GPT Luna·mini, Gemini Flash), 요약·채팅·설명에는 더 좋은 모델(Claude Sonnet, GPT Sol, Gemini Flash)을
  최신 버전으로 고릅니다. 설정을 열 때와 초대 코드로 접속할 때마다 목록을 다시 확인해 새 모델을 따라갑니다.
- 새 키로는 쓸 수 없는 이전 세대 모델(예: Gemini 2.x, GPT-4 계열)은 고르지 않고, 목록에도 보여 주지 않습니다.
- 쓰던 모델이 없어지거나 그 키·초대 코드로 쓸 수 없게 되면(“모델을 찾을 수 없음”, 조직 인증 필요, 초대 코드에서 빠진
  모델) 앱이 그 자리에서 같은 키의 다른 모델로 바꿔 요청을 한 번 다시 보내고, “○○ 모델을 쓸 수 없어 △△(으)로
  바꿨습니다.”라고 한 번 알려 줍니다. 쓸 수 없던 모델은 그 키에서 30일 동안 자동 선택에서 빠집니다.
- 원하면 설정에서 모델을 직접 고를 수 있습니다. 직접 고른 모델은 목록에서 사라지거나 쓸 수 없다고 확인될 때만
  ‘자동 선택’으로 돌아갑니다(직접 다시 고르면 다시 시도합니다).

### 2. GitHub 동기화 (선택)

1. 논문을 저장할 **비공개** 저장소를 하나 준비합니다 (예: `paper-library`).
2. <https://github.com/settings/personal-access-tokens/new> 에서 **Fine-grained token** 만들기
   - Resource owner: 저장소를 가진 계정(보통 본인 개인 계정)
   - Repository access: **Only select repositories** → 위 저장소 하나만 선택
   - Permissions → Repository permissions → **Contents: Read and write** (나머지는 건드리지 않음)
   - 만료 기간을 정하고 **Generate token**
3. 앱 **설정 → GitHub 동기화**에 소유자·저장소 이름·토큰을 넣고 **연결 테스트**(성공하면 바로 저장되고 동기화가 시작됩니다).
   이 기기에 다른 저장소의 데이터가 있으면 새 저장소에 올릴지 먼저 묻습니다.

동기화를 켜지 않아도 브라우저 안(IndexedDB)에 저장되어 그 기기에서는 계속 쓸 수 있습니다.

## 비용 감각 (영어 8천 단어 논문 1편 기준, 추정)

| 번역 모델 | 1편 | 100편 |
|---|---|---|
| Claude Haiku 5.5 | 약 $0.02 | 약 $2 |
| Claude Sonnet 5.5 | 약 $0.35 | 약 $35 |

한 번 번역한 결과는 저장되므로 같은 논문을 다시 열 때는 비용이 들지 않습니다.
이번 달 사용량과 추정 비용은 **설정**에서 볼 수 있습니다. GPT·Gemini는 토큰 수만 집계하고 비용은 계산하지 않으니
각 회사 결제 화면에서 확인하세요. 초대 코드 사용량은 초대 코드 서버가 센 오늘 사용액으로 보여 줍니다.

## 보안·개인정보

- 이 사이트의 **코드**는 공개되어 있지만, 올린 **논문·번역·메모**는 내 브라우저와 내 비공개 저장소에만 있습니다.
- 번역·요약·채팅을 할 때 해당 문장이 선택한 AI 제공자(Anthropic·OpenAI·Google)로 전송됩니다. 초대 코드로 쓸 때는
  초대 코드 서버(Cloudflare)를 거쳐 Anthropic으로 갑니다. GPT 요청은 OpenAI에 저장하지 않도록(`store: false`) 보냅니다.
- 공용 PC에서 썼다면 **설정 → 이 기기의 데이터 모두 지우기**를 누르세요. 키·토큰과 함께 그 브라우저에 남은
  논문·번역·메모·사용 기록을 지웁니다(GitHub 저장소의 데이터는 그대로).
- ‘관련 논문’은 처음 쓸 때 묻고 나서 논문 제목을 Semantic Scholar로 보냅니다.

### 배포(호스팅) 주의

API 키·GitHub 토큰·논문은 **브라우저의 사이트(origin)별 저장소**(localStorage·IndexedDB)에 있습니다. GitHub Pages의
프로젝트 사이트(`<계정>.github.io/<저장소>/`)는 같은 계정의 **다른 Pages 사이트와 origin을 공유**하므로, 그 사이트들의
스크립트가 이 앱의 키·토큰·논문을 읽을 수 있습니다. 그래서:

- 이 앱만 올리는 **전용 origin**에서 배포하세요. 예: 이 앱 전용 GitHub 계정(조직)의 `<이름>.github.io` 루트 사이트,
  또는 사용자 도메인(CNAME, 예: `papers.example.com`). 같은 origin에 다른 프로젝트 페이지나 service worker를 두지 마세요.
- 앱이 공유 origin(`*.github.io/<프로젝트>/`)에서 열리면 **설정 → 보안·데이터**에 경고가 표시됩니다.
- 배포에는 앱 파일(`index.html`, `css/`, `js/`, `vendor/`)만 올리는 것을 권장합니다(GitHub Actions의 Pages artifact나
  배포 전용 브랜치). `tests/` 페이지가 함께 올라가도 localhost가 아니면 항상 모의 AI로만 동작합니다.

## 한계

- 스캔한 이미지 PDF는 글자 정보가 없어 번역할 수 없습니다 (보기는 가능).
- PDF 한 개는 최대 70 MB까지 추가할 수 있습니다 (GitHub API가 받는 크기 제한 때문).
- 수식이 많은 부분, 표 안의 글자, 아주 복잡한 레이아웃은 문장 구분이 어긋날 수 있습니다.

## 개발

정적 파일만으로 동작합니다(빌드 없음). 로컬 실행:

```bash
python -m http.server 8000
```

브라우저에서 `http://localhost:8000/?mock=1` 을 열면 실제 API를 부르지 않는 가짜 AI로 시험할 수 있습니다.
구조와 모듈 계약은 [docs/SPEC.md](docs/SPEC.md)를 보세요.

전체 흐름 자동 테스트(Edge + Playwright, 가짜 AI·가짜 GitHub): `node tests/e2e/run.mjs` —
준비물과 모듈별 테스트는 [docs/notes/integration.md](docs/notes/integration.md)와 각 `docs/notes/*.md`에 있습니다.

포함된 외부 라이브러리: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0),
[marked](https://github.com/markedjs/marked) (MIT), [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0).
각 라이선스는 `vendor/` 폴더에 있습니다.

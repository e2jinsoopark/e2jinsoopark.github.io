# 논문 리더 (Paper Reader)

영어 논문 PDF를 올리면 **왼쪽에 원문, 오른쪽에 한국어 번역**을 나란히 보여 주는 개인용 논문 뷰어입니다.
어느 쪽이든 문장에 마우스를 올리면 반대쪽의 짝 문장이 함께 표시됩니다.
GitHub Pages에서 바로 열리는 정적 웹앱이라 설치할 것이 없습니다.

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

### 1. AI 번역 키

**Claude (권장)**
1. <https://platform.claude.com> 에 로그인 → **API Keys** → **Create Key**
2. 만든 키를 앱의 **설정 → AI** 에 붙여넣고 **테스트**를 누릅니다.
3. Claude **Max** 요금제라면 claude.ai **설정 → 결제 → API 크레딧**에서 Console 조직을 연결하면
   매달 $100(Max 5x) / $200(Max 20x) 크레딧이 무료로 들어옵니다. 채팅·Claude Code 사용 한도와는 별개입니다.
   Pro 요금제는 해당이 없어 Console에서 따로 충전해야 합니다.

**Gemini (무료 등급 가능)**
1. <https://aistudio.google.com> → **Get API key**
2. 무료 등급은 하루 요청 수 제한이 있고, 입력 내용이 Google 제품 개선에 쓰일 수 있습니다.
   출판된 논문은 괜찮지만 **미출판 원고·민감 자료는 넣지 마세요.**

### 2. GitHub 동기화 (선택)

1. 논문을 저장할 **비공개** 저장소를 하나 준비합니다 (예: `paper-library`).
2. <https://github.com/settings/personal-access-tokens/new> 에서 **Fine-grained token** 만들기
   - Repository access: **Only select repositories** → 위 저장소 하나만 선택
   - Permissions → Repository permissions → **Contents: Read and write** (나머지는 건드리지 않음)
   - 만료 기간을 정하고 **Generate token**
3. 앱 **설정 → GitHub 동기화**에 소유자·저장소 이름·토큰을 넣고 **연결 테스트**.

동기화를 켜지 않아도 브라우저 안(IndexedDB)에 저장되어 그 기기에서는 계속 쓸 수 있습니다.

## 비용 감각 (영어 8천 단어 논문 1편 기준, 추정)

| 번역 모델 | 1편 | 100편 |
|---|---|---|
| Claude Haiku 5.5 | 약 $0.02 | 약 $2 |
| Claude Sonnet 5.5 | 약 $0.35 | 약 $35 |

한 번 번역한 결과는 저장되므로 같은 논문을 다시 열 때는 비용이 들지 않습니다.
이번 달 사용량과 추정 비용은 **설정**에서 볼 수 있습니다.

## 보안·개인정보

- 이 사이트의 **코드**는 공개되어 있지만, 올린 **논문·번역·메모**는 내 브라우저와 내 비공개 저장소에만 있습니다.
- 번역·요약·채팅을 할 때 해당 문장이 선택한 AI 제공자(Anthropic 또는 Google)로 전송됩니다.
- 공용 PC에서 썼다면 **설정 → 이 기기에서 키·토큰 지우기**를 누르세요.

## 한계

- 스캔한 이미지 PDF는 글자 정보가 없어 번역할 수 없습니다 (보기는 가능).
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

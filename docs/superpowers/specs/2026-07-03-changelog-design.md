# 버전별 업데이트 로그(CHANGELOG) 체계 설계

- 날짜: 2026-07-03
- 상태: 승인됨

## 목적

기능 요청이 구현될 때마다 사용자 관점의 변경사항을 한국어로 누적 기록하고,
버전업 시 그 기록이 GitHub 릴리스 본문과 앱 업데이트 다이얼로그의 릴리스
노트가 되도록 한다. agent가 작업하는 워크플로에서 기록이 자동으로 쌓이는
것이 핵심 요구사항이다.

현재 상태: 릴리스 워크플로(`.github/workflows/release.yml`)가 이전 태그
이후의 커밋 제목을 나열해 `latest.json`의 `notes`로 넣고, 앱은 이를
업데이트 다이얼로그에 표시한다(`src-tauri/src/lib.rs`의 `update_message`,
600자 초과 시 잘림). 커밋 제목은 영어 개발자 시점이라 사용자용 노트로
부적합하다. 저장소에 CHANGELOG 파일은 없다.

## 결정 사항

- 주 독자: 앱 사용자 — 한국어, 사용자 관점 표현
- 업데이트 다이얼로그·GitHub 릴리스의 릴리스 노트 소스로 사용
- 기록 시점: 기능 완료(커밋) 시마다 `[Unreleased]`에 누적
- 형식: 루트 `CHANGELOG.md` 단일 파일, Keep a Changelog 기반 (A안)

## 1. CHANGELOG.md 형식

저장소 루트에 `CHANGELOG.md`를 둔다.

```markdown
# Changelog

이 파일은 사용자 관점의 변경사항을 한국어로 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

### 추가
- 사이드바 헤더에서 수동으로 업데이트를 확인하는 버튼

## [0.1.1] - 2026-07-03

### 추가
- GitHub Releases 기반 자동 업데이트
```

규칙:

- 버전 섹션 헤더는 `## [X.Y.Z] - YYYY-MM-DD`, 미출시분은 `## [Unreleased]`
- 카테고리는 `### 추가`(새 기능), `### 변경`(기존 동작 변경),
  `### 수정`(버그 수정) 세 가지만 사용하며, 항목이 없는 카테고리는 생략
- 한 항목 = 한 줄(`- `로 시작), 사용자가 이해할 수 있는 한국어 표현
- 내부 리팩터링·CI·문서 등 사용자에게 보이지 않는 작업은 기록하지 않음
- 초기 파일에는 기존 릴리스(0.1.0, 0.1.1)를 git 히스토리 기반으로 소급
  작성해 포함한다

## 2. Agent 기록 규칙 (프로젝트 CLAUDE.md)

프로젝트 루트에 `CLAUDE.md`를 새로 만들고 다음 규칙을 명시한다:

- 사용자에게 보이는 변경(기능 추가/변경/버그 수정)을 커밋할 때는 **같은
  커밋에** `CHANGELOG.md`의 `[Unreleased]` 섹션에 한국어 한 줄을 추가한다.
- 내부 작업(리팩터링, CI, 문서, 의존성)은 기록하지 않는다.

커밋 시점에 함께 기록하므로 어떤 세션의 어떤 agent가 작업해도 로그가
누락되지 않는다.

## 3. 버전업 절차 (agent 수행, CLAUDE.md에 문서화)

1. `[Unreleased]` 섹션이 비어 있으면 중단하고 사용자에게 알린다
   (릴리스할 사용자 가시 변경이 없다는 뜻).
2. `[Unreleased]`를 `[X.Y.Z] - YYYY-MM-DD`로 확정하고, 그 위에 빈
   `## [Unreleased]` 헤더를 새로 만든다.
3. 기존 절차대로 버전 범프: `src-tauri/tauri.conf.json` +
   `src-tauri/Cargo.toml` + `package.json` → 커밋 →
   `git tag vX.Y.Z && git push origin vX.Y.Z`.

## 4. 릴리스 워크플로 변경

파싱 로직을 `scripts/get-release-notes.ps1`로 분리하고
`release.yml`의 "Build release notes" 단계가 이를 호출한다.

`get-release-notes.ps1 -Version X.Y.Z` 동작:

- `CHANGELOG.md`에서 `## [X.Y.Z]` 섹션 본문을 추출한다.
- 네이티브 메시지박스에는 마크다운이 그대로 보이므로 `### 추가` 같은
  카테고리 헤더를 `[추가]` 형태로 변환한다.
- 섹션이 없거나 비어 있으면 빈 결과를 반환한다.

`release.yml`은 스크립트 결과가 비어 있으면 **현행 커밋 제목 나열로
폴백**한다 — CHANGELOG 누락이 릴리스를 막아서는 안 된다.

GitHub 릴리스 본문과 `latest.json`의 `notes`는 tauri-action의
`releaseBody` 하나로 공급되므로, 두 곳 모두 동일한 텍스트(카테고리 변환
적용본)를 사용한다.

## 5. 에러 처리

- 태그 버전 섹션 없음/비어 있음 → 커밋 제목 나열로 폴백 (릴리스 진행)
- 업데이트 다이얼로그 600자 제한(`UPDATE_NOTES_MAX_CHARS`)은 기존
  `update_message` 로직이 처리 — 변경 없음
- 버전업 시 `[Unreleased]` 비어 있음 → agent가 중단하고 사용자에게 확인

## 6. 검증

- `scripts/get-release-notes.ps1 -Version 0.1.1`을 로컬 실행해 소급 작성한
  0.1.1 섹션이 올바로 추출·변환되는지 확인
- 섹션이 없는 버전(예: 9.9.9)으로 실행해 빈 결과(폴백 경로)를 확인
- 다음 실제 릴리스(v0.1.2)에서 GitHub 릴리스 본문과 업데이트 다이얼로그에
  한국어 노트가 표시되는지 확인 (배포 대기 중인 기능 3개로 즉시 검증 가능)

## 변경 파일 목록

- `CHANGELOG.md` (신규)
- `CLAUDE.md` (신규 — 기록 규칙 + 버전업 절차)
- `scripts/get-release-notes.ps1` (신규)
- `.github/workflows/release.yml` (노트 생성 단계 교체)

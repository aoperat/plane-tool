# Plane Quick Dock — agent 작업 규칙

## CHANGELOG 기록 규칙

- 사용자에게 보이는 변경(기능 추가/변경/버그 수정)을 커밋할 때는 **같은 커밋에**
  `CHANGELOG.md`의 `## [Unreleased]` 섹션에 한국어 한 줄을 추가한다.
- 카테고리는 `### 추가`(새 기능) / `### 변경`(기존 동작 변경) / `### 수정`(버그
  수정) 세 가지만 사용하고, 항목이 없는 카테고리는 만들지 않는다.
- 한 항목 = 한 줄, `- `로 시작, 앱 사용자가 이해할 수 있는 표현으로 쓴다.
- 내부 작업(리팩터링, CI, 문서, 의존성 정리)은 기록하지 않는다.
- 이미 확정된 버전 섹션(`## [X.Y.Z] - ...`)에는 항목을 추가하지 않는다 — 새
  항목은 항상 `[Unreleased]`에만 쓴다. 태그가 이미 존재하는 버전의 섹션을
  고치면 실제 배포된 내용과 어긋난다.
- `[Unreleased]`에 이미 있는 기능(추가/변경)의 버그를 같은 릴리스 안에서
  고치는 경우 — 즉 아직 태그가 안 나가서 사용자가 그 버그를 실제로 겪은 적이
  없는 경우 — 별도 `### 수정` 줄을 만들지 않고 원래 항목 문장에 합쳐 고쳐
  쓴다. 두 줄로 나누면 태그 시점엔 한 번도 존재한 적 없는 버그를 고친 것처럼
  보여 혼란을 준다.

## 버전업(릴리스) 절차

`/release` 스킬(`.claude/skills/release/SKILL.md`)이 이 절차를 실행한다 —
사용자가 버전업을 요청하면 그 스킬을 사용한다. 요약:

1. `CHANGELOG.md`의 `[Unreleased]` 섹션이 비어 있으면 **중단**하고 사용자에게
   알린다 — 릴리스할 사용자 가시 변경이 없다는 뜻이다.
2. `## [Unreleased]`를 `## [X.Y.Z] - YYYY-MM-DD`(오늘 날짜)로 바꾸고, 그 위에
   빈 `## [Unreleased]` 헤더를 새로 추가한다.
3. 세 파일의 버전을 올린다: `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `package.json`.
4. 커밋 후 태그를 푸시한다: `git tag vX.Y.Z && git push origin master vX.Y.Z`.
   릴리스 워크플로가 CHANGELOG의 해당 버전 섹션을 GitHub Release 본문과 앱
   업데이트 대화상자 노트로 사용한다 (`scripts/get-release-notes.ps1`, 섹션이
   비면 커밋 제목 나열로 폴백).

자세한 배포 가이드: `docs/release-and-config-guide.md`

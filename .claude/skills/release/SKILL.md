---
name: release
description: 버전업 릴리스 실행 — CHANGELOG 확정, 세 파일 버전 범프, 태그 푸시까지. "/release", "/release minor", "/release 0.2.0" 형태로 호출하거나 사용자가 버전업/릴리스를 요청할 때 사용.
---

# 릴리스 (버전업)

CLAUDE.md의 버전업 절차를 실행 가능한 형태로 옮긴 것이다. 인자가 없으면
patch 릴리스. `minor` / `major` / `X.Y.Z`(직접 지정)를 인자로 받는다.

## 절차

1. **사전 점검 — 하나라도 걸리면 중단하고 사용자에게 알린다:**
   - `git status`에 커밋되지 않은 변경이 있으면 중단 (릴리스에 섞이면 안 됨).
   - `CHANGELOG.md`의 `## [Unreleased]` 섹션이 비어 있으면 중단 —
     릴리스할 사용자 가시 변경이 없다는 뜻이다.
   - 로컬 master가 origin/master보다 뒤처져 있으면 먼저 `git pull` 한다.

2. **버전 계산:** 현재 버전은 `src-tauri/tauri.conf.json`의 `version`.
   patch/minor/major 규칙으로 다음 버전을 계산하거나, 인자로 받은 버전을
   그대로 쓴다.

3. **CHANGELOG 확정:** `## [Unreleased]`를 `## [X.Y.Z] - YYYY-MM-DD`(오늘
   날짜)로 바꾸고, 그 위에 빈 `## [Unreleased]` 헤더를 새로 추가한다.

4. **버전 범프 — 네 곳:**
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
   - `package.json` → `"version"`
   - `src-tauri/Cargo.lock` → `name = "plane-tool"` 패키지 블록의 `version`
     (직접 수정하거나 `cargo update -p plane-tool --offline`을 실행)

5. **사용자 확인:** 확정된 CHANGELOG 섹션(= 릴리스 노트로 나갈 내용)과
   버전을 요약해 보여주고 진행 여부를 확인받는다. **태그 푸시는 공개
   릴리스를 트리거하므로 확인 없이 진행하지 않는다.**

6. **커밋 + 태그 푸시:**
   ```powershell
   git add CHANGELOG.md src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json
   git commit -m "chore: bump version to X.Y.Z"
   git tag vX.Y.Z
   git push origin master vX.Y.Z
   ```

7. **안내:** GitHub Actions가 빌드·서명·발행한다 (10~15분).
   <https://github.com/aoperat/plane-tool/actions> 에서 진행 상황,
   <https://github.com/aoperat/plane-tool/releases> 에서 결과를 확인하라고
   안내한다. 릴리스 노트는 워크플로가 CHANGELOG의 해당 버전 섹션에서
   자동으로 가져간다 (`scripts/get-release-notes.ps1`).

## 주의

- 이미 확정된 버전 섹션에는 항목을 추가하지 않는다 — CLAUDE.md 기록 규칙
  참고.
- 릴리스 도중 실패해 커밋/태그를 되돌려야 하면, 푸시 전에는
  `git tag -d vX.Y.Z` + `git reset --hard HEAD~1`로 정리하고, 푸시 후에는
  사용자와 상의한다.

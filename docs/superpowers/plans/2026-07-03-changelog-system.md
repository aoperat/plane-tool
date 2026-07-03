# CHANGELOG 체계 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용자 관점 한국어 CHANGELOG를 도입하고, 릴리스 워크플로가 이를 릴리스 노트(GitHub Release 본문 + 앱 업데이트 다이얼로그)로 사용하게 한다.

**Architecture:** 루트 `CHANGELOG.md` 단일 파일(Keep a Changelog 형식, `[Unreleased]` 누적 → 버전업 시 확정). `scripts/get-release-notes.ps1`이 버전 섹션을 추출·변환하고, `.github/workflows/release.yml`이 이를 `releaseBody`로 사용하되 비어 있으면 기존 커밋 제목 나열로 폴백한다. agent 기록 규칙은 프로젝트 `CLAUDE.md`에 명시한다.

**Tech Stack:** Markdown, PowerShell(pwsh 7), GitHub Actions, tauri-action

**Spec:** `docs/superpowers/specs/2026-07-03-changelog-design.md`

## Global Constraints

- CHANGELOG 항목은 한국어, 사용자 관점 표현. 카테고리는 `### 추가` / `### 변경` / `### 수정` 세 가지만 사용, 항목 없는 카테고리는 생략.
- 버전 섹션 헤더 형식: `## [X.Y.Z] - YYYY-MM-DD`, 미출시분은 `## [Unreleased]`.
- 릴리스 노트가 비면 릴리스를 막지 않고 커밋 제목 나열로 폴백해야 한다.
- 커밋 메시지는 저장소 관례(영어, `feat:`/`docs:` 접두사)를 따른다.
- 이 계획의 작업 자체는 내부 작업(CI/문서)이므로 CHANGELOG `[Unreleased]`에 항목을 추가하지 않는다.
- 모든 신규 파일은 UTF-8 (BOM 없음).

---

### Task 1: CHANGELOG.md 초기 작성 (기존 릴리스 소급 포함)

**Files:**
- Create: `CHANGELOG.md`

**Interfaces:**
- Produces: 루트 `CHANGELOG.md` — Task 2의 스크립트가 파싱하는 대상. 섹션 헤더 `## [0.1.1] - 2026-07-03` 형식과 `### 추가` 카테고리 형식을 Task 2가 그대로 의존한다.

- [ ] **Step 1: CHANGELOG.md 작성**

아래 내용 그대로 생성한다. `[Unreleased]`는 v0.1.1 이후 커밋(`git log v0.1.1..HEAD`) 중 사용자 가시 변경 3건, `[0.1.1]`/`[0.1.0]`은 각 태그 범위의 커밋에서 소급 작성한 것이다.

```markdown
# Changelog

이 파일은 사용자 관점의 변경사항을 한국어로 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

### 추가
- 사이드바 헤더에서 수동으로 업데이트를 확인하는 버튼

### 변경
- 업데이트 확인을 실행 시 1회에서 1시간마다 반복 확인으로 변경하고, 업데이트 안내 대화상자에 릴리스 노트 표시

### 수정
- 창이 다시 포커스를 얻어도 QuickAdd에 작성 중이던 내용이 유지되도록 수정

## [0.1.1] - 2026-07-03

### 추가
- Windows 설치 파일 코드 서명 (자체 서명 인증서)
- 설정 화면에서 저장된 토큰을 빈 비밀번호 칸 대신 카드 형태로 표시

### 변경
- 기본 서버 주소를 https://192.168.20.235 로 설정하고, 사내망 자체 서명 인증서 허용

### 수정
- 우선순위 팝오버가 칩 영역에 가려 잘리던 문제 수정

## [0.1.0] - 2026-07-02

### 추가
- 최초 릴리스: 사이드바(작업 목록, 상태·우선순위·날짜 편집, 프로젝트별 빠른 추가), QuickAdd 창, 설정 화면, GitHub Releases 기반 자동 업데이트
```

- [ ] **Step 2: 형식 자가 검증**

실행: `Select-String -Path CHANGELOG.md -Pattern '^## '`
기대 출력 (버전 헤더 3개, 형식 정확히 일치):

```
CHANGELOG.md:6:## [Unreleased]
CHANGELOG.md:17:## [0.1.1] - 2026-07-03
CHANGELOG.md:29:## [0.1.0] - 2026-07-02
```

- [ ] **Step 3: 커밋**

```powershell
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with retroactive 0.1.0/0.1.1 notes"
```

---

### Task 2: 릴리스 노트 추출 스크립트

**Files:**
- Create: `scripts/get-release-notes.ps1`

**Interfaces:**
- Consumes: Task 1의 `CHANGELOG.md` (섹션 헤더 `## [X.Y.Z]`, 카테고리 `### 추가` 형식)
- Produces: `get-release-notes.ps1 -Version <X.Y.Z>` — 해당 버전 섹션을 stdout으로 출력 (카테고리 헤더는 `[추가]` 형태로 변환). 파일이나 섹션이 없으면 아무것도 출력하지 않고 exit 0. Task 3의 워크플로가 이 계약에 의존한다.

- [ ] **Step 1: 실패 확인 (스크립트 없는 상태)**

실행: `pwsh -File scripts/get-release-notes.ps1 -Version 0.1.1`
기대: 실패 — `The argument 'scripts/get-release-notes.ps1' ... does not exist`

- [ ] **Step 2: 스크립트 작성**

`scripts/get-release-notes.ps1`:

```powershell
# Extracts one version's section from CHANGELOG.md for use as release notes
# (GitHub release body + the app's update dialog via latest.json "notes").
# Category headers ("### 추가") become "[추가]" lines because the update
# dialog is a native message box that shows markdown as-is.
# Prints nothing when the file or the section is missing — release.yml then
# falls back to listing commit subjects, so a forgotten changelog never
# blocks a release.
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ChangelogPath = (Join-Path $PSScriptRoot "..\CHANGELOG.md")
)

if (-not (Test-Path $ChangelogPath)) { exit 0 }

$lines = Get-Content $ChangelogPath -Encoding utf8
$escaped = [regex]::Escape($Version)
$start = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^## \[$escaped\]") { $start = $i + 1; break }
}
if ($start -lt 0) { exit 0 }

$section = New-Object System.Collections.Generic.List[string]
for ($i = $start; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^## ') { break }
    $section.Add(($lines[$i] -replace '^### (.+)$', '[$1]'))
}

($section -join "`n").Trim()
```

- [ ] **Step 3: 추출 경로 검증 (0.1.1 섹션)**

실행: `pwsh -File scripts/get-release-notes.ps1 -Version 0.1.1`
기대 출력 (정확히 일치):

```
[추가]
- Windows 설치 파일 코드 서명 (자체 서명 인증서)
- 설정 화면에서 저장된 토큰을 빈 비밀번호 칸 대신 카드 형태로 표시

[변경]
- 기본 서버 주소를 https://192.168.20.235 로 설정하고, 사내망 자체 서명 인증서 허용

[수정]
- 우선순위 팝오버가 칩 영역에 가려 잘리던 문제 수정
```

- [ ] **Step 4: 폴백 경로 검증 (없는 버전, 없는 파일)**

실행: `pwsh -File scripts/get-release-notes.ps1 -Version 9.9.9; "exit=$LASTEXITCODE"`
기대 출력: `exit=0` (그 외 출력 없음)

실행: `pwsh -File scripts/get-release-notes.ps1 -Version 0.1.1 -ChangelogPath no-such-file.md; "exit=$LASTEXITCODE"`
기대 출력: `exit=0` (그 외 출력 없음)

- [ ] **Step 5: 커밋**

```powershell
git add scripts/get-release-notes.ps1
git commit -m "feat(release): script to extract release notes from CHANGELOG.md"
```

---

### Task 3: release.yml — CHANGELOG 우선, 커밋 제목 폴백

**Files:**
- Modify: `.github/workflows/release.yml:26-39` ("Build release notes" 단계)

**Interfaces:**
- Consumes: Task 2의 `scripts/get-release-notes.ps1 -Version <X.Y.Z>` (섹션 없으면 무출력 + exit 0)
- Produces: step output `notes` — 기존과 동일하게 `steps.notes.outputs.notes`로 tauri-action `releaseBody`에 전달되므로 그 아래(70행~)는 수정하지 않는다.

- [ ] **Step 1: "Build release notes" 단계 교체**

기존 26~39행의 주석과 step을 아래로 교체한다 (`- uses: pnpm/action-setup@v4` 앞까지):

```yaml
      # latest.json's "notes" — shown inside the app's update dialog and used
      # as the GitHub release body — comes from the tag's section in
      # CHANGELOG.md. Falls back to listing commit subjects since the previous
      # tag when the section is missing or empty, so a forgotten changelog
      # never blocks a release.
      - name: Build release notes
        id: notes
        shell: pwsh
        run: |
          $version = $env:GITHUB_REF_NAME -replace '^v', ''
          $notes = (& ./scripts/get-release-notes.ps1 -Version $version | Out-String).Trim()
          if (-not $notes) {
            $prev = git describe --tags --abbrev=0 "$env:GITHUB_REF_NAME^" 2>$null
            $range = if ($prev) { "$prev..$env:GITHUB_REF_NAME" } else { $env:GITHUB_REF_NAME }
            $log = git log $range --no-merges --pretty=format:"- %s" |
              Where-Object { $_ -notmatch '^- chore: bump version' }
            $notes = ($log -join "`n")
          }
          "notes<<NOTES_EOF" >> $env:GITHUB_OUTPUT
          $notes >> $env:GITHUB_OUTPUT
          "NOTES_EOF" >> $env:GITHUB_OUTPUT
```

파일 상단 1~3행의 파일 설명 주석도 현행과 어긋나지 않는지 확인한다 (updater 폴링 설명뿐이므로 수정 불요).

- [ ] **Step 2: step 본문을 로컬에서 시뮬레이션 — CHANGELOG 경로**

step의 `run:` 블록 내용을 그대로 임시 파일로 저장해 실행한다:

```powershell
$sim = Join-Path $env:TEMP "notes-step.ps1"
# release.yml의 run: 블록 11줄을 그대로 $sim에 저장한 뒤:
$env:GITHUB_REF_NAME = 'v0.1.1'
$env:GITHUB_OUTPUT = Join-Path $env:TEMP "gh-output.txt"
Remove-Item $env:GITHUB_OUTPUT -ErrorAction SilentlyContinue
pwsh -File $sim
Get-Content $env:GITHUB_OUTPUT
```

기대 출력: `notes<<NOTES_EOF` 행 + Task 2 Step 3과 동일한 한국어 노트 + `NOTES_EOF` 행.

- [ ] **Step 3: step 본문을 로컬에서 시뮬레이션 — 폴백 경로**

```powershell
$env:GITHUB_REF_NAME = 'v0.1.0'   # CHANGELOG에 있지만, 없는 버전을 흉내내기 위해 아래처럼 임시 이름 변경
Rename-Item CHANGELOG.md CHANGELOG.md.bak
Remove-Item $env:GITHUB_OUTPUT
pwsh -File $sim
Rename-Item CHANGELOG.md.bak CHANGELOG.md
Get-Content $env:GITHUB_OUTPUT
```

기대 출력: `notes<<NOTES_EOF`와 `NOTES_EOF` 사이에 v0.1.0까지의 커밋 제목이 `- feat(...)` 형태로 나열됨 (`chore: bump version` 제외). CHANGELOG.md가 원래 이름으로 복원됐는지 `git status`로 확인.

- [ ] **Step 4: 커밋**

```powershell
git add .github/workflows/release.yml
git commit -m "feat(release): source release notes from CHANGELOG.md, fall back to commit subjects"
```

---

### Task 4: agent 기록 규칙(CLAUDE.md) + 배포 가이드 갱신

**Files:**
- Create: `CLAUDE.md`
- Modify: `docs/release-and-config-guide.md:19-36` (§1-1 절차에 CHANGELOG 확정 단계 추가)

**Interfaces:**
- Consumes: Task 1~3에서 확정된 파일 경로·형식 (`CHANGELOG.md`, `scripts/get-release-notes.ps1`)
- Produces: 프로젝트 규칙 문서 — 이후 모든 agent 세션이 커밋 시 자동으로 따르는 계약

- [ ] **Step 1: CLAUDE.md 작성**

프로젝트 루트 `CLAUDE.md`:

```markdown
# Plane Quick Dock — agent 작업 규칙

## CHANGELOG 기록 규칙

- 사용자에게 보이는 변경(기능 추가/변경/버그 수정)을 커밋할 때는 **같은 커밋에**
  `CHANGELOG.md`의 `## [Unreleased]` 섹션에 한국어 한 줄을 추가한다.
- 카테고리는 `### 추가`(새 기능) / `### 변경`(기존 동작 변경) / `### 수정`(버그
  수정) 세 가지만 사용하고, 항목이 없는 카테고리는 만들지 않는다.
- 한 항목 = 한 줄, `- `로 시작, 앱 사용자가 이해할 수 있는 표현으로 쓴다.
- 내부 작업(리팩터링, CI, 문서, 의존성 정리)은 기록하지 않는다.

## 버전업(릴리스) 절차

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
```

- [ ] **Step 2: 배포 가이드 §1-1에 CHANGELOG 단계 추가**

`docs/release-and-config-guide.md`에서 세 곳 수정:

19행 `**① 버전 올리기 — 세 파일 모두:**` 를 아래로 교체:

```markdown
**① CHANGELOG 확정:**

`CHANGELOG.md`의 `## [Unreleased]` 섹션을 `## [x.y.z] - 날짜`로 바꾸고, 그 위에
빈 `## [Unreleased]` 헤더를 새로 만든다. 이 섹션이 GitHub Release 본문과 앱
업데이트 대화상자의 릴리스 노트가 된다 (비어 있으면 커밋 제목 나열로 폴백).

**② 버전 올리기 — 세 파일 모두:**
```

27행 `**② 커밋 + 태그 푸시:**` → `**③ 커밋 + 태그 푸시:**`

36행 `**③ 확인:** 10~15분 후 ...` → `**④ 확인:** 10~15분 후 ...`

- [ ] **Step 3: 검증**

실행: `Select-String -Path docs/release-and-config-guide.md -Pattern '^\*\*[①②③④]'`
기대 출력: ①(CHANGELOG 확정) ②(버전 올리기) ③(커밋+태그) ④(확인) — 4행, 번호 중복 없음.

- [ ] **Step 4: 커밋**

```powershell
git add CLAUDE.md docs/release-and-config-guide.md
git commit -m "docs: agent changelog rules and updated release procedure"
```

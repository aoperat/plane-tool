# Plane Quick Dock — 배포·설정 가이드

작성일: 2026-07-03 (v0.1.0 기준)

이 문서는 세 부분으로 구성된다:

1. [설치 파일 만들기 / 새 버전 배포](#1-설치-파일-만들기--새-버전-배포) — 관리자용
2. [기본값·정보 수정하는 법](#2-기본값정보-수정하는-법) — 관리자용
3. [설치 및 초기 설정](#3-설치-및-초기-설정) — 팀원 배포용 안내

---

## 1. 설치 파일 만들기 / 새 버전 배포

### 1-1. GitHub Actions 자동 배포 (권장)

버전 태그를 푸시하면 빌드 → 서명 → GitHub Release 발행까지 전부 자동이다.

**① 버전 올리기 — 세 파일 모두:**

| 파일 | 필드 |
|---|---|
| `src-tauri/tauri.conf.json` | `"version": "0.1.1"` |
| `src-tauri/Cargo.toml` | `version = "0.1.1"` |
| `package.json` | `"version": "0.1.1"` |

**② 커밋 + 태그 푸시:**

```powershell
git add -A
git commit -m "chore: bump version to 0.1.1"
git tag v0.1.1
git push origin master v0.1.1
```

**③ 확인:** 10~15분 후 <https://github.com/aoperat/plane-tool/releases> 에 발행된다.

| 릴리스 파일 | 용도 |
|---|---|
| `Plane.Quick.Dock_x.y.z_x64-setup.exe` | **배포용 설치 파일** (팀원에게 이걸 전달) |
| `Plane.Quick.Dock_x.y.z_x64_en-US.msi` | MSI 설치 파일 (그룹정책 배포 등 필요 시) |
| `latest.json`, `*.sig` | 설치된 앱의 자동 업데이트용 — 건드릴 필요 없음 |

이미 설치된 앱은 다음 시작 때 새 버전을 감지해 "업데이트 / 나중에" 대화상자를
띄우고, 확인하면 다운로드·설치 후 자동 재시작한다.

> **주의:** 자동 업데이트는 저장소가 public이어야 동작한다 (설치된 앱이 인증
> 없이 릴리스 파일을 내려받아야 하므로). 다시 private으로 돌리면 업데이트
> 확인이 조용히 실패한다. 저장소는 AGPL-3.0-only로 공개되어 있다 (`/LICENSE`).

### 1-2. 로컬 빌드 (동작 확인용)

```powershell
# createUpdaterArtifacts가 켜져 있어 서명키 없이는 빌드가 실패한다
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\plane-tool.key"
pnpm install
pnpm tauri build
```

출력 위치:

```
src-tauri\target\release\bundle\nsis\Plane Quick Dock_x.y.z_x64-setup.exe
src-tauri\target\release\bundle\msi\Plane Quick Dock_x.y.z_x64_en-US.msi
```

실제 배포는 1-1을 사용할 것 — 자동 업데이트는 GitHub Releases의 `latest.json`을
기준으로 동작하므로, 로컬 빌드본을 돌려도 릴리스를 올리지 않으면 아무도 업데이트를 받지 못한다.

### 1-3. 서명키 관리 (중요)

| 항목 | 값 |
|---|---|
| 개인키 위치 | `C:\Users\<사용자>\.tauri\plane-tool.key` (비밀번호 없음) |
| 공개키 위치 | 같은 경로 `.pub` / `tauri.conf.json`의 `plugins.updater.pubkey`에 내장 |
| CI 시크릿 | GitHub 저장소 시크릿 `TAURI_SIGNING_PRIVATE_KEY` (개인키 파일 내용) |

- **개인키를 잃으면 기존 설치본에 업데이트를 영영 배포할 수 없다. 반드시 백업할 것.**
- 재생성이 필요하면:
  ```powershell
  pnpm tauri signer generate -w "$env:USERPROFILE\.tauri\plane-tool.key" --password ""
  ```
  → 새 `.pub` 내용을 `tauri.conf.json`의 `pubkey`에 반영하고, GitHub 시크릿을 갱신:
  ```powershell
  Get-Content "$env:USERPROFILE\.tauri\plane-tool.key" -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY
  ```
  단, 키를 바꾸면 기존 설치본은 서명 불일치로 업데이트를 받지 못하므로 전원 재설치가 필요하다.

---

## 2. 기본값·정보 수정하는 법

### 2-1. 기본 Plane 서버 주소 (IP) 바꾸기

새로 설치하는 사람의 설정창에 미리 채워지는 주소다. 두 군데를 고친다 — 둘 다
`src-tauri/src/config.rs`:

```rust
// ① Settings::default() 안
base_url: "http://192.168.20.235:8282".into(),   // ← 새 주소로

// ② 같은 파일 하단 테스트 안 (안 고치면 cargo test 실패)
assert_eq!(s.base_url, "http://192.168.20.235:8282");   // ← 같은 값으로
```

이미 설치된 PC는 영향 없음 — 각자 저장된 설정(`%APPDATA%\...\settings.json`)이 우선한다.

### 2-2. 그 외 수정 위치 한눈에

| 바꿀 것 | 파일 / 위치 | 비고 |
|---|---|---|
| 기본 단축키 (F1/F2) | `config.rs` → `default_quickadd_shortcut` / `default_sidebar_shortcut` | 설치 후 설정창에서 개인별 변경 가능 |
| 앱 이름 | `tauri.conf.json` → `productName` | |
| 앱 식별자 | `tauri.conf.json` → `identifier` | **배포 후엔 바꾸지 말 것** — 설정 저장 경로가 바뀌어 기존 설정을 잃는다 |
| 버전 | `tauri.conf.json` + `Cargo.toml` + `package.json` | §1-1 참고 |
| 창 크기·속성 | `tauri.conf.json` → `app.windows` | quickadd / sidebar / settings / editmodal |
| 업데이트 엔드포인트 | `tauri.conf.json` → `plugins.updater.endpoints` | 저장소를 옮기면 여기도 수정 (`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`) |
| 업데이트 공개키 | `tauri.conf.json` → `plugins.updater.pubkey` | 서명키 재생성 시에만 (§1-3) |
| 코드 서명 인증서 | `tauri.conf.json` → `bundle.windows.certificateThumbprint` | 빌드하는 PC의 인증서 저장소에 해당 인증서가 있어야 함. GitHub Actions 러너에는 인증서가 없으므로, 이 설정이 있으면 CI 릴리스 빌드가 서명 단계에서 실패할 수 있음 — CI에서 쓰려면 인증서를 시크릿으로 가져오는 단계를 워크플로에 추가해야 한다 |
| 릴리스 파이프라인 | `.github/workflows/release.yml` | 빌드 대상 OS·옵션 등 |

수정 후에는 항상:

```powershell
pnpm exec tsc --noEmit ; pnpm exec vitest run     # 프론트엔드
cd src-tauri ; cargo test                          # Rust (config.rs 수정 시 특히)
```

---

## 3. 설치 및 초기 설정

*(팀원에게 이 섹션만 잘라서 전달해도 된다)*

### 설치

1. 관리자에게 받은 `Plane.Quick.Dock_x.y.z_x64-setup.exe` 실행 → 설치 완료
2. 실행하면 트레이(작업 표시줄 오른쪽 아래)에 아이콘이 생긴다

### 최초 설정 (1회)

1. 트레이 아이콘 우클릭 → **Settings**
2. **Base URL**: 사내 Plane 주소 (기본값이 미리 채워져 있으면 그대로)
3. **워크스페이스**: Plane 주소창의 워크스페이스 슬러그 (예: `ps`)
4. **API 토큰**: 설정창의 토큰 발급 링크 클릭 → Plane의
   *설정 → 프로필 → API 토큰*에서 발급 → 붙여넣기
5. 저장

### 사용법

| 키 | 동작 |
|---|---|
| **F1** | 빠른 작업 추가 팝업 (제목 입력 후 Enter로 즉시 등록) |
| **F2** | 내 할 일 사이드바 토글 |
| Esc | 팝업/사이드바 닫기 |

- 팝업에서 담당자·시작일·마감일·상태·우선순위를 칩으로 선택, 맨 오른쪽 "설명" 칩으로 설명란 토글
- 사이드바에서 상태·우선순위·기간을 바로 바꾸고, 항목 클릭으로 수정 모달을 연다
- 단축키·테마·표시 디스플레이는 Settings에서 변경

### 업데이트

새 버전이 배포되면 앱 시작 시 자동으로 안내 대화상자가 뜬다.
「업데이트」를 누르면 설치 후 자동 재시작된다.

### 문제 해결

| 증상 | 확인 |
|---|---|
| "등록 실패: HTTP 401" | API 토큰 만료/오입력 — Settings에서 재발급·재입력 |
| "등록 실패: not_configured" | Base URL/워크스페이스/토큰 중 미입력 항목 있음 |
| 단축키가 안 먹힘 | 다른 프로그램과 충돌 — Settings에서 단축키 변경 후 앱 재시작 |
| 설정 초기화하고 싶음 | `%APPDATA%\dev.aoperat.plane-quick-dock\settings.json` 삭제 후 재실행 |

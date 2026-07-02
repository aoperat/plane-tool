# Plane Quick Dock

셀프호스팅 Plane용 Windows 데스크톱 도구. 전역 단축키로 뜨는 빠른 작업 추가 팝업(F1)과
내 할 일 사이드바(F2)를 제공한다. Tauri 2 + TypeScript.

---

## 개발 환경 실행

요구 사항: Node.js 22+, pnpm 10, Rust stable (Windows)

```powershell
pnpm install
pnpm tauri dev
```

테스트/타입체크:

```powershell
pnpm exec tsc --noEmit          # 프론트엔드 타입체크
pnpm exec vitest run            # 프론트엔드 테스트
cd src-tauri; cargo test        # Rust 테스트
```

---

## 설치 파일 만들기

### 방법 1 — GitHub Actions 자동 배포 (권장)

버전 태그를 푸시하면 빌드 → 서명 → GitHub Release 발행까지 자동으로 처리된다
(`.github/workflows/release.yml`).

1. 버전을 **세 곳** 모두 올린다 (예: `0.1.0` → `0.1.1`):
   - `src-tauri/tauri.conf.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
   - `package.json` → `"version"`
2. 커밋 후 태그 푸시:
   ```powershell
   git add -A; git commit -m "chore: bump version to 0.1.1"
   git tag v0.1.1
   git push origin master v0.1.1
   ```
3. 10~15분 후 <https://github.com/aoperat/plane-tool/releases> 에 자동 발행:
   - `Plane.Quick.Dock_x.y.z_x64-setup.exe` — 배포용 NSIS 설치 파일
   - `Plane.Quick.Dock_x.y.z_x64_en-US.msi` — MSI 설치 파일
   - `latest.json` + `.sig` — 설치된 앱들의 자동 업데이트용

설치된 앱은 시작할 때 최신 릴리스를 확인하고, 새 버전이 있으면
"업데이트 / 나중에" 대화상자를 띄운다. 확인 시 다운로드·설치 후 자동 재시작.

### 방법 2 — 로컬 빌드 (테스트용)

```powershell
# 업데이터 아티팩트 서명 때문에 서명키 경로가 필요하다 (없으면 빌드 실패)
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.tauri\plane-tool.key"
pnpm install
pnpm tauri build
```

출력 위치:

- `src-tauri/target/release/bundle/nsis/Plane Quick Dock_x.y.z_x64-setup.exe`
- `src-tauri/target/release/bundle/msi/Plane Quick Dock_x.y.z_x64_en-US.msi`

로컬 빌드본은 동작 확인용으로 쓰고, 실제 배포는 방법 1을 사용할 것 —
자동 업데이트는 GitHub Releases의 `latest.json`을 보고 동작한다.

---

## 기본값·정보 수정하는 곳

| 바꿀 것 | 파일 / 위치 | 비고 |
|---|---|---|
| **기본 Plane 서버 주소 (IP)** | `src-tauri/src/config.rs` → `Settings::default()`의 `base_url` | 현재 `http://192.168.20.235:8282`. 같은 파일 아래 테스트 `settings_default_has_fixed_base_url_and_no_project`의 assert 값도 함께 수정해야 `cargo test`가 통과한다 |
| 기본 단축키 (F1/F2) | `src-tauri/src/config.rs` → `default_quickadd_shortcut` / `default_sidebar_shortcut` | 설치 후에는 설정창에서 사용자별 변경 가능 |
| 앱 이름 / 식별자 | `src-tauri/tauri.conf.json` → `productName`, `identifier` | 식별자를 바꾸면 설정 저장 경로도 바뀌므로 배포 후엔 바꾸지 말 것 |
| 버전 | `tauri.conf.json` + `Cargo.toml` + `package.json` 세 곳 | 위 "방법 1" 참고 |
| 창 크기·동작 | `src-tauri/tauri.conf.json` → `app.windows` | quickadd/sidebar/settings/editmodal 4개 창 |
| **업데이트 엔드포인트** | `src-tauri/tauri.conf.json` → `plugins.updater.endpoints` | 저장소를 옮기거나 이름을 바꾸면 여기도 수정 |
| 업데이트 서명 **공개키** | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | 키를 재생성한 경우에만 (`~/.tauri/plane-tool.key.pub` 내용으로 교체) |

### 서명키 (중요)

- 개인키: `C:\Users\<사용자>\.tauri\plane-tool.key` — **잃어버리면 기존 설치본에
  업데이트를 영영 배포할 수 없다. 반드시 백업할 것.**
- GitHub Actions는 저장소 시크릿 `TAURI_SIGNING_PRIVATE_KEY`(개인키 내용)로 서명한다.
- 재생성: `pnpm tauri signer generate -w %USERPROFILE%\.tauri\plane-tool.key --password ""`
  → 새 공개키를 `tauri.conf.json`에, 새 개인키를 GitHub 시크릿에 반영.
  (재생성하면 기존 설치본은 서명 불일치로 업데이트를 받지 못하므로 재설치 필요)

### 설치 후 사용자별 설정 (코드 수정 불필요)

트레이 아이콘 → Settings에서 각 사용자가 직접 설정한다:
Base URL, 워크스페이스, API 토큰, 단축키, 테마, 표시 디스플레이.

- 저장 위치: `%APPDATA%\dev.aoperat.plane-quick-dock\settings.json`
- API 토큰: Windows 자격 증명 관리자 (`plane-quick-dock` / `api-token`)

---

## 자동 업데이트 관련 주의

저장소가 **private인 동안에는 설치된 앱이 릴리스 파일을 내려받지 못해 자동
업데이트가 동작하지 않는다** (앱은 조용히 넘어가며 정상 사용 가능). 활성화하려면:

```powershell
gh repo edit aoperat/plane-tool --visibility public
```

공개 전환 시 `src/shared/planeIcons.ts`의 상태 아이콘이 Plane(AGPL-3.0)에서
포팅된 것이므로 저장소에 AGPL-3.0 LICENSE 추가가 필요하다.

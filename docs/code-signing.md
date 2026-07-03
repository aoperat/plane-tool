# 설치 파일 코드 서명 & 기본 서버 주소

2026-07-03 설정. 사내 배포용 설치 파일에서 "알 수 없는 게시자" 경고를 없애기 위한
자체 서명 코드 서명 체계와, 기본 접속 주소 변경 내용을 정리한다.

## 기본 서버 주소

- 기본 Base URL: `https://192.168.20.235` (포트 없음)
- 위치: `src-tauri/src/config.rs` → `Settings::default()`
- **새 설치에만 적용**된다. 기존 설치 PC는 저장된 설정이 우선이므로
  설정 화면에서 직접 변경해야 한다.
- 서버가 사설(자체 서명) HTTPS 인증서를 쓰면 API 요청이 TLS 검증에 막힐 수 있다.
  이 경우 서버 인증서를 각 PC의 신뢰 루트에 설치해야 한다.

## 코드 서명 개요

| 항목 | 값 |
|---|---|
| 인증서 | `CN=Plane Quick Dock` (자체 서명, RSA 3072 / SHA256) |
| 지문(thumbprint) | `0299EFBC21404EBE687A1429C65399FC8FE466A4` |
| 만료일 | **2031-07-03** |
| 개인키 위치 | 빌드 머신의 `Cert:\CurrentUser\My` (이 머신에만 존재) |
| 공개 인증서 | `certs/plane-quick-dock.cer` (커밋됨, 공개키라 안전) |
| 서명 설정 | `src-tauri/tauri.conf.json` → `bundle.windows` |
| 타임스탬프 서버 | `http://timestamp.digicert.com` |

`pnpm tauri build` 시 Windows SDK의 signtool로 설치 파일(exe/msi)이 자동 서명된다.
타임스탬프가 찍히므로 인증서가 만료돼도 그 전에 서명한 파일은 계속 유효하다.

자동 업데이트(minisign, `~/.tauri/plane-tool.key`) 서명은 **별개 체계**이며
이 설정과 무관하게 그대로 유지된다.

## CI(GitHub Actions) 릴리스 빌드

릴리스는 `.github/workflows/release.yml`(windows-latest 러너)에서 빌드되는데,
러너에는 인증서가 없으므로 워크플로가 빌드 전에 PFX를 가져온다.
이를 위해 **저장소 시크릿 2개가 필수**다 (없으면 릴리스 빌드 실패):

| 시크릿 | 값 |
|---|---|
| `WINDOWS_CODESIGN_PFX` | `~/.tauri/plane-tool-codesign.pfx`의 base64 |
| `WINDOWS_CODESIGN_PASSWORD` | `~/.tauri/plane-tool-codesign.pfx.password.txt`의 내용 |

등록 명령 (gh CLI):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.tauri\plane-tool-codesign.pfx")) |
  gh secret set WINDOWS_CODESIGN_PFX --repo aoperat/plane-tool
Get-Content "$env:USERPROFILE\.tauri\plane-tool-codesign.pfx.password.txt" -Raw |
  gh secret set WINDOWS_CODESIGN_PASSWORD --repo aoperat/plane-tool
```

PFX(개인키 포함)와 비밀번호 파일은 저장소에 커밋하지 말 것.
인증서를 재생성하면 PFX 재내보내기 + 시크릿 재등록도 필요하다.

## 설치 대상 PC 세팅 (필수)

자체 서명 인증서는 신뢰 등록을 해야 경고가 사라진다. 앱을 설치할 **모든 PC에서
한 번씩** (빌드 머신 포함), 관리자 권한 PowerShell로:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-signing-cert.ps1
```

- 다른 PC에는 `certs/plane-quick-dock.cer` + `scripts/install-signing-cert.ps1`
  두 파일만 복사해서 실행하면 된다 (스크립트가 같은 폴더의 .cer도 찾는다).
- 인증서를 "신뢰할 수 있는 루트 인증 기관"과 "신뢰할 수 있는 게시자"
  (LocalMachine)에 등록한다.
- 사내 AD 환경이면 GPO 인증서 배포로 일괄 처리하는 것이 편하다.
- 등록하지 않은 PC에서는 여전히 경고가 뜬다 — 자체 서명 방식의 한계.

## 빌드 머신 교체 / 인증서 갱신

개인키는 현재 빌드 머신에만 있으므로, 머신을 바꾸거나 인증서가 만료되면:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-signing-cert.ps1
```

1. 스크립트가 새 인증서를 만들고 지문을 출력하며 `certs/plane-quick-dock.cer`를 갱신한다.
2. 출력된 지문으로 `tauri.conf.json`의 `bundle.windows.certificateThumbprint`를 갱신한다.
3. **새 .cer를 모든 대상 PC에 다시 배포**(install-signing-cert.ps1 재실행)해야 한다.

## 문제 해결

- 빌드 시 서명 오류 → 빌드 머신에 인증서가 있는지 확인:
  `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert`
- 서명 확인: 설치 파일 우클릭 → 속성 → 디지털 서명 탭, 또는
  `Get-AuthenticodeSignature <파일>` (신뢰 등록된 PC에서 `Valid`여야 정상)
- 신뢰 등록 전 PC에서는 상태가 `UnknownError`로 나오는 것이 정상이다.

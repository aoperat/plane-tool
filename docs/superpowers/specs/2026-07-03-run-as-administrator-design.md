# 항상 관리자 권한으로 실행 — 설계

날짜: 2026-07-03

## 문제

관리자 권한으로 실행된 다른 프로그램이 포커스를 가지면 Windows UIPI가 일반
권한 프로세스로의 입력 전달을 차단해, Plane Quick Dock의 전역 단축키
(QuickAdd/사이드바 토글)가 동작하지 않는다. 사용자는 관리자 권한 프로그램을
많이 쓰므로 앱 자체가 관리자 권한으로 떠야 한다.

## 검토한 대안

1. **매니페스트 방식 (채택)** — exe에 `requireAdministrator` 매니페스트를
   심는다. 어떤 경로로 실행해도 항상 관리자로 뜨지만, 실행할 때마다 UAC
   확인 창이 한 번 표시된다. 구현이 가장 단순하고 확실하다.
2. **작업 스케줄러 방식** — 최고 권한 예약 작업을 등록하고 전용 바로가기로
   실행. UAC 창이 없지만 exe 직접 실행 시에는 일반 권한으로 뜨고,
   설치/업데이트 시 작업 등록을 관리해야 한다.
3. **1+2 조합** — 가장 편하지만 작업량이 가장 많다.

사용자 응답 부재로 권장안(1)을 채택. 이후 UAC 창이 번거로우면 2를 얹을 수
있다.

## 구현

- `src-tauri/windows-app.manifest`: Tauri 기본 매니페스트(Common-Controls
  의존성)에 `requestedExecutionLevel level="requireAdministrator"`를 추가한
  전체 매니페스트.
- `src-tauri/build.rs`: `PROFILE=release`일 때만
  `WindowsAttributes::app_manifest()`로 위 매니페스트를 적용.
  - debug를 제외하는 이유: 관리자 요구 exe는 일반 권한 터미널의
    CreateProcess로 실행할 수 없어(`ERROR_ELEVATION_REQUIRED`)
    `pnpm tauri dev`가 깨진다.

## 영향/제약

- 릴리스 빌드 실행 시마다 UAC 확인 창이 한 번 뜬다.
- 로그인 시 자동 시작 기능을 나중에 추가한다면 레지스트리 Run 키로는
  관리자 앱을 못 띄우므로 작업 스케줄러 방식이 필요하다.
- 관리자 창에는 탐색기에서 파일 드래그 앤 드롭이 안 되지만, 현재 앱은
  드래그 앤 드롭을 쓰지 않는다.
- 업데이터는 앱(이미 관리자)에서 설치기를 실행하므로 영향 없다.

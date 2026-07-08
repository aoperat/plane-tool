# "내가 할당한 작업" 탭 비밀번호 잠금 — 설계 스펙

- 날짜: 2026-07-08
- 상태: 사용자 승인 대기

## 목적

사이드바의 "내가 할당한 작업" 탭(2026-07-08 구현)이 기본으로 항상 보인다.
다른 사람이 잠깐 화면을 볼 때 이 탭이 눈에 띄지 않았으면 하는 요구가
있어, 설정에서 체크박스로 켜야만 탭이 보이게 하고, 그 체크박스를 켤 때
비밀번호를 요구한다.

**중요한 전제**: 이건 실제 보안 기능이 아니라 가벼운 프라이버시 잠금이다.
단일 사용자용 로컬 데스크톱 앱이고, 비밀번호는 Rust 소스에 상수로
박히므로 앱 바이너리를 디컴파일하면 누구나 알아낼 수 있다. 목적은 "지나가다
화면을 흘끗 본 사람이 우연히/즉흥적으로 체크박스를 켜지 못하게" 막는
정도다. 이 사실을 스펙과 코드 주석에 명시해 나중에 오해하지 않게 한다.

## 핵심 설계 결정

1. **설정 필드**: `show_delegated_tab: bool`, 기본값 `false`. 기존
   `assign_notify_enabled` 등 bool 설정과 동일한 패턴(`Settings` 구조체 →
   `SettingsDto` → `save_settings` 커맨드)으로 추가한다.
2. **비밀번호 검증은 백엔드에서**: 새 Tauri 커맨드
   `verify_delegated_tab_password(password: String) -> bool`가 Rust
   상수와 비교한다. 프론트엔드 JS 번들에 평문이 그대로 노출되는 것만
   막는다(개발자도구로 즉시 보이는 걸 방지) — 위 전제대로 이것도 완전한
   보안은 아니다.
3. **체크 시에만 검증, 해제는 자유**: 체크박스를 켜려는 클릭에서만
   비밀번호 팝업이 뜬다. 체크 해제는 즉시, 비밀번호 없이 가능 — 실수로
   켰거나 급하게 다시 숨겨야 할 때 마찰이 없어야 하므로.
4. **사이드바는 설정값을 신뢰의 원천으로 삼는다**: `show_delegated_tab`이
   `false`면 탭 바(`#sbTabs`) 전체를 숨기고, `activeTab`을 무조건
   `"assigned"`로 강제한다 — `localStorage`에 이전에 저장된
   `"delegated"` 값이 있어도 무시한다. 설정을 다시 켜면 항상 "담당 작업"
   탭부터 시작한다(이전 위임 탭 선택 상태는 기억하지 않음).

## 백엔드 (`src-tauri/src/config.rs`, `src-tauri/src/commands.rs`)

`config.rs`의 `Settings` 구조체(라인 10-48 근처)에 필드 추가:

```rust
#[serde(default)]  // 기존 캐시/설정 파일과의 호환을 위해 다른 bool 필드와 동일하게 처리
pub show_delegated_tab: bool,
```

기본값은 `false`이므로 `#[serde(default)]`만으로 충분하다(별도
`default_*` 함수 불필요 — Rust `bool`의 `Default`는 이미 `false`).

`SettingsDto`(commands.rs 라인 8-26 근처)에 `pub show_delegated_tab: bool`
추가.

`save_settings` 커맨드(commands.rs 라인 204-265 근처)에 파라미터
`show_delegated_tab: Option<bool>` 추가, 기존 `assign_notify_enabled`와
동일하게 `if let Some(v) = show_delegated_tab { s.show_delegated_tab = v; }`
패턴으로 반영.

새 커맨드 추가:

```rust
/// "내가 할당한 작업" 탭을 켤 때 요구하는 비밀번호 확인. 진짜 보안이
/// 아니라 가벼운 프라이버시 잠금이다 — 이 상수는 앱 바이너리를 디컴파일
/// 하면 누구나 알아낼 수 있다. 목적은 "즉흥적으로 체크박스를 켜는 것"을
/// 막는 정도.
const DELEGATED_TAB_PASSWORD: &str = "16006937";

#[tauri::command]
pub fn verify_delegated_tab_password(password: String) -> bool {
    password == DELEGATED_TAB_PASSWORD
}
```

`lib.rs`의 `invoke_handler` 커맨드 목록에 `commands::verify_delegated_tab_password` 등록.

## 프론트엔드 — 설정 화면 (`src/settings`)

`index.html`에 기존 `.check-row` 패턴으로 체크박스 추가:

```html
<label class="check-row">
  <input id="showDelegatedTab" type="checkbox" />
  할당한 작업 보기
</label>
```

`main.ts`:
- 로드 시 `showDelegatedTab.checked = s.show_delegated_tab`.
- `click` 이벤트에서 판별한다: 체크박스의 `click` 이벤트는 브라우저가
  **이미 `.checked`를 새 값으로 뒤집은 뒤** 발생하므로, 핸들러 안에서
  `showDelegatedTab.checked === true`면 "꺼짐→켜짐"으로 전환하려는
  시도다. 이때 `event.preventDefault()`를 호출하면(체크박스는 `click`의
  기본 동작이 취소되면 `.checked`가 원래대로 되돌아가는 특수 동작을
  가진다) 브라우저가 자동으로 `.checked`를 다시 `false`로 되돌리므로,
  수동으로 되돌릴 필요 없이 비밀번호 팝업만 띄우면 된다. 팝업에서 검증에
  성공하면 그때 `showDelegatedTab.checked = true`로 코드에서 직접
  설정한다. `showDelegatedTab.checked === false`(켜짐→꺼짐 전환)면
  `preventDefault()`를 호출하지 않고 그대로 통과시킨다.
- 비밀번호 팝업: 기존 사이드바의 우선순위/날짜 팝오버와 같은 스타일의
  작은 오버레이(입력칸 + 확인 버튼 + 에러 텍스트 자리)를 설정 창에도
  동일한 CSS 클래스로 만든다. 확인 클릭 시
  `verifyDelegatedTabPassword(input.value)` IPC 호출 → `true`면
  체크박스를 켜고 팝업 닫음 → `false`면 팝업 안에 "비밀번호가 올바르지
  않습니다" 표시, 체크박스는 계속 꺼진 상태 유지.
- 저장 시 기존 흐름대로 `saveSettings(...)` 호출부에
  `showDelegatedTab.checked` 인자 추가.

`ipc.ts`에 추가:

```typescript
export const verifyDelegatedTabPassword = (password: string) =>
  invoke<boolean>("verify_delegated_tab_password", { password });
```

`types.ts`의 `SettingsDto`에 `show_delegated_tab: boolean;` 추가.

## 프론트엔드 — 사이드바 (`src/sidebar/main.ts`)

`runRefresh()`(또는 설정을 읽는 지점)에서 `getSettings()`로 받은
`show_delegated_tab`을 반영:

```typescript
const sbTabsEl = document.getElementById("sbTabs")!;
sbTabsEl.hidden = !s.show_delegated_tab;
if (!s.show_delegated_tab) {
  activeTab = "assigned";
}
```

`renderActiveTabView()`는 기존 그대로 두되, 위 강제 대입 덕분에 설정이
꺼져 있으면 항상 `assigned` 소스로만 렌더링된다.

## 엣지 케이스

- **설정 창과 사이드바가 동시에 열려 있을 때**: 설정에서 껐는데 사이드바가
  이미 떠 있으면, 사이드바의 다음 `runRefresh()`(포커스 시 자동 재조회,
  또는 새로고침 버튼) 때 반영된다. 실시간 이벤트 브로드캐스트는 이
  스펙의 범위 밖으로 둔다(다른 설정 변경들도 즉시 반영되지 않는
  기존 패턴과 동일).
- **비밀번호 입력칸 값**: 평문 텍스트 입력으로 충분하다(마스킹
  `type="password"` 사용) — 이 잠금의 목적을 감안하면 별도 강력한
  UX가 필요 없다.

## 테스트

- **Rust 단위 테스트**: `verify_delegated_tab_password`가 정확한
  비밀번호에 `true`, 그 외 모든 값(빈 문자열 포함)에 `false`를
  반환하는지.
- **TS 단위 테스트**: 이 기능은 대부분 DOM 이벤트/IPC 배선이라 기존
  관례상(`main.ts`/설정 `main.ts`는 단위 테스트 대상이 아님) 새 로직
  함수를 뽑아낼 만한 것이 마땅치 않으면 테스트를 추가하지 않는다 —
  구현 단계에서 로직을 뽑아낼 지점이 생기면 그때 테스트를 붙인다.

## CHANGELOG

- `### 추가` — "설정에서 '할당한 작업 보기'를 켜야만 사이드바의 '내가
  할당한 작업' 탭이 보이도록 변경했고, 켤 때는 비밀번호 확인을
  거칩니다."

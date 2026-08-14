# 프로젝트 검색 전용 창 분리 — 설계 스펙

- 날짜: 2026-08-14
- 상태: 구현 완료
- 목업: `docs/superpowers/mockups/2026-08-14-project-picker-window-mockup.html`
- 선행: `2026-08-10-quickadd-v2-design.md` (한눈에 보기 레이아웃으로 카드가 커진 작업)

## 목적

빠른 추가 창에서 프로젝트 드롭다운을 열면 목록이 화면 밖으로 잘린다.

원인은 배치가 아니라 **전제**다. 드롭다운은 카드 아래로 열리고
`resizeToFit()`(`src/quickadd/main.ts:40`)이 창 높이를 드롭다운 바닥까지 늘린다.
그런데 창은 열릴 때 `show_centered`(`src-tauri/src/lib.rs:715`)로 중앙에 놓인 뒤
**위쪽 좌표가 고정**이라, 늘어난 높이가 전부 아래로 나간다.

한눈에 보기 레이아웃이면 카드 370px + 드롭다운 290px(검색줄 34 + 목록 208 + 푸터
28) = 660px. 화면 세로가 이보다 좁으면 목록 아래부터 사라지고, 창을 위로 옮겨
피하면 이번엔 제목·담당자 줄이 위로 잘린다.

**"보여줄 게 늘면 창이 커진다"는 전제를 없앤다.** 프로젝트 검색을 빠른 추가 창에서
떼어내 자체 크기를 갖는 전용 창으로 옮긴다.

## 핵심 설계 결정

1. **전용 창으로 분리한다.** 창 크기를 목록 길이에서 떼어내면 잘림이 구조적으로
   불가능해진다. 카드를 덮는 인-윈도우 레이어도 같은 효과를 내지만, 전용 창은
   작성 중인 폼을 가리지 않고 mng 업무일지·사이드바에서도 재사용할 수 있다.
2. **반환 경로는 새로 만들지 않는다.** `show_quickadd_for_project`
   (`commands.rs:891`)가 사이드바 "+" 버튼용으로 이미 하는 일이 그대로 필요한
   흐름이다 — `set_last_project` 저장 → `select-project` 이벤트 emit. 받는 쪽
   리스너도 이미 있다(`quickadd/main.ts:350`). 피커는 이 배관에 올라탄다.
3. **저장이 먼저다.** 피커가 닫히면 빠른 추가 창이 포커스를 되찾고 `tauri://focus`가
   `load()`를 돌릴 수 있다. `load()`는 `state.selectedId`를 `last_project_id`로
   덮어쓰므로(`main.ts:274`), emit 전에 저장해야 방금 고른 값이 살아남는다.
   `commands.rs:899-902`가 같은 이유로 남긴 주석과 동일한 함정이다.
4. **포커스 복귀는 공짜다.** 빠른 추가 창은 포커스를 잃어도 닫히지 않는다 —
   `win.hide()`는 Esc·닫기 버튼·제출 성공에서만 부른다. 그리고 돌아올 때
   `tauri://focus` 리스너가 `titleEl.focus()`를 부르므로(`main.ts:338`) 커서가
   제목 칸으로 알아서 돌아온다. 피커는 자기 창만 숨기고 요청자 창에 포커스를 주면 된다.
5. **피커는 포커스를 잃으면 닫힌다.** 스포트라이트·커맨드 팔레트의 관습이고, 떠 있는
   것을 잊고 내버려둔 창이 생기지 않는다.
6. **화면 중앙에 띄운다.** 빠른 추가 창과 겹치지만 자리가 늘 같아 눈이 찾아가기 쉽고,
   가로 경계 계산이 새로 필요 없다. 선택된 디스플레이 기준은 다른 창과 같다.
7. **검색 로직은 그대로 옮긴다.** `shared/projectSearch.ts`의 `filterProjects`
   (부분 일치 + 초성)와 `<mark>` 강조는 지금 동작을 유지한다. 이 작업은 **어디에
   그리는지**만 바꾼다.

## 새 창 (`src-tauri/tauri.conf.json`)

```
label: "projectpicker", url: "src/projectpicker/index.html"
width: 420, height: 440
decorations: false, transparent: true, shadow: false
alwaysOnTop: true, skipTaskbar: true, visible: false
center: true, resizable: false
```

editmodal·conflict와 같은 형태다. 고정 크기이므로 이 창에는 `resizeToFit`이 없다.

## 여는 경로

```
빠른 추가: projBtn 클릭
  → openProjectPicker("quickadd", state.selectedId)      // shared/ipc.ts
  → [Rust] open_project_picker(requester, selected_id)
      show_centered(app, "projectpicker") + set_focus
      emit_to("projectpicker", "picker-open", { requester, selectedId })
```

`requester`는 결과를 되돌려줄 창의 label이다. 이 인자 하나로 나중에 mng 업무일지·
사이드바가 같은 창을 부를 수 있다 — 지금은 `"quickadd"`만 넘어온다.

`selectedId`는 목록에서 체크 표시와 키보드 커서를 놓을 자리다.

## 고르는 경로

```
피커: 항목 클릭 또는 Enter
  → pickProject(requester, projectId)                    // shared/ipc.ts
  → [Rust] pick_project(requester, project_id)
      config::set_last_project(&app, &project_id)?        // 결정 3 — 반드시 먼저
      emit_to(&requester, "select-project", project_id)   // 기존 리스너가 받는다
      projectpicker.hide()
      requester 창 set_focus
```

빠른 추가 쪽은 코드를 더할 게 없다. 기존 `select-project` 리스너가 프로젝트를 바꾸고
담당자 선택을 리셋하고 다시 그린다.

## 고르지 않고 닫는 경로

```rust
close_project_picker(requester: String, refocus: bool)
```

`refocus`는 **Esc일 때만 true**다. 포커스를 잃어 닫히는 경우엔 사용자가 이미 다른
창을 보고 있으므로 포커스를 뺏어오면 안 된다. Esc로 닫을 때만 요청자 창을 깨워
QuickAdd가 제목 칸으로 커서를 되돌리게 한다(결정 4).

## 피커 창 내부 (`src/projectpicker/{index.html,main.ts}`)

- 마운트 시 `getSettings()`로 테마를 적용하고(`applyTheme`), `listProjects()`로
  목록을 읽는다. 목록을 이벤트 payload로 실어 나르지 않는다 — 이미 있는 IPC로
  직접 읽는 편이 payload도 작고 창 간 결합도 낮다.
- 목록 읽기에는 QuickAdd와 같은 3초 쿨다운(`isWithinCooldown`)을 건다. 피커를 한 번
  여닫는 동안 QuickAdd도 포커스를 잃고 되찾으며 제 목록을 두 번 다시 읽으므로,
  빗장이 없으면 같은 rate-limited 서버에 요청이 세 번 몰린다. 테마 적용은 로컬
  파일이라 쿨다운과 무관하게 매번 한다.
- `picker-open` 이벤트로 `requester`와 `selectedId`를 받아 보관하고, 검색어를 비우고
  입력에 포커스를 준다. 창은 숨었다 다시 뜨므로 이벤트마다 초기화한다.
- 마크업은 지금 드롭다운의 `.dd-search / .dd-list / .dd-item / .dd-empty / .dd-foot`
  클래스를 그대로 쓴다. 창이 고정 크기이므로 `.dd-list`의 `max-height: 208px` 대신
  `flex: 1; overflow-y: auto`로 남는 세로를 전부 준다.
- 키보드: ↑↓ 이동, Enter 선택, Esc 닫기. `move()`/`focusedIndex()`는
  `projectPicker.ts`에서 그대로 옮긴다.
- Esc와 `tauri://blur`는 같은 처리 — 창을 숨기고 `requester`에 포커스를 돌려준다.
  (결정 5)

## 걷어낼 것 (`src/quickadd/`)

`projectPicker.ts`는 **버튼 라벨 렌더 + 클릭 시 커맨드 호출**만 남는다. 드롭다운
DOM 생성, 검색 입력, 키보드 이동, `open`/`close`/`isOpen`/`bottom`이 사라진다.

이에 딸려 `main.ts`에서 함께 정리되는 것:

| 위치 | 지금 | 이후 |
|---|---|---|
| `main.ts:42` | `resizeToFit`이 `projectPicker.bottom()`을 잰다 | 뺀다 — **잘림의 계산 경로가 사라진다** |
| `main.ts:293` | Esc가 열린 드롭다운을 먼저 닫는다 | 뺀다 (피커가 자기 Esc를 처리) |
| `main.ts:317` | 날짜 단축키가 드롭다운 열림을 피한다 | 뺀다 |
| `main.ts:256,312,327` | 제출·닫기 전 `projectPicker.close()` | 뺀다 |
| `main.ts:66` | `onDismiss`로 제목 포커스 복귀 | 뺀다 (결정 4) |

`app.css`의 `.dropdown`은 빠른 추가에서 쓰지 않게 되므로 피커 창 스타일로 옮긴다.
`.dd-item` 계열은 사이드바의 `.people-pop`도 쓰므로 공용 자리에 그대로 둔다.

## 테스트

- `projectSearch.ts`는 건드리지 않으므로 기존 `projectSearch.test.ts`가 그대로 산다.
- 피커 창에서 순수 함수로 뽑을 만한 새 로직이 없다(필터는 기존 것, 키보드 이동은 DOM
  조작). 새 단위 테스트는 두지 않는다.
- 수동 확인: 한눈에 보기 레이아웃 + 프로젝트 12개 + 세로 좁은 화면에서 목록 전체가
  보이는지, 고른 뒤 담당자 칩이 새 프로젝트 것으로 바뀌는지, 피커를 열어둔 채
  다른 앱을 클릭하면 닫히는지, 닫은 뒤 바로 타이핑하면 제목 칸에 들어가는지.

## 안 하는 것

- **mng 업무일지·사이드바 연결.** `requester` 인자로 길만 열어두고, 실제 호출은
  필요해질 때 붙인다.
- **최근 사용 프로젝트 정렬·즐겨찾기.** 지금 목록 순서를 유지한다.
- **전역 단축키로 피커 직접 열기.** 빠른 추가를 거쳐서만 연다.

## CHANGELOG

`### 변경` — 빠른 추가의 프로젝트 검색이 별도 창으로 열려, 프로젝트가 많아도 목록이
화면 밖으로 잘리지 않습니다.

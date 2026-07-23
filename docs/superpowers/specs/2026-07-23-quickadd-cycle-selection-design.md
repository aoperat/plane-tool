# QuickAdd 사이클 선택 — 설계 스펙

- 날짜: 2026-07-23
- 상태: 사용자 승인 대기
- 관련: `2026-07-22-sidebar-width-and-cycle-view-design.md` (사이클 인프라를 재사용한다)

## 목적

QuickAdd로 작업을 만들 때 그 자리에서 **사이클(스프린트)을 지정**할 수 있게 한다.
지금은 작업을 만든 뒤 Plane 웹에 들어가 사이클에 따로 넣어야 한다. 대부분의
경우 "지금 진행 중인 사이클"에 넣으므로, 오늘 날짜가 기간에 든 사이클을
**자동으로 골라** 두고, 겹치는 사이클이 여럿일 때만 사용자가 고르게 한다.

**범위 밖**: 모듈 지정, 사이클 생성·수정, 지난·예정 사이클에 넣기(진행 중만),
사이클 추가의 오프라인 큐잉(아래 "오프라인" 참고).

## 핵심 설계 결정

1. **사이클 지정은 create_issue 명령 안에서 끝낸다.** `try_create_issue_online`이
   이미 새 issue id를 돌려주므로(지금은 버린다), 온라인 생성이 성공한 그 자리에서
   그 id로 사이클에 넣는다. 프론트엔드는 issue id를 알 필요 없이 `cycle_id`만
   넘긴다. 별도 왕복이 없다.
2. **진행 중(오늘 포함) 사이클만 대상이다.** Plane은 완료된 사이클에 작업 추가를
   거부한다(400 `CYCLE_COMPLETED`). "오늘 날짜가 기간에 포함"이라는 규칙이
   자연스럽게 진행 중 사이클만 남기므로 이 제약과 맞물린다. 예정·지난 사이클은
   선택지에 없다.
3. **자동선택은 프로젝트를 고를 때 일어난다.** 프로젝트마다 사이클 세트가 다르므로,
   프로젝트가 바뀌면 그 프로젝트의 진행 중 사이클로 다시 계산한다.
4. **"마지막 선택"은 프로젝트별로 기억한다.** 진행 중 사이클이 둘 이상일 때만
   쓰인다. `localStorage`에 `프로젝트 id → 사이클 id` 맵으로 둔다(화면 취향이라
   백엔드 설정이 아니다 — 사이드바 축 선택과 같은 관례).

## UI (`src/quickadd/index.html`, `main.ts`)

프로젝트 선택 **바로 아래**에 사이클 줄을 둔다.

- 진행 중 사이클이 **0개면 이 줄을 숨긴다**(`hidden`). 사이클 없이 작업이 생성된다.
- 1개 이상이면 칩 하나를 보여준다. 칩 텍스트는 선택된 사이클 이름, 또는 아무것도
  선택 안 됐으면 `사이클 없음`.
- 칩을 누르면 팝오버가 열리고 **진행 중 사이클들 + "사이클 없음"**을 나열한다.
  현재 선택에 체크. 고르면 프론트 상태와 프로젝트별 마지막 선택(localStorage)을
  갱신한다.

칩·팝오버는 QuickAdd에 이미 있는 담당/시작/마감/우선순위/상태 칩과 같은 패턴을
따른다(새 UI 패턴을 만들지 않는다).

## 자동선택 규칙

프로젝트를 고르면(또는 QuickAdd가 열리며 마지막 프로젝트를 복원하면), 그 프로젝트의
사이클을 받아 아래를 적용한다:

| 진행 중 사이클 수 | 초기 선택 |
|---|---|
| 0 | 없음 (사이클 줄 숨김) |
| 1 | 그 사이클 자동선택 |
| 2 이상 | 프로젝트별 마지막 선택이 진행 중 목록에 있으면 그것, 없으면 `사이클 없음` |

"진행 중"의 판정은 사이드바 `splitByCycle`이 쓰는 것과 같다 — 시작·종료일이 다
있고 `start ≤ 오늘 ≤ end`. 날짜 파싱은 `logic.ts`의 `localDateOf`를 재사용한다
(바 날짜와 UTC 타임스탬프를 모두 로컬 달력 날짜로 읽는다).

## 로직 (`src/sidebar/logic.ts` — 공용, 순수·테스트)

두 순수 함수를 더한다. `splitByCycle`이 쓰는 `Cycle` 타입과 날짜 헬퍼를 그대로
재사용하므로 위치는 `logic.ts`가 맞다.

```ts
/** 오늘(now)이 기간에 포함되는 사이클만. 시작·종료일이 둘 다 있고
 *  start ≤ 오늘 ≤ end 인 것. 날짜 미정·완료·예정 사이클은 제외한다. */
export function runningCycles(cycles: Cycle[], now?: Date): Cycle[]

/** 프로젝트를 고른 직후의 초기 사이클 선택.
 *  - running 0개 → null
 *  - running 1개 → 그 사이클 id
 *  - running 2개+ → lastPickedId가 running에 있으면 그것, 없으면 null
 *  null 은 "사이클 없음"(미선택)을 뜻한다. */
export function pickInitialCycle(running: Cycle[], lastPickedId: string | null): string | null
```

테스트(`logic.test.ts`): 0/1/2+개 각각, lastPicked가 목록에 있을 때/없을 때,
타임스탬프 형식 날짜가 로컬 날짜로 올바로 판정되는지, 오늘이 정확히 시작일/종료일일
때 포함되는지.

## 백엔드 (`src-tauri/src/plane_api.rs`, `commands.rs`, `lib.rs`)

**PlaneClient 메서드**

```rust
/// 작업을 사이클에 넣는다(또는 다른 사이클에서 옮긴다). Plane은 여러 작업을
/// 한 번에 받으므로 body 는 {"issues": [issue_id]} 형태다.
pub async fn add_issue_to_cycle(&self, project_id: &str, cycle_id: &str, issue_id: &str)
    -> Result<(), String>
```

- `POST {ws_base}/projects/{pid}/cycles/{cid}/cycle-issues/`, body `{"issues":[issue_id]}`.
- 기존 `create_work_item`의 POST 패턴(직렬화·`send_retrying`)을 따른다.

**QuickAdd용 사이클 목록 명령**

```rust
#[tauri::command]
pub async fn list_project_cycles(app, project_id: String) -> Result<Vec<CycleDto>, String>
```

- `list_cycles`(이미 있음)를 그대로 노출한다. `fetch_cycle_data`와 달리 "내 작업"
  기준이 아니라 프로젝트의 **모든** 사이클을 준다(QuickAdd는 진행 중 사이클을 다
  봐야 하므로). 진행 중 필터는 프론트(`runningCycles`)가 한다.

**create_issue 명령에 사이클 연결**

`create_issue`에 `cycle_id: Option<String>` 파라미터를 더한다. 온라인 생성이
성공한 브랜치(`Ok(new_id)`)에서 `cycle_id`가 있으면 `add_issue_to_cycle`을 이어
호출한다.

```rust
Ok(new_id) => {
    config::set_last_project(&app, &project_id)?;
    if let Some(cid) = cycle_id.as_deref() {
        // 작업은 이미 만들어졌다 — 사이클 추가만 실패하면 작업을 되돌리지 않고
        // 경고만 남긴다(사용자가 사이드바에서 보고 수동으로 넣을 수 있다).
        if let Err(e) = client.add_issue_to_cycle(&project_id, cid, &new_id).await {
            eprintln!("add_issue_to_cycle failed: {e}");
            // 프론트에 알릴 신호는 아래 "사이클 추가 실패" 참고.
        }
    }
    let _ = app.emit_to("sidebar", "refresh-sidebar", ());
    Ok(())
}
```

`lib.rs`의 `invoke_handler!`에 `list_project_cycles`를 등록한다.

## 오프라인 (MVP)

승인된 방침: **사이클 추가는 오프라인 큐에 넣지 않는다.**

- 온라인이면 위처럼 작업 생성 + 사이클 추가.
- 오프라인이면(네트워크 에러 → 기존 `queue_create_and_insert` 경로) 작업만 큐에
  쌓이고 **사이클은 스킵**한다. 프론트는 "오프라인이라 사이클은 나중에 지정하세요"를
  한 번 알린다(footer 또는 토스트).

사이클 추가까지 큐잉·재전송하는 완전안은 오프라인 큐/충돌 로직을 손대야 하므로
범위 밖으로 둔다. 사이클은 보통 온라인에서 붙인다.

## 사이클 추가 실패 처리

작업 생성은 성공했는데 `add_issue_to_cycle`만 실패하는 경우(권한·경합·400 등):

- 작업은 **되돌리지 않는다** — 이미 서버에 존재하고, 사용자가 방금 만든 작업이
  사라지는 게 더 나쁘다.
- `create_issue`의 반환을 `Result<(), String>`에서 바꾸지 않고, 대신 **사이클 추가
  결과를 사이드바 이벤트나 반환 플래그로 프론트에 전달**해 "작업은 만들어졌지만
  사이클 지정에 실패했습니다"를 한 번 알린다. 정확한 전달 방식(반환 구조체 vs
  이벤트)은 구현 계획에서 정한다.

## IPC / 타입 (`src/shared/ipc.ts`, `types.ts`)

- `createIssue(...)`에 `cycleId?: string` 인자를 더한다(맨 뒤, 기존 인자 뒤).
- `listProjectCycles(projectId: string): Promise<Cycle[]>` 래퍼를 더한다.
- `Cycle` 타입은 이미 `types.ts`에 있다(재사용).

## 구현 순서

1. **로직** — `runningCycles`, `pickInitialCycle` + 테스트 (순수, 먼저).
2. **백엔드** — `add_issue_to_cycle`, `list_project_cycles`, `create_issue`에
   `cycle_id` 연결 + 테스트(wiremock).
3. **IPC** — `createIssue` 인자 확장, `listProjectCycles` 래퍼.
4. **QuickAdd UI** — 사이클 줄·칩·팝오버, 프로젝트 변경 시 자동선택 배선, 생성 시
   `cycleId` 전달, 오프라인·실패 알림.

## CHANGELOG

사용자 가시 변경 한 줄(구현 마지막 단계 커밋에서 `[Unreleased]` → `### 추가`):

```
- 작업을 추가할 때 진행 중인 사이클을 바로 지정할 수 있습니다 (프로젝트 아래 사이클 칸, 하나면 자동 선택)
```

# Plane 업무일지(Work Report) / mng 연동 API 정리

작성일: 2026-08-12. 출처: `C:\WorkSpaces\plane` 소스 코드 직접 확인
(`apps/api/plane/app/urls/workspace.py`, `views/workspace/user.py`,
`views/external/mng.py`, `views/external/mng_daily.py`,
`db/models/work_report.py`, `db/models/mng_daily_report_send.py`,
`bgtasks/work_report_schedule_task.py`).

## 0. 먼저 읽어야 할 제약 — 인증 방식이 다르다

plane-tool은 개인 API 토큰(`X-Api-Key` 헤더)으로 Plane의 **공개 REST API**
(`plane/api/`, `authentication_classes = [APIKeyAuthentication]`,
`src-tauri/src/plane_api.rs`가 호출하는 `/api/v1/...`)만 호출한다.

이번에 추가된 업무일지/mng 관련 엔드포인트 4개는 전부 **내부 앱 API**
(`plane/app/`, `authentication_classes = [BaseSessionAuthentication]`, 웹앱이
브라우저 세션 쿠키로만 호출)에 있다:

```
apps/api/plane/app/urls/workspace.py:160  user-work-report/<user_id>/
apps/api/plane/app/urls/workspace.py:165  work-report-schedule/
apps/api/plane/app/urls/workspace.py:170  work-report-schedule/test-send/
apps/api/plane/app/urls/workspace.py:180  mng/projects/
apps/api/plane/app/urls/workspace.py:185  mng/daily-reports/
```

즉 **plane-tool의 개인 API 키로는 이 5개 엔드포인트 중 어느 것도 호출할 수
없다.** 이는 새로 발견한 게 아니라, 기존 `docs/superpowers/specs/2026-07-07-
sidebar-work-journal-design.md`가 이미 동일한 이유로 서버 엔드포인트를 포기하고
로직만 클라이언트에 이식했던 것과 같은 제약이다.

**이 문서의 각 절에서 서버 로직을 그대로 옮겨 적은 이유는 두 가지 활용법을
염두에 둔 것이다:**

1. **(A안, 추천) Plane 쪽에 공개 API 엔드포인트를 추가한다.** 이 포크는
   사용자가 직접 관리하므로, `plane/api/` 아래에 `APIKeyAuthentication`을 쓰는
   경량 엔드포인트를 새로 만들어 아래 로직을 그대로 노출하면 된다 (신규 view
   + `plane/api/urls/`에 라우트 추가, 기존 `app/` 쪽 로직 함수를 그대로
   재사용 가능 — `utils/work_report.py`, `utils/mng_daily.py` 등은 이미 뷰와
   분리된 유틸이라 재사용 쉬움). 이러면 plane-tool은 서버 로직을 다시 만들
   필요 없이 바로 호출한다.
2. **(B안) plane-tool 쪽에서 로직을 재구현한다.** work-journal 모달이 이미
   했던 방식. 서버가 하는 일(특히 과거 시점 상태 스냅샷 재구성, mng 프록시
   호출)을 클라이언트에서 다시 만들어야 해서 유지보수 비용이 두 배가 되고,
   mng 프록시처럼 브라우저에서 직접 호출 불가능한 것(CORS 미지원)은 애초에
   B안으로 불가능하다.

아래 명세는 A안을 택할 경우 그대로 옮기면 되는 서버 쪽 실제 동작 기준이다.

---

## 1. 개인 업무보고 조회

`GET /workspaces/<slug>/user-work-report/<user_id>/`
— `WorkspaceUserWorkReportEndpoint` (`views/workspace/user.py:514`)

### 요청

쿼리 파라미터 (전부 선택):

| 파라미터 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `start` | `YYYY-MM-DD` | 오늘 | `completed` 버킷 판정용 로컬 날짜 범위 시작 |
| `end` | `YYYY-MM-DD` | 오늘 | 위 범위 끝. 미래 날짜면 현재 시각으로 clamp |
| `tz_offset` | 정수(분) | `0` | `Date.getTimezoneOffset()` 값 |

### 응답

```json
{
  "completed_start": "2026-08-12",
  "completed_end": "2026-08-12",
  "totals": { "completed": 3, "in_progress": 5, "upcoming": 2 },
  "projects": [
    {
      "project_id": "uuid",
      "project_detail": {
        "id": "uuid", "name": "프로젝트명", "identifier": "PRJ",
        "mng_link": {}
      },
      "counts": { "completed": 1, "in_progress": 2, "upcoming": 0 },
      "groups": {
        "completed": [ /* issue */ ],
        "in_progress": [ /* issue */ ],
        "upcoming": [ /* issue */ ]
      }
    }
  ]
}
```

issue 항목 필드: `id, name, sequence_id, priority, start_date, target_date,
completed_at, state_detail{name,group,color}, parent{id,sequence_id,name,
project_id,project_identifier}`.

### 그룹 판정 로직 (`utils/work_report.py`)

- **completed**: `Issue.completed_at`이 `[start, end]` 로컬 자정 범위(UTC 변환)
  안에 있는 이슈.
- **in_progress / upcoming**: `end` 시점(단 미래는 현재로 clamp) 기준
  **상태 스냅샷**을 `IssueActivity`(`field="state"`) 로그에서 역산해 재구성한다
  — 오늘 조회하면 현재 상태와 같지만, 과거 날짜를 조회하면 "그 시점 당시
  상태"를 보여준다 (`work_report.py:80-135`).
- **담당자 판정은 현재 시점 기준** — 과거 시점의 배정 이력은 재현하지 않는다
  (`work_report.py:60`).
- 대상 프로젝트는 조회 대상(`user_id`)이 아니라 **호출자(viewer)가 볼 수 있는
  프로젝트로 제한**된다 (`project__project_projectmember__member=viewer_user_id`)
  — 즉 관리자가 팀원 것을 조회해도 관리자 본인이 속한 프로젝트만 나온다.

### 권한

`WorkspaceEntityPermission` — 워크스페이스 활성 멤버면 GET 가능 (admin
제한 없음, URL에 임의 `user_id`를 넣어 다른 사람 것도 조회 가능 — 팀 조회
UI가 이걸 활용).

---

## 2. 업무일지 자동 이메일 발송 설정

`GET/PATCH /workspaces/<slug>/work-report-schedule/`
— `WorkspaceWorkReportScheduleEndpoint` (`views/workspace/user.py:561`)

요청자 **본인** 설정 1행만 다룬다 (`unique_together = ("workspace", "user")`).

### GET

없으면 기본값으로 자동 생성 후 반환.

### PATCH 요청 / 응답 공통 필드

| 필드 | 타입 | 비고 |
|---|---|---|
| `enabled` | bool | |
| `cadence` | `"daily"` \| `"weekly"` | |
| `weekday` | int 0~6 | `weekly`일 때만 의미 |
| `send_time` | `"HH:MM"` | 기본 `"09:00"` |
| `recipient_ids` | string(uuid)[] | 반드시 `WorkspaceMember(is_active=True)`, 아니면 400 |

모델: `WorkReportSchedule` (`db/models/work_report.py:13-39`,
migration `0124_workreportschedule.py`) — 위 필드 + `last_sent_date`.

### 테스트 발송

`POST /workspaces/<slug>/work-report-schedule/test-send/`
— `WorkspaceWorkReportTestSendEndpoint` (`views/workspace/user.py:622`)

바디 없음. 요청자 본인 이메일로 즉시 발송(`send_work_report_email.delay`).

### 백그라운드 발송 (`bgtasks/work_report_schedule_task.py`)

- 5분마다 도는 celery beat가 `enabled=True & send_time <= now &
  last_sent_date != today`인 스케줄을 찾아, `daily`/`weekly` 요일 조건까지
  맞는 것만 발송한다. 발송 성공 여부와 무관하게 즉시 `last_sent_date`를
  오늘로 마킹한다 (at-most-once, 재시도 없음).
- 본문은 `daily`면 어제~오늘, `weekly`면 이번 주 월요일~오늘 범위로
  1번 절의 로직을 그대로 사용해 만든다.
- Microsoft Graph API가 설정돼 있으면 우선 사용, 아니면 SMTP 폴백.

---

## 3. mng(외부 사내 시스템, IDINO BIZPLUS) 연동

**mng는 Plane과 무관한 별도의 외부 REST API(`https://mng.idino.co.kr`)다.**
Plane은 여기에 "일일 업무일지"를 대신 등록/조회/수정/삭제해주는 프록시
역할만 한다. mng는 CORS 헤더를 주지 않아 브라우저(또는 데스크톱 앱)가 직접
호출할 수 없고, 반드시 서버를 거쳐야 한다.

### 3-1. 프로젝트 검색

`GET /workspaces/<slug>/mng/projects/` — `MngProjectSearchEndpoint`
(`views/external/mng.py:23`). mng 프로젝트를 검색해 한글 키 응답을 내부
스키마로 정규화해 반환 (정확한 스키마는 미조사 — 필요 시 추가 확인 필요).
Plane 쪽 `Project.mng_link` 필드에 연계 키(year/kind/seq/client 등 확인,
전체 스키마는 미조사)를 저장해 이후 제출 시 사용한다.

### 3-2. 일일 업무일지 조회/등록/수정/삭제

`GET/POST/PATCH/DELETE /workspaces/<slug>/mng/daily-reports/`
— `MngDailyReportSendEndpoint` (`views/external/mng_daily.py:61`)

권한: `WorkspaceEntityPermission` + 뷰 내부에서
`@allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")` — 게스트
명시적 배제.

#### GET — 특정 날짜에 실제로 mng에 등록된 행 조회

쿼리: `date` (`YYYY-MM-DD`, 필수).

요청자 사번(`Profile.employee_no`, 없으면 이메일로 mng에서 자동 조회해 채움
— `resolve_employee_no`)으로 그 날짜의 실제 등록 행 전체를 반환.
`mng_available: false`면 mng 연결 자체가 실패한 것 — "미등록"으로 오인해
중복 등록시키지 않도록 이 경우와 실제 0건을 구분해서 응답한다.

응답 행 필드: `seq, project_id(연계키로 역매칭), mng_project_name, state,
state_name, client_name, content_html, spent_hours, spent_minutes,
editable`(사이트명_선택이 있는 행은 `false`).

#### POST — 신규 등록

바디: `project_id, state("01"~"04"), content_html, report_date(YYYY-MM-DD,
미래 불가·서버가 KST "오늘" 기준 검증), spent_hours, spent_minutes`.

사전 조건: 프로젝트가 요청 워크스페이스 소속 + 요청자가 활성 멤버 +
`project.mng_link` 설정됨.

동작: HTTP 호출 **전에** `MngDailyReportSend` 행을 `PENDING`으로 먼저 생성
(중복 클릭 시 각각 별도 행 — 의도적으로 unique 제약 없음, 재발송 이력을
모두 보존하기 위함) → mng 성공 시 `SENT`, mng가 거부하면 `FAILED`,
타임아웃이면 `UNKNOWN`(등록 여부 불명, 재시도 유도 안 함).

#### PATCH/DELETE — 수정/삭제

바디: `report_date, seq`(대상 유일 키) + (PATCH만) `state, content_html,
spent_hours, spent_minutes`.

mng API가 부분 필드 수정을 지원하지 않아(필드 하나 빠지면 mng 서버가 500)
서버가 먼저 GET으로 기존 행 전체를 다시 읽어 클라이언트가 안 보낸 필드를
채운 뒤 mng에 전체 재전송한다. `site_name_selected`가 있는 행은 PATCH 시
400으로 거부(DELETE는 허용).

### mng API 자체의 알려진 특성 (실측 확인, `utils/mng_daily.py` 등 docstring)

- 상태코드는 업무일지 API `01~04`, 프로젝트 조회 API는 `05`까지 별개 5종.
- mng는 실패해도 HTTP 200을 주고 응답 바디 `hasError` 필드로만 성공/실패
  판정.
- 소요시간/분은 반드시 **문자열**로 보내야 함(숫자로 보내면 400).
- 유일 키는 **사번+일자+순번** (연도/순번 조합 아님 — 실측 5,952건 중 73건
  충돌 확인됨).
- mng 직원 조회 API의 "이메일"/"재직여부" 필드는 상류 버그로 신뢰 불가,
  읽지 않음.

### 모델

`MngDailyReportSend` (`db/models/mng_daily_report_send.py`, migration
`0127_mng_daily_report_send.py`): `workspace, user, project, report_date,
status(pending/sent/failed/unknown), state_code, spent_hours, spent_minutes,
content_html, error_message`(내부 전용, 응답에 노출 안 됨). **모델
docstring에 "나중에 unique 제약 추가하지 말 것" 명시** — 재발송 이력 보존
목적.

---

## 4. plane-tool 기존 기능과의 관계

- `docs/superpowers/specs/2026-07-07-sidebar-work-journal-design.md`의
  "오늘 업무일지" 모달은 1번 절 로직을 **클라이언트에서 재구현**한 것이다
  (제약 이유는 0절과 동일). 단, "오늘"만 지원하고 과거 시점 상태 스냅샷
  재구성은 하지 않는다(Non-goal로 명시) — 서버 로직(1번 절)은 이걸 지원한다.
- mng 연동(3번 절)은 plane-tool에 대응 기능이 전혀 없다 — CORS 문제로
  클라이언트 재구현 자체가 불가능해서, A안(서버에 토큰 인증 엔드포인트 추가)
  없이는 plane-tool에서 만들 수 없는 기능이다.
- 자동 이메일 발송 설정(2번 절)도 plane-tool에 대응 기능이 없다.

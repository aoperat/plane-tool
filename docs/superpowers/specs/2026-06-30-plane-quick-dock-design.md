# Plane Quick Dock — 설계 문서

- 작성일: 2026-06-30
- 상태: 승인됨 (목업 확정)
- 작성자: aoperat
- 프로젝트 위치: `C:\WorkSpaces\plane-tool` (Plane 모노레포와 분리된 형제 폴더)

## 1. 목적

self-hosted Plane 인스턴스에 대해, 데스크톱 어디서든 글로벌 단축키로 (1) 진행 중인 작업을 빠르게 워크아이템으로 추가하고, (2) 내 프로젝트와 할당된 작업을 빠르게 조회하는 Windows 상주 도구.

별도 앱을 띄우거나 브라우저로 전환하지 않고, 손이 키보드를 떠나지 않은 채로 캡처/조회하는 것이 핵심 가치다.

## 2. 범위

### 포함 (MVP)
- Windows 트레이 상주 앱 (Tauri v2)
- 두 개의 글로벌 단축키 surface:
  - `Alt+Space` → 빠른 추가 팝업
  - `Alt+S` → 조회 사이드바
- self-hosted Plane REST API 연동 (읽기 + 쓰기)
- 설정창 (Plane base URL, API 토큰, 워크스페이스)

### 제외 (YAGNI — 추후)
- 작업 수정/삭제, 댓글, 상태 변경
- 빠른 추가의 설명/우선순위/담당자 필드 (1차는 제목만)
- 라이트 테마 (1차는 다크 고정)
- macOS / Linux

## 3. 단축키 & 충돌 주의

| 단축키 | surface |
|---|---|
| `Alt+Space` | 빠른 추가 팝업 |
| `Alt+S` | 조회 사이드바 |

> 주의: `Alt+Space`는 Windows 기본 창 시스템 메뉴 단축키와 충돌 가능. 등록 실패/충돌 시 설정에서 대안 단축키(예: `Alt+Shift+Space`)로 바꿀 수 있게 한다. 단축키는 설정에서 변경 가능해야 한다.

## 4. UI 설계 (목업 확정)

> 확정 목업: [`docs/mockups/plane-quick-dock-mockup.html`](../../mockups/plane-quick-dock-mockup.html) — 브라우저로 열어 두 surface를 한 화면에서 확인할 수 있다.

### 4.1 빠른 추가 팝업 (`Alt+Space`)
- 화면 중앙, 작은 프레임리스 카드 (`decorations: false`, `always_on_top`, `skip_taskbar`)
- 구성:
  - 상단: 제목 입력줄 (단일 라인, 좌측 액센트 바)
  - 하단 좌측: **프로젝트 셀렉터** — 기본값은 마지막에 선택한 프로젝트("지난번 선택"), `↑↓`로 변경, 드롭다운에 색 점 + 체크
  - 하단 우측: 키 힌트 (`↑↓ 프로젝트 / Enter 추가 / Esc 닫기`)
- 동작: 제목 입력 → `Enter` → 워크아이템 생성 → 성공 토스트 → 닫힘 / `Esc` 닫기 / 포커스 잃으면 자동 숨김

### 4.2 조회 사이드바 (`Alt+S`)
- 화면 우측 도킹 패널 (프레임리스, 우측 그림자)
- 구성:
  - 헤더: 로고 + 계정명 + 새로고침(⟳)
  - **내 프로젝트** 섹션: 참여 중 프로젝트 목록 (색 점 + 이름 + 열린 이슈 수)
  - **나에게 할당된 작업** 섹션: 상태 점(할일/진행/완료) + 작업명 + 프로젝트 태그 + 우선순위 + 마감일
  - 푸터: 마지막 동기화 시각 + "새 작업(Alt+Space)" 바로가기
- 동작: 항목 클릭 → 브라우저에서 Plane 해당 페이지 열기 / 캐시 즉시 표시 + 백그라운드 새로고침 / `Esc`·포커스 상실 시 숨김

## 5. 아키텍처

Tauri v2 단일 앱. Rust 백엔드(코어) + WebView 프론트엔드 2개 창.

### 컴포넌트

| 컴포넌트 | 책임 | 의존 |
|---|---|---|
| Tray + 단축키 등록 (Rust) | `tauri-plugin-global-shortcut`로 단축키 등록, 트레이 메뉴(설정·종료), 창 show/hide | Tauri core |
| 설정 저장소 (Rust) | base URL, 워크스페이스 slug, 마지막 선택 프로젝트 ID 저장. **API 토큰은 OS 키체인**(`keyring`) 보관 | `tauri-plugin-store` + keyring |
| Plane API 클라이언트 | 3개 기능: `내 프로젝트 조회`, `할당된 작업 조회`, `워크아이템 생성`. `X-API-Key` 헤더 | reqwest(권장, 토큰을 프론트로 노출 안 함) |
| QuickAdd UI (웹) | 제목 입력 + 프로젝트 드롭다운(기본=마지막 선택) | invoke→API 클라이언트 |
| Sidebar UI (웹) | 프로젝트/할당작업 리스트, 새로고침, 항목 클릭 시 외부 열기 | invoke→API 클라이언트 |
| 설정 UI (웹) | base URL/토큰/워크스페이스/단축키 입력 | 설정 저장소 |

> 각 컴포넌트는 독립적으로 테스트 가능하도록 경계를 분리한다. API 클라이언트는 순수 함수 단위(요청→응답 매핑)로 두어 모킹 테스트가 쉽게.

## 6. 데이터 흐름

**빠른 추가**
1. 사용자 `Alt+Space` → 팝업 표시, 제목 input 포커스, 프로젝트 셀렉터=저장된 마지막 선택
2. 제목 입력 + (필요 시 프로젝트 변경) → `Enter`
3. 프론트 → `invoke("create_issue", {projectId, name})` → Rust가 `POST /api/v1/workspaces/{slug}/projects/{projectId}/work-items/` (body `{ "name": <제목> }`, header `X-Api-Key`)
4. 성공 → 선택 프로젝트 ID를 store에 저장(다음 기본값) → 토스트 → 창 숨김

**조회**
1. 사용자 `Alt+S` → 사이드바 표시, 캐시 데이터 즉시 렌더
2. 백그라운드: `users/me`로 내 id 확보 → `내 프로젝트 조회` → 각 프로젝트의 `work-items?expand=assignees,state` 조회 → **내 id가 assignees에 포함된 미완료 항목만 클라이언트 필터** → 합쳐서 렌더, 캐시 갱신
3. 항목 클릭 → `shell.open(plane_issue_url)`

## 7. Plane API 연동 (이웃 `plane` 리포 코드로 검증 완료)

self-hosted Plane 공개 REST API(`/api/v1/`, API 키 인증)는 **프로젝트 단위** 구조다. 아래는 `plane` 소스에서 확인한 사실:

- **인증 헤더**: `X-Api-Key` (대소문자 그대로). 근거: `apps/api/plane/api/middleware/api_authentication.py`
- **내 프로젝트 목록**: `GET /api/v1/workspaces/{slug}/projects/`
  - 커서 페이지네이션: 응답 `{ next_cursor, prev_cursor, total_count, count, total_pages, results: [...] }`, `per_page`(기본/최대 1000), `cursor=<value>:<offset>:<is_prev>`
  - 항목 필드: `id`, `name`, `identifier`, `icon_prop`, `emoji`, `description`. **단순 color hex 필드는 없음** → 사이드바/팝업의 색 점은 **프로젝트 id 해시로 결정적 색** 생성.
  - 이 엔드포인트는 요청자가 멤버인 프로젝트를 반환(별도 멤버십 필터 불필요).
- **워크아이템(이슈) 생성**: `POST /api/v1/workspaces/{slug}/projects/{project_id}/work-items/`
  - 최소 바디 `{ "name": "<제목>" }` 만으로 생성 가능(나머지 `state`/`priority`/`assignees` 등은 `required=False`).
- **워크아이템 조회(프로젝트별)**: `GET /api/v1/workspaces/{slug}/projects/{project_id}/work-items/`
  - **담당자 필터 쿼리 파라미터 없음.** → `?expand=assignees,state&per_page=100`으로 받아 **클라이언트에서 내 user id가 `assignees`에 포함된 항목만** 필터.
  - 항목 필드: `id`, `name`, `priority`(`urgent|high|medium|low|none`), `target_date`(마감일), `state`(`expand` 시 객체, `group`∈`backlog|unstarted|started|completed|cancelled|triage`), `assignees`(uuid 배열 또는 `expand` 시 객체), `sequence_id`.
  - 사이드바 상태 점 매핑: `completed`→완료, `started`→진행, 그 외→할일. 완료/취소는 기본 숨김(설정에서 토글 여지).
- **내 user id**: `GET /api/v1/users/me/` → `{ id, display_name, email, ... }`
- **이슈 웹 URL**(브라우저 열기): `{base}/{workspace_slug}/projects/{project_id}/issues/{issue_id}`
  - 주의: 웹 라우트는 `/issues/`를 쓴다(생성/조회 API의 `/work-items/`와 경로 단어가 다름).

## 8. 설정 & 보안
- 최초 실행 시 설정창: Plane base URL, API 토큰, 워크스페이스 slug 입력
- API 토큰은 평문 store가 아니라 **OS 자격 증명 저장소**에 보관
- 모든 Plane 요청은 Rust 백엔드에서 수행 → 토큰이 WebView(JS)로 노출되지 않음

## 9. 에러 처리
- 단축키 등록 실패(충돌) → 트레이 알림 + 설정에서 대안 키 안내
- API 인증 실패(401) → 설정창 열고 토큰 재입력 유도
- 네트워크 실패 → 사이드바는 마지막 캐시 유지 + "오프라인/동기화 실패" 표시, 빠른추가는 토스트로 실패 알림(입력 유지)
- 빈 제목 → 전송 비활성

## 10. 테스트 전략
- API 클라이언트: 모킹된 HTTP 응답으로 요청 생성/응답 파싱 단위 테스트
- 설정 저장소: 마지막 선택 프로젝트 round-trip 저장/복원 테스트
- 통합(수동): self-hosted Plane 대상으로 생성/조회 스모크 테스트
- 단축키/창 토글: 수동 QA 체크리스트

## 11. 열린 결정 (스캐폴딩 시)
- 프로젝트 위치: `C:\WorkSpaces\plane-tool` (확정)
- 프론트엔드 프레임워크: 바닐라 + Vite vs 경량 프레임워크 — 플랜에서 결정

# 사이드바 릴리즈 노트 기능 설계

날짜: 2026-07-03
상태: 자율 진행(사용자 부재 중 기본값으로 확정) — 구현 후 사용자 검토 예정

## 목적

사이드바에서 앱의 릴리즈 노트(버전별 변경 내역)를 불러와 볼 수 있게 한다.
지금은 업데이트 대화상자에서 새 버전의 노트만 잠깐 보일 뿐, 지난 버전들의
변경 내역을 앱 안에서 확인할 방법이 없다.

## 데이터 소스

GitHub Releases API: `GET https://api.github.com/repos/aoperat/plane-tool/releases?per_page=10`

- 리포는 공개이므로 인증 불필요 (자동 업데이트도 같은 전제를 이미 사용).
- 릴리즈 본문은 릴리스 워크플로가 CHANGELOG의 해당 버전 섹션으로 채우므로
  (`scripts/get-release-notes.ps1`) 한국어 사용자용 문구가 그대로 온다.
- draft/prerelease는 제외, 최근 10개만.

### 검토한 대안

- **번들 CHANGELOG.md** (`?raw` import): 오프라인 동작이 장점이지만 설치된
  버전까지만 보이고, "불러오기" 요청 취지(원격 조회)와 다름.
- **프론트엔드에서 직접 fetch**: GitHub API는 CORS 허용이라 가능하지만, 이
  앱은 모든 HTTP를 Rust 커맨드로 경유하는 구조라 일관성을 깬다.

## 구성 요소

1. **Rust 커맨드 `fetch_release_notes`** (`src-tauri/src/commands.rs`)
   - reqwest GET (User-Agent 필수), 실패 시 `Err(String)`.
   - 순수 매핑 함수 `map_release_notes(json) -> Vec<ReleaseNoteDto>`
     (`{version, date, notes}` — 태그의 `v` 접두사 제거, 날짜는 YYYY-MM-DD)
     를 분리해 단위 테스트.
2. **IPC** (`src/shared/ipc.ts` + `types.ts`): `fetchReleaseNotes(): Promise<ReleaseNote[]>`.
3. **마크다운 미니 렌더러** (`src/sidebar/releaseNotes.ts` + 테스트)
   - 입력을 전부 HTML 이스케이프한 뒤 `###` 제목 → 카테고리 라벨,
     `- ` 줄 → `<ul><li>`, 백틱 → `<code>`만 인식. 링크/이미지 등은 텍스트로.
4. **UI** (`src/sidebar/index.html`, `main.ts`, `src/shared/app.css`)
   - 더보기(⋯) 메뉴에 "릴리즈 노트" 항목 추가 ("업데이트 확인" 아래).
   - 사이드바 전체를 덮는 오버레이 패널: 헤더(제목 + ✕) + 스크롤 본문.
   - 버전 카드: `v0.1.3 · 2026-07-03`, 설치된 버전이면 "현재 버전" 배지.
   - 닫기: ✕ 버튼 또는 Esc (팝오버 → 릴리즈 노트 패널 → 사이드바 숨김 순).

## 데이터 흐름

메뉴 클릭 → 패널 표시 + "불러오는 중…" → `fetch_release_notes` →
카드 렌더링. 결과는 세션 메모리에 캐시(패널 재오픈 시 재요청 없음 —
GitHub 비인증 rate limit 60회/시 보호).

## 오류 처리

- 네트워크/HTTP 오류: 패널 안에 실패 메시지 + "다시 시도" 버튼.
- 본문이 빈 릴리즈(초기 버전): "(변경 내역 없음)" 표시.

## 테스트

- Rust: `map_release_notes` — draft/프리릴리스 제외, v 접두사 제거, 날짜 절단,
  누락 필드 허용.
- vitest: 마크다운 미니 렌더러 — 이스케이프, 카테고리/목록/코드 변환, 빈 본문.

# QuickAdd 등록 실패 이유 표시 — 설계

날짜: 2026-07-02

## 문제

QuickAdd 팝업(`src/quickadd/main.ts`)의 `submitIssue()`는 실패 시 이유를 화면에 보여주지 않는다.

- 제목이 비어있거나 프로젝트가 선택되지 않으면 아무 표시 없이 조용히 리턴한다.
- 서버 호출(`createIssue`)이 실패하면 제목 글자색만 빨갛게 바뀌고(`title-input.error`), 실제 사유는 `console.error`로만 남는다.

## 변경안

editmodal(`emError`) / settings(`status`)에서 이미 쓰는 "실패 사유 텍스트 한 줄" 패턴을 QuickAdd에도 동일하게 적용한다.

1. **`src/quickadd/index.html`** — `chip-row`와 `popup-bottom` 사이에 에러 줄 추가:
   ```html
   <p class="em-error" id="qaError" hidden></p>
   ```
   `.em-error` 스타일은 `app.css`에 이미 정의되어 있어 그대로 재사용한다 (`color: var(--red); font-size: 12px; padding: 0 18px 12px`).

2. **`src/quickadd/main.ts`** — `submitIssue()`에서 실패 사유를 채워 넣는다:
   - 제목 비어있음 → `"제목을 입력하세요"` (기존 `titleEl.classList.add("error")`도 유지)
   - 프로젝트 미선택 → `"프로젝트를 선택하세요"`
   - `createIssue` reject → `"등록 실패: " + err` (editmodal의 `"저장 실패: " + err`와 동일한 원본-에러-그대로 패턴; 별도 한국어 매핑 없음)

3. **에러 해제 시점**:
   - 제목 입력창 keydown 시 (기존 `titleEl.classList.remove("error")`와 같은 지점에서) 에러 줄 숨김
   - 팝업 재포커스 시 `resetFields()`에서 숨김

4. **높이 재조정**: 에러 줄 표시/숨김이 팝업 높이를 바꾸므로 매번 `resizeToFit()` 호출 (editmodal 패턴과 동일).

## 범위 밖

- 서버 에러 문자열의 한국어 매핑 (`not_configured` 등) — 앱 전역이 원본 노출 방식이므로 이번 변경에서는 다루지 않는다.
- 사이드바/editmodal의 에러 표시 방식 변경.

# 설정창 토큰 저장 상태 표시 — 설계 (시안 B)

날짜: 2026-07-03
목업: `docs/mockups/settings-token-status-mockup.html` (시안 B 승인됨)

## 문제

토큰 저장 여부가 password 입력창의 placeholder 문구로만 표시되어, 저장 완료
상태인지 설정창에서 확인하기 어렵다.

## 변경안

토큰이 저장된 상태에서는 입력창 대신 **저장됨 카드**를 보여준다:

```
[✓  ••••••••••••          저장됨  [변경]]
```

- 카드: 초록 체크 + 마스크(고정 12자 `•`) + "저장됨" 라벨 + [변경] 버튼.
  입력창과 같은 배경/테두리/radius로 그 자리에 대체 표시.
- **[변경] 클릭** → 카드 숨기고 입력창 표시 + 포커스. placeholder는 "API 토큰 입력"으로 단일화.
- **저장 성공** 시 (새 토큰을 입력했다면) 다시 카드 상태로 복귀.
- 토큰이 없는 설치에서는 기존처럼 입력창만 보인다.

## 구현 포인트

- `src/settings/index.html`: label 안에 `#tokenSaved` 카드(span)와 기존 `#token`
  입력을 나란히 두고 `hidden`으로 상호 전환. 카드 안 [변경] 버튼은 label 활성화
  전파를 막기 위해 클릭 시 `preventDefault()`.
- `src/shared/app.css`: `.token-saved-row`(+ `.check`/`.mask`/`.meta`),
  `.token-change-btn` 추가. `.token-saved-row`는 `display:flex`이므로
  **`.token-saved-row[hidden] { display: none; }`을 반드시 함께 선언**
  (description-input에서 겪은 UA [hidden] 무력화 문제와 동일).
- `src/settings/main.ts`: `hasToken` 상태 + `renderTokenField(editing)` —
  카드는 `hasToken && !editing`일 때만. 저장 성공 시 토큰을 보냈으면
  `hasToken = true`로 갱신 후 비편집 상태로 복귀.

## 범위 밖

- 토큰 삭제 기능(현재도 없음), 토큰 유효성 검증 표시.

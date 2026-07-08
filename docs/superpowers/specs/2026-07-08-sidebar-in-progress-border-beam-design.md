# Sidebar In-Progress Task Border Beam — Design

## Problem

사이드바에서 상태가 "진행 중"(`state_group === "started"`)인 작업 카드가 다른
상태(시작 전/완료 등)와 시각적으로 구분되지 않는다. 목록을 스크롤하면서
지금 실제로 진행 중인 작업을 한눈에 짚어낼 수 있도록, 해당 카드의 테두리를
따라 도는 은은한 빛(beam) 애니메이션 효과를 추가한다.

## Goals

- `state_group === "started"`인 작업 카드(`.task`)에 테두리를 따라 도는
  은은한 빛 효과를 적용한다.
- 다크/라이트 테마 양쪽에서 자연스럽게 보인다 (`--accent` 기반, 테마별 값
  자동 대응).
- 카드 개수와 무관하게 애니메이션 비용이 가볍다 — 매 프레임 리페인트가
  아닌 컴포지터 전용(transform/offset-distance) 애니메이션을 사용한다.
- `prefers-reduced-motion: reduce` 환경에서는 애니메이션 없이 정적인 은은한
  강조만 보인다 (기존 `qa-submit-pulse` 관례를 따름).
- 기존 `.task:hover`, `.task.completed` 스타일과 충돌하지 않는다.

## Non-goals

- "선명한 그라데이션" 같은 강도 옵션 제공 — 은은한 버전 하나만 구현한다
  (목업에서 사용자가 확정).
- `state_group` 외 다른 조건(우선순위, 마감 임박 등)에 따른 추가 강조 효과.
- 진행 중 작업만 모아 보여주는 별도 섹션/카운터 신설.

## Design

### 기법: `offset-path` 기반 border beam (conic-gradient 마스크 방식 아님)

목업 검증 단계에서는 `conic-gradient` + `mask-composite: exclude`로
`--angle` 커스텀 프로퍼티를 애니메이션하는 방식을 썼다. 이 방식은 매 프레임
배경(gradient)을 다시 계산해서 그리는(paint) 방식이라, 진행 중 카드가
동시에 많아지면(예: 10개 이상) 비용이 누적될 수 있다는 우려가 있었다.

대안으로 "링 전체를 `transform: rotate()`로 돌리는" 방식도 검토했지만,
작업 카드는 정사각형이 아니라 가로로 긴 사각형이라 링 자체를 회전시키면
모서리가 카드 테두리에서 어긋나 보이는 문제가 있어 기각했다.

최종 채택 기법은 작은 "빛 점" 하나를 카드 테두리 경로 위에서만 이동시키는
방식이다:

- `::before` 가상 요소를 작은 원(점)으로 만든다.
- `offset-path: border-box`로 이동 경로를 카드의 실제 테두리(둥근 모서리
  포함)로 지정한다.
- `offset-distance`를 0%→100%로 애니메이션한다. 이는 `transform` 애니메이션과
  동일하게 컴포지터 스레드에서만 처리되어 리페인트가 발생하지 않는다 — 카드
  개수가 늘어도 비용이 거의 0에 가깝다.
- 살짝 블러(`filter: blur(...)`)를 줘서 목업에서 확인한 "은은하게 지나가는
  빛" 느낌을 재현한다.

### 1. `src/sidebar/main.ts`

`renderTaskRow()`의 클래스 조건에 `in-progress`를 추가한다:

```ts
el.className = "task"
  + (it.state_group === "completed" ? " completed" : "")
  + (it.state_group === "started" ? " in-progress" : "");
```

### 2. `src/shared/app.css`

기존 `.task` 규칙 바로 아래에 `.task.in-progress` 관련 스타일과 keyframes를
추가한다:

```css
.task.in-progress { position: relative; }
.task.in-progress::before {
  content: "";
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  filter: blur(2px);
  opacity: 0.85;
  offset-path: border-box;
  animation: beam-travel 3.6s linear infinite;
  pointer-events: none;
}
@keyframes beam-travel {
  to { offset-distance: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .task.in-progress::before { display: none; }
  .task.in-progress { box-shadow: inset 0 0 0 1px var(--accent-soft); }
}
```

(정확한 크기/블러/투명도 값은 구현 중 실제 화면에서 미세 조정한다.)

`pointer-events: none`으로 클릭/호버 상호작용에 영향을 주지 않는다.
`.task.completed`와 `.task.in-progress`는 `state_group`이 배타적이므로
동시에 붙지 않는다.

## Testing

자동화 테스트 없음 — `src/sidebar/main.ts`는 jsdom 하네스가 없는 기존
관례를 따른다. 수동 확인 항목:

- 진행 중 작업이 0개 / 1개 / 여러 개일 때 사이드바 육안 확인.
- 다크 테마와 라이트 테마 전환 후 빛 색상이 자연스러운지 확인.
- OS의 "동작 줄이기"(`prefers-reduced-motion: reduce`) 설정을 켠 상태에서
  애니메이션 없이 정적 강조만 보이는지 확인.
- 진행 중 카드에 마우스를 올렸을 때(`hover` 배경 변경)와 조합해도 효과가
  깨지지 않는지 확인.

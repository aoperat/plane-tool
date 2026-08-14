import { openProjectPicker } from "../shared/ipc";
import { colorForId } from "../shared/color";
import type { Project } from "../shared/types";

export interface ProjectPickerHandle {
  /** 버튼 라벨을 현재 선택으로 다시 그린다. */
  render(): void;
}

/** 프로젝트 선택 버튼. 목록과 검색은 이 창에 없다 — 누르면 전용 창(projectpicker)이
 *  열리고, 거기서 고른 결과가 `select-project` 이벤트로 돌아온다(main.ts의 리스너).
 *
 *  예전에는 이 버튼이 카드 아래로 드롭다운을 펼치고 창 높이를 그만큼 늘렸는데, 그
 *  높이가 화면 아래 끝을 넘으면 목록이 잘렸다. 창을 나누면 크기가 목록 길이와
 *  무관해진다 — 설계: docs/superpowers/specs/2026-08-14-project-picker-window-design.md */
export function createProjectPicker(opts: {
  button: HTMLElement;
  getProjects: () => Project[];
  getSelectedId: () => string | null;
}): ProjectPickerHandle {
  const { button, getProjects, getSelectedId } = opts;

  function render() {
    const p = getProjects().find((x) => x.id === getSelectedId());
    const name = button.querySelector("[data-proj-name]") as HTMLElement;
    const dot = button.querySelector(".dot") as HTMLElement;
    name.textContent = p ? p.name : "프로젝트 선택";
    dot.style.background = p ? colorForId(p.id) : "transparent";
  }

  button.addEventListener("click", () => {
    openProjectPicker("quickadd", getSelectedId()).catch((err) =>
      console.error("openProjectPicker failed:", err));
  });

  return { render };
}

import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { getConflicts, getSettings, resolveConflict } from "../shared/ipc";
import { priorityIcon, priorityLabel, stateIcon, stateLabel } from "../shared/planeIcons";
import { applyTheme } from "../shared/theme";
import type { Conflict, ConflictFields } from "../shared/types";
import "../shared/app.css";

const win = getCurrentWindow();
const root = document.getElementById("conflictRoot") as HTMLElement;
const listEl = document.getElementById("cfList")!;
const emptyEl = document.getElementById("cfEmpty")!;
const closeBtn = document.getElementById("cfClose")!;

type FieldKey = keyof ConflictFields;
const FIELD_LABELS: Record<FieldKey, string> = {
  name: "제목",
  description: "설명",
  assignee_ids: "담당자",
  start_date: "시작일",
  target_date: "마감일",
  priority: "우선순위",
  state_group: "상태",
};

function fieldValueText(key: FieldKey, value: ConflictFields[FieldKey]): string {
  if (value === null || value === undefined) return "(없음)";
  if (key === "assignee_ids") return (value as string[]).join(", ") || "담당자 없음";
  if (key === "priority") return priorityLabel(value as any);
  if (key === "state_group") return stateLabel(value as any);
  return String(value);
}

function resizeToFit() {
  const height = Math.ceil(root.getBoundingClientRect().height) + 4;
  win.setSize(new LogicalSize(480, Math.max(height, 200))).catch((err) => {
    console.error("resizeToFit failed:", err);
  });
}

/** 로컬/서버 값이 실제로 다른 필드만 골라낸다 — 우연히 같아진 필드는 표시하지 않는다. */
function diffingFields(local: ConflictFields, server: ConflictFields | null): FieldKey[] {
  const keys = Object.keys(FIELD_LABELS) as FieldKey[];
  return keys.filter((k) => {
    const lv = local[k];
    if (lv === null || lv === undefined) return false; // 이 변경이 건드리지 않은 필드
    if (!server) return true; // 대상 삭제됨 — 비교할 서버 값 자체가 없음
    const sv = server[k];
    if (k === "assignee_ids") return JSON.stringify(lv) !== JSON.stringify(sv);
    return lv !== sv;
  });
}

function renderFieldRow(c: Conflict, key: FieldKey, choices: Map<string, "local" | "server">): HTMLElement {
  const row = document.createElement("div");
  row.className = "date-row";
  const label = document.createElement("span");
  label.className = "date-row-label";
  label.textContent = FIELD_LABELS[key];
  row.appendChild(label);

  const localVal = fieldValueText(key, c.local_fields[key]);
  const serverVal = c.server_fields ? fieldValueText(key, c.server_fields[key]) : "(삭제됨)";
  const choiceId = `${c.id}:${key}`;
  choices.set(choiceId, "local");

  const group = document.createElement("div");
  group.className = "chip-row";
  const localBtn = document.createElement("button");
  localBtn.type = "button";
  localBtn.className = "chip sel";
  localBtn.textContent = `내 변경: ${localVal}`;
  const serverBtn = document.createElement("button");
  serverBtn.type = "button";
  serverBtn.className = "chip";
  serverBtn.textContent = `서버 값: ${serverVal}`;
  localBtn.onclick = () => {
    choices.set(choiceId, "local");
    localBtn.classList.add("sel");
    serverBtn.classList.remove("sel");
  };
  serverBtn.onclick = () => {
    choices.set(choiceId, "server");
    serverBtn.classList.add("sel");
    localBtn.classList.remove("sel");
  };
  group.appendChild(localBtn);
  group.appendChild(serverBtn);
  row.appendChild(group);
  return row;
}

function buildMergedFields(c: Conflict, keys: FieldKey[], choices: Map<string, "local" | "server">): Partial<ConflictFields> {
  const merged: Partial<ConflictFields> = {};
  for (const k of keys) {
    const pick = choices.get(`${c.id}:${k}`) ?? "local";
    const source = pick === "local" ? c.local_fields : c.server_fields;
    if (source) (merged as any)[k] = source[k];
  }
  return merged;
}

async function resolveFieldConflict(c: Conflict, card: HTMLElement, choices: Map<string, "local" | "server">, keys: FieldKey[]) {
  try {
    if (c.kind === "UpdatePriority" || c.kind === "UpdateState") {
      // 단일 필드 충돌 — 부분 병합이 필요 없다. 사용자가 고른 쪽에 따라
      // apply(로컬 값 그대로 재적용)와 discard(서버 값 유지, 아무 것도 보내지 않음)
      // 중 하나로 정확히 매핑한다. keys가 비어있으면(우연히 같아져 필드가 안
      // 보였던 경우) 기본값 "local"로 취급 — apply해도 서버 값과 같으므로 무해하다.
      const onlyKey = keys[0];
      const picked = onlyKey ? (choices.get(`${c.id}:${onlyKey}`) ?? "local") : "local";
      if (picked === "server") {
        await resolveConflict(c.id, "discard");
      } else {
        await resolveConflict(c.id, "apply");
      }
    } else {
      const fields = buildMergedFields(c, keys, choices);
      await resolveConflict(c.id, "apply", fields);
    }
    card.remove();
    if (!listEl.childElementCount) await load();
    resizeToFit();
  } catch (err) {
    console.error("resolveConflict failed:", err);
  }
}

async function discardConflict(c: Conflict, card: HTMLElement) {
  try {
    await resolveConflict(c.id, "discard");
    card.remove();
    if (!listEl.childElementCount) await load();
    resizeToFit();
  } catch (err) {
    console.error("resolveConflict (discard) failed:", err);
  }
}

async function deleteAnyway(c: Conflict, card: HTMLElement) {
  try {
    await resolveConflict(c.id, "apply");
    card.remove();
    if (!listEl.childElementCount) await load();
    resizeToFit();
  } catch (err) {
    console.error("resolveConflict (delete anyway) failed:", err);
  }
}

function renderConflictCard(c: Conflict): HTMLElement {
  const card = document.createElement("div");
  card.className = "pop";
  card.style.position = "static";
  card.style.marginBottom = "8px";
  card.style.width = "auto";

  const head = document.createElement("div");
  head.className = "pop-msg";
  head.textContent = `이슈: ${c.item_name}`;
  card.appendChild(head);

  const divider = document.createElement("div");
  divider.className = "popover-divider";
  card.appendChild(divider);

  if (c.reason === "TargetDeleted") {
    const msg = document.createElement("div");
    msg.className = "em-loading";
    msg.textContent = "이 항목은 서버에서 삭제되었습니다.";
    card.appendChild(msg);
    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "em-btn em-btn-primary";
    discardBtn.textContent = "로컬 변경 폐기";
    discardBtn.onclick = () => discardConflict(c, card);
    card.appendChild(discardBtn);
    return card;
  }

  if (c.kind === "Delete") {
    const msg = document.createElement("div");
    msg.className = "em-loading";
    msg.textContent = "이 항목이 그 사이 서버에서 변경되었습니다. 그래도 삭제할까요?";
    card.appendChild(msg);
    const row = document.createElement("div");
    row.className = "em-foot-right";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "em-btn em-btn-primary";
    delBtn.textContent = "그래도 삭제";
    delBtn.onclick = () => deleteAnyway(c, card);
    const keepBtn = document.createElement("button");
    keepBtn.type = "button";
    keepBtn.className = "em-btn em-btn-ghost";
    keepBtn.textContent = "삭제 취소";
    keepBtn.onclick = () => discardConflict(c, card);
    row.appendChild(keepBtn);
    row.appendChild(delBtn);
    card.appendChild(row);
    return card;
  }

  const keys = diffingFields(c.local_fields, c.server_fields);
  const choices = new Map<string, "local" | "server">();
  for (const k of keys) {
    card.appendChild(renderFieldRow(c, k, choices));
  }
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "em-btn em-btn-primary";
  doneBtn.textContent = "해결 완료";
  doneBtn.style.marginTop = "8px";
  doneBtn.onclick = () => resolveFieldConflict(c, card, choices, keys);
  card.appendChild(doneBtn);
  return card;
}

async function load() {
  try {
    const conflicts = await getConflicts();
    listEl.innerHTML = "";
    emptyEl.hidden = conflicts.length > 0;
    for (const c of conflicts) {
      listEl.appendChild(renderConflictCard(c));
    }
    resizeToFit();
  } catch (err) {
    console.error("getConflicts failed:", err);
  }
}

closeBtn.onclick = () => win.hide();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") win.hide();
});
win.listen("conflicts-open", load);

async function loadTheme() {
  const s = await getSettings();
  applyTheme(s.theme);
}

loadTheme();
load();

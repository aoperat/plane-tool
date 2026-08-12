import { getCurrentWindow } from "@tauri-apps/api/window";
import { fetchSidebarData, getSettings, openEditModal } from "../shared/ipc";
import { resolveDatePreset, shiftIsoDate } from "../shared/datePresets";
import { applyTheme } from "../shared/theme";
import type { ItemChange, SidebarData, WorkItem } from "../shared/types";
import { createCarouselController } from "./carousel";
import {
  buildTickerItems,
  itemChangeNeedsAssignedRefresh,
  nextTickerIndex,
  previousTickerIndex,
  reconcileTickerIndex,
} from "./logic";
import type { TickerItem } from "./logic";

type ViewState = "closed" | "loading" | "ready" | "empty" | "error";
const CAROUSEL_INTERVAL_MS = 7_000;
const win = getCurrentWindow();
const card = document.getElementById("tickerCard")!;
const previousButton = document.getElementById("previousTask") as HTMLButtonElement;
const nextButton = document.getElementById("nextTask") as HTMLButtonElement;
const closeButton = document.getElementById("closeTicker") as HTMLButtonElement;
const taskButton = document.getElementById("taskBody") as HTMLButtonElement;
const projectName = document.getElementById("projectName")!;
const taskTitle = document.getElementById("taskTitle")!;
const metadata = document.getElementById("metadata")!;
const position = document.getElementById("position")!;
const offlineBadge = document.getElementById("offlineBadge")!;
const statePanel = document.getElementById("statePanel")!;
const status = document.getElementById("status")!;
const retryButton = document.getElementById("retry") as HTMLButtonElement;
const progress = document.getElementById("progress")!;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let lastSidebarData: SidebarData | null = null;
let tickerItems: TickerItem[] = [];
let currentIndex = 0;
let viewState: ViewState = "closed";
let sessionActive = false;
let lifecycleGeneration = 0;
let hovered = false;
let focused = false;
let refreshInFlight: Promise<void> | null = null;
let refreshQueued = false;

const carousel = createCarouselController({
  intervalMs: CAROUSEL_INTERVAL_MS,
  onAdvance: () => {
    if (tickerItems.length <= 1 || viewState !== "ready") return;
    currentIndex = nextTickerIndex(currentIndex, tickerItems.length);
    renderCurrentTask();
  },
});

function currentItemId(): string | null {
  return tickerItems[currentIndex]?.item.id ?? null;
}

function formatCachedBadge(cachedAtMs: number | null): string | null {
  if (cachedAtMs === null) return null;
  const cachedAt = new Date(cachedAtMs);
  if (Number.isNaN(cachedAt.getTime())) return null;
  const hours = String(cachedAt.getHours()).padStart(2, "0");
  const minutes = String(cachedAt.getMinutes()).padStart(2, "0");
  return `오프라인 · ${hours}:${minutes}`;
}

function stopProgress(): void {
  progress.classList.remove("running");
  progress.hidden = true;
}

function restartProgress(): void {
  const canRun =
    viewState === "ready" &&
    tickerItems.length > 1 &&
    !hovered &&
    !focused &&
    !reducedMotion.matches;
  if (!canRun) {
    stopProgress();
    return;
  }
  progress.hidden = false;
  progress.classList.remove("running");
  void progress.offsetWidth;
  progress.classList.add("running");
}

function setNavigationDisabled(disabled: boolean): void {
  previousButton.disabled = disabled;
  nextButton.disabled = disabled;
}

function renderState(nextState: Exclude<ViewState, "ready" | "closed">, message: string): void {
  viewState = nextState;
  card.dataset.state = nextState;
  card.setAttribute("aria-busy", String(nextState === "loading"));
  taskButton.hidden = true;
  taskButton.removeAttribute("aria-label");
  statePanel.hidden = false;
  status.textContent = message;
  retryButton.hidden = nextState !== "error";
  setNavigationDisabled(true);
  carousel.stop();
  stopProgress();
}

function renderCurrentTask(): void {
  const current = tickerItems[currentIndex];
  if (!current) {
    renderState("empty", "남은 작업이 없습니다");
    return;
  }

  viewState = "ready";
  card.dataset.state = "ready";
  card.setAttribute("aria-busy", "false");
  statePanel.hidden = true;
  status.textContent = "";
  retryButton.hidden = true;
  taskButton.hidden = false;

  projectName.textContent = current.projectName;
  projectName.title = current.projectName;
  taskTitle.textContent = current.item.name;
  taskTitle.title = current.item.name;
  taskButton.title = current.item.name;
  taskButton.setAttribute("aria-label", `작업 열기: ${current.projectName} · ${current.item.name}`);
  metadata.textContent = current.meta;
  metadata.dataset.bucket = current.bucket;
  position.textContent = `${currentIndex + 1} / ${tickerItems.length}`;

  const cachedText = lastSidebarData?.is_cached
    ? formatCachedBadge(lastSidebarData.cached_at_ms)
    : null;
  offlineBadge.textContent = cachedText ?? "";
  offlineBadge.hidden = cachedText === null;
  setNavigationDisabled(tickerItems.length <= 1);
  taskButton.classList.remove("task-transition");
  void taskButton.offsetWidth;
  taskButton.classList.add("task-transition");
  restartProgress();
}

function restartCarousel(): void {
  carousel.stop();
  if (viewState === "ready" && tickerItems.length > 1 && sessionActive) {
    carousel.start();
  }
}

function rebuildTickerItems(currentId: string | null, oldIndex: number): void {
  if (!lastSidebarData) return;
  tickerItems = buildTickerItems(
    lastSidebarData.assigned,
    lastSidebarData.projects,
    resolveDatePreset("today"),
  );
  currentIndex = reconcileTickerIndex(tickerItems, currentId, oldIndex);
  if (tickerItems.length === 0) {
    renderState("empty", "남은 작업이 없습니다");
    return;
  }
  renderCurrentTask();
  restartCarousel();
}

async function runRefresh(): Promise<void> {
  const generation = lifecycleGeneration;
  if (viewState !== "ready") renderState("loading", "작업을 불러오는 중…");
  carousel.stop();
  stopProgress();
  card.setAttribute("aria-busy", "true");
  const previousId = currentItemId();
  const previousIndex = currentIndex;

  try {
    const settings = await getSettings();
    if (!sessionActive || generation !== lifecycleGeneration) return;
    applyTheme(settings.theme);

    const today = resolveDatePreset("today");
    const data = await fetchSidebarData(shiftIsoDate(today, -1), shiftIsoDate(today, 1));
    if (!sessionActive || generation !== lifecycleGeneration) return;

    lastSidebarData = data;
    tickerItems = buildTickerItems(data.assigned, data.projects, today);
    currentIndex = reconcileTickerIndex(tickerItems, previousId, previousIndex);
    if (tickerItems.length === 0) {
      renderState("empty", "남은 작업이 없습니다");
      return;
    }
    renderCurrentTask();
    restartCarousel();
  } catch (error) {
    if (!sessionActive || generation !== lifecycleGeneration) return;
    console.error("ticker refresh failed:", error);
    renderState("error", "작업을 불러오지 못했습니다");
  }
}

function refresh(): Promise<void> {
  if (!sessionActive) return Promise.resolve();
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }

  refreshInFlight = runRefresh().finally(() => {
    refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      void refresh();
    }
  });
  return refreshInFlight;
}

async function refreshIfVisible(): Promise<void> {
  try {
    if (await win.isVisible()) await refresh();
  } catch (error) {
    console.error("ticker visibility check failed:", error);
  }
}

function openTicker(): void {
  sessionActive = true;
  lifecycleGeneration += 1;
  if (viewState === "closed") renderState("loading", "작업을 불러오는 중…");
  void refresh();
}

async function hideTicker(): Promise<void> {
  sessionActive = false;
  lifecycleGeneration += 1;
  refreshQueued = false;
  lastSidebarData = null;
  tickerItems = [];
  currentIndex = 0;
  viewState = "closed";
  hovered = false;
  focused = false;
  carousel.stop();
  carousel.setHovered(false);
  carousel.setFocused(false);
  stopProgress();
  card.dataset.state = "closed";
  card.setAttribute("aria-busy", "false");
  taskButton.hidden = true;
  statePanel.hidden = false;
  status.textContent = "";
  retryButton.hidden = true;
  setNavigationDisabled(true);
  await win.hide();
}

function requestHide(): void {
  void hideTicker().catch((error) => console.error("ticker hide failed:", error));
}

function navigate(direction: "previous" | "next"): void {
  if (tickerItems.length <= 1 || viewState !== "ready") return;
  currentIndex = direction === "previous"
    ? previousTickerIndex(currentIndex, tickerItems.length)
    : nextTickerIndex(currentIndex, tickerItems.length);
  renderCurrentTask();
  carousel.resetAfterManualNavigation();
}

function applyItemChange(change: ItemChange): void {
  const needsAssignedRefresh = itemChangeNeedsAssignedRefresh(change);
  if (!lastSidebarData) {
    if (needsAssignedRefresh) void refreshIfVisible();
    return;
  }
  const currentId = currentItemId();
  const oldIndex = currentIndex;
  const item: WorkItem | undefined = lastSidebarData.assigned.find(
    (candidate) => candidate.id === change.item_id,
  );
  if (!item) {
    if (needsAssignedRefresh) void refreshIfVisible();
    return;
  }

  if (change.name != null) item.name = change.name;
  if (change.priority != null) item.priority = change.priority;
  if (change.assignee_ids != null) item.assignee_ids = change.assignee_ids;
  if (change.start_date != null) item.start_date = change.start_date === "" ? null : change.start_date;
  if (change.target_date != null) item.target_date = change.target_date === "" ? null : change.target_date;
  if (change.state_group != null && change.state_group !== item.state_group) {
    item.state_group = change.state_group;
    item.completed_at = change.state_group === "completed" ? new Date().toISOString() : null;
  }

  rebuildTickerItems(currentId, oldIndex);
  if (needsAssignedRefresh) void refreshIfVisible();
}

function removeItem(itemId: string): void {
  if (!lastSidebarData) return;
  const currentId = currentItemId();
  const oldIndex = currentIndex;
  lastSidebarData.assigned = lastSidebarData.assigned.filter((item) => item.id !== itemId);
  rebuildTickerItems(currentId, oldIndex);
}

function setHovered(value: boolean): void {
  if (hovered === value) return;
  hovered = value;
  carousel.setHovered(value);
  if (value || focused) stopProgress();
  else restartProgress();
}

function syncFocusedState(): void {
  const nextFocused = card.contains(document.activeElement);
  if (focused === nextFocused) return;
  focused = nextFocused;
  carousel.setFocused(nextFocused);
  if (nextFocused || hovered) stopProgress();
  else restartProgress();
}

previousButton.addEventListener("click", () => navigate("previous"));
nextButton.addEventListener("click", () => navigate("next"));
retryButton.addEventListener("click", () => {
  retryButton.blur();
  void refresh();
});
closeButton.addEventListener("click", requestHide);
taskButton.addEventListener("click", () => {
  const current = tickerItems[currentIndex]?.item;
  if (current) {
    void openEditModal(current.project_id, current.id, current).catch((error) =>
      console.error("openEditModal failed:", error),
    );
  }
});
card.addEventListener("pointerenter", () => setHovered(true));
card.addEventListener("pointerleave", () => setHovered(false));
card.addEventListener("focusin", syncFocusedState);
card.addEventListener("focusout", () => queueMicrotask(syncFocusedState));
reducedMotion.addEventListener("change", restartProgress);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    requestHide();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    navigate("previous");
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    navigate("next");
  }
});

// The hidden window receives its first data request only after `open-ticker`.
// Register every Tauri listener before any event handler can begin that work.
void Promise.all([
  win.listen("open-ticker", openTicker),
  win.listen("close-ticker", requestHide),
  win.listen("idle-ended", requestHide),
  win.listen("refresh-sidebar", () => void refreshIfVisible()),
  win.listen<ItemChange>("item-updated", (event) => applyItemChange(event.payload)),
  win.listen<{ item_id: string }>("item-deleted", (event) => removeItem(event.payload.item_id)),
]).catch((error) => console.error("ticker listener registration failed:", error));

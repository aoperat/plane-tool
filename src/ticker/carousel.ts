export interface CarouselController {
  start(): void;
  stop(): void;
  setHovered(hovered: boolean): void;
  setFocused(focused: boolean): void;
  resetAfterManualNavigation(): void;
}

export interface CarouselOptions {
  intervalMs: number;
  onAdvance: () => void;
}

export function createCarouselController(options: CarouselOptions): CarouselController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let hovered = false;
  let focused = false;

  const isPaused = () => hovered || focused;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clearTimer();
    if (!running || isPaused()) return;
    timer = setTimeout(() => {
      timer = null;
      if (isPaused()) return;
      options.onAdvance();
      schedule();
    }, options.intervalMs);
  };

  return {
    start() {
      running = true;
      schedule();
    },
    stop() {
      running = false;
      clearTimer();
    },
    setHovered(value) {
      hovered = value;
      schedule();
    },
    setFocused(value) {
      focused = value;
      schedule();
    },
    resetAfterManualNavigation: schedule,
  };
}

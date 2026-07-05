// 설정 화면의 전역 단축키 캡처 로직. KeyboardEvent를 Tauri global-shortcut
// 플러그인이 파싱할 수 있는 가속기 문자열("Ctrl+Shift+A")로 바꾼다.
// 이 파일이 만들어내는 형식은 src-tauri/src/lib.rs의
// ui_captured_accelerators_parse 테스트가 파서 호환성을 지킨다.

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type CaptureResult =
  | { kind: "commit"; accelerator: string }
  | { kind: "pending"; display: string }
  | { kind: "invalid"; reason: string }
  | { kind: "ignore" };

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

// KeyboardEvent.code → 플러그인 가속기 키 이름. code 기준이라 한/영 입력
// 상태나 Shift 여부와 무관하게 물리 키가 잡힌다. 여기 없는 키(넘패드 등)는
// 무시된다.
const CODE_MAP: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Backquote: "Backquote",
  Minus: "Minus",
  Equal: "Equal",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  Backspace: "Backspace",
};

export function codeToKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_MAP[code] ?? null;
}

function modifiers(e: KeyLike): string[] {
  const m: string[] = [];
  if (e.ctrlKey) m.push("Ctrl");
  if (e.altKey) m.push("Alt");
  if (e.shiftKey) m.push("Shift");
  if (e.metaKey) m.push("Super");
  return m;
}

export function captureFromKeyEvent(e: KeyLike): CaptureResult {
  const mods = modifiers(e);
  if (MODIFIER_KEYS.has(e.key)) {
    return { kind: "pending", display: mods.join("+") + "+…" };
  }
  const key = codeToKey(e.code);
  if (!key) return { kind: "ignore" };
  // 수식키 없는 일반 키를 전역 단축키로 쓰면 모든 앱에서 그 키 입력을
  // 가로채므로 F키 외에는 Ctrl/Alt/Super를 요구한다 (Shift 단독 조합도
  // 대문자 타이핑을 막아서 제외).
  const isFKey = /^F\d+$/.test(key);
  if (!isFKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return { kind: "invalid", reason: "F1~F24 외의 키는 Ctrl·Alt와 조합해야 합니다" };
  }
  return { kind: "commit", accelerator: [...mods, key].join("+") };
}

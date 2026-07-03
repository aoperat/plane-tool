import { describe, it, expect } from "vitest";
import { resolveEffectiveTheme, toggledThemePref } from "./theme";

describe("toggledThemePref", () => {
  it("flips an explicit preference", () => {
    expect(toggledThemePref("dark", false)).toBe("light");
    expect(toggledThemePref("light", false)).toBe("dark");
  });

  it("pins the opposite of the system theme when preference is auto", () => {
    expect(toggledThemePref("auto", true)).toBe("dark");
    expect(toggledThemePref("auto", false)).toBe("light");
  });
});

describe("resolveEffectiveTheme", () => {
  it("returns light when preference is light, regardless of system", () => {
    expect(resolveEffectiveTheme("light", false)).toBe("light");
    expect(resolveEffectiveTheme("light", true)).toBe("light");
  });

  it("returns dark when preference is dark, regardless of system", () => {
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
    expect(resolveEffectiveTheme("dark", true)).toBe("dark");
  });

  it("follows the system preference when preference is auto", () => {
    expect(resolveEffectiveTheme("auto", true)).toBe("light");
    expect(resolveEffectiveTheme("auto", false)).toBe("dark");
  });

  it("treats an unrecognized preference as auto", () => {
    expect(resolveEffectiveTheme("garbage", true)).toBe("light");
    expect(resolveEffectiveTheme("garbage", false)).toBe("dark");
  });
});

import { describe, expect, it } from "vitest";
import { notesToHtml } from "./releaseNotes";

describe("notesToHtml", () => {
  it("renders changelog headings and bullets", () => {
    const html = notesToHtml("### 수정\n- 버그 A 수정\n- 버그 B 수정\n\n### 추가\n- 기능 C");
    expect(html).toBe(
      '<div class="rn-cat">수정</div>' +
        '<ul class="rn-list"><li>버그 A 수정</li><li>버그 B 수정</li></ul>' +
        '<div class="rn-cat">추가</div>' +
        '<ul class="rn-list"><li>기능 C</li></ul>',
    );
  });

  it("renders [카테고리] lines from actual release bodies as category headers", () => {
    // get-release-notes.ps1 rewrites "### 변경" to "[변경]" for the update dialog.
    const html = notesToHtml("[변경]\n- 닫기 버튼 제거\n\n[수정]\n- 중복 등록 수정");
    expect(html).toBe(
      '<div class="rn-cat">변경</div>' +
        '<ul class="rn-list"><li>닫기 버튼 제거</li></ul>' +
        '<div class="rn-cat">수정</div>' +
        '<ul class="rn-list"><li>중복 등록 수정</li></ul>',
    );
  });

  it("escapes html and keeps unknown markdown as plain text", () => {
    const html = notesToHtml("<img src=x onerror=alert(1)>\n[링크](https://x)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<p>[링크](https://x)</p>");
    expect(html).not.toContain("<img");
  });

  it("renders backticks as inline code, escaping the contents", () => {
    expect(notesToHtml("- 대괄호 `[`, `]` 입력 수정")).toBe(
      '<ul class="rn-list"><li>대괄호 <code>[</code>, <code>]</code> 입력 수정</li></ul>',
    );
    expect(notesToHtml("`<b>`")).toBe("<p><code>&lt;b&gt;</code></p>");
  });

  it("returns empty string for an empty body", () => {
    expect(notesToHtml("")).toBe("");
    expect(notesToHtml("\n  \n")).toBe("");
  });

  it("closes an open list at a blank line and at the end", () => {
    const html = notesToHtml("- a\n\n일반 문단\n- b");
    expect(html).toBe('<ul class="rn-list"><li>a</li></ul><p>일반 문단</p><ul class="rn-list"><li>b</li></ul>');
  });
});

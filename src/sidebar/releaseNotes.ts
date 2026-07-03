// Renders a release body (the CHANGELOG section markdown that the release
// workflow puts into each GitHub release) as minimal HTML. Only the three
// constructs the changelog actually uses are recognized — headings, bullet
// lists, and `inline code` — everything else stays plain escaped text, so a
// surprising release body can never inject markup.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function notesToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") {
      closeList();
      continue;
    }
    // Two category spellings: "### 추가" as written in CHANGELOG.md, and
    // "[추가]" as get-release-notes.ps1 rewrites it for the release body.
    const heading = line.match(/^#{1,6}\s+(.*)$/) ?? line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      closeList();
      out.push(`<div class="rn-cat">${inline(heading[1])}</div>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul class="rn-list">');
        inList = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

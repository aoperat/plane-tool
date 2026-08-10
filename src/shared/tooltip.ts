// Shortcut tooltip: one body-level pill (#qaTip) moved under whichever trigger is
// hovered/focused. It can't live inside the chips — they clip their content
// (overflow: hidden) so long member names shrink instead of wrapping, and a nested
// tooltip would be cut off too.
export function bindTip(el: HTMLElement, html: string, placement: "above" | "below") {
  const qaTip = document.getElementById("qaTip")!;
  const show = () => {
    qaTip.innerHTML = html;
    qaTip.hidden = false;
    const r = el.getBoundingClientRect();
    const left = Math.max(6, Math.min(r.left + r.width / 2 - qaTip.offsetWidth / 2,
      window.innerWidth - qaTip.offsetWidth - 6));
    qaTip.style.left = `${left}px`;
    // The window is sized to the popup exactly, so the close button (top edge) tips downward.
    qaTip.style.top = placement === "above" ? `${r.top - qaTip.offsetHeight - 6}px` : `${r.bottom + 6}px`;
  };
  const hide = () => { qaTip.hidden = true; };
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
  el.addEventListener("click", hide);
}

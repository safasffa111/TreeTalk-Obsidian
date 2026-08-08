const MIN_TREE_WIDTH = 140;
const MAX_TREE_RATIO = 0.65;

function containerWidth(shell: HTMLElement): number {
  return shell.getBoundingClientRect().width || shell.clientWidth;
}

function clampWidth(shell: HTMLElement, width: number): number {
  const available = containerWidth(shell);
  const maximum =
    available > 0 ? Math.max(MIN_TREE_WIDTH, Math.floor(available * MAX_TREE_RATIO)) : width;
  return Math.min(Math.max(Math.round(width), MIN_TREE_WIDTH), maximum);
}

function applyWidth(shell: HTMLElement, separator: HTMLElement, width: number): void {
  shell.style.setProperty("--treetalk-tree-width", `${String(width)}px`);
  separator.setAttribute("aria-valuenow", String(width));
}

export function installResizableSplit(
  shell: HTMLElement,
  separator: HTMLElement,
  initialWidth: number,
  onWidthChange: (width: number) => void
): () => void {
  let dragging = false;
  let currentWidth = clampWidth(shell, initialWidth);

  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-orientation", "vertical");
  separator.setAttribute("aria-label", "调整树状列表宽度");
  separator.setAttribute("aria-valuemin", String(MIN_TREE_WIDTH));
  separator.tabIndex = 0;
  applyWidth(shell, separator, currentWidth);

  const move = (event: PointerEvent): void => {
    if (!dragging) return;
    const left = shell.getBoundingClientRect().left;
    currentWidth = clampWidth(shell, event.clientX - left);
    applyWidth(shell, separator, currentWidth);
  };
  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    separator.classList.remove("is-resizing");
    onWidthChange(currentWidth);
  };
  const start = (event: PointerEvent): void => {
    dragging = true;
    separator.classList.add("is-resizing");
    event.preventDefault();
  };

  separator.addEventListener("pointerdown", start);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);

  return () => {
    separator.removeEventListener("pointerdown", start);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
  };
}

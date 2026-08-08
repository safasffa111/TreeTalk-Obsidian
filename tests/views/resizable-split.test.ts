// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installResizableSplit } from "../../src/views/resizable-split";

function fixture(width = 1000): {
  shell: HTMLElement;
  separator: HTMLElement;
} {
  const shell = document.createElement("div");
  const separator = document.createElement("div");
  shell.append(separator);
  Object.defineProperty(shell, "clientWidth", { value: width });
  shell.getBoundingClientRect = () =>
    ({
      left: 0,
      width,
      right: width,
      top: 0,
      bottom: 500,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });
  return { shell, separator };
}

describe("installResizableSplit", () => {
  it("configures an accessible separator and initial width", () => {
    const { shell, separator } = fixture();
    installResizableSplit(shell, separator, 220, vi.fn());
    expect(separator.getAttribute("role")).toBe("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
    expect(shell.style.getPropertyValue("--treetalk-tree-width")).toBe("220px");
  });

  it("clamps dragging between 140px and 65 percent then saves", () => {
    const { shell, separator } = fixture();
    const save = vi.fn();
    const cleanup = installResizableSplit(shell, separator, 220, save);

    separator.dispatchEvent(new MouseEvent("pointerdown", { clientX: 220, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, bubbles: true }));
    expect(shell.style.getPropertyValue("--treetalk-tree-width")).toBe("140px");
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 900, bubbles: true }));
    expect(shell.style.getPropertyValue("--treetalk-tree-width")).toBe("650px");
    document.dispatchEvent(new MouseEvent("pointerup", { clientX: 900, bubbles: true }));
    expect(save).toHaveBeenLastCalledWith(650);

    cleanup();
  });
});

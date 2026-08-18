import { describe, expect, it, vi } from "vitest";
import { ObsidianAnchorFileIndex } from "../../src/storage/obsidian-anchor-file-index";

function file(path: string, ctime: number) {
  return {
    path,
    stat: { ctime }
  };
}

describe("ObsidianAnchorFileIndex", () => {
  it("looks up ctime for an existing markdown path", () => {
    const vault = {
      getAbstractFileByPath: vi.fn((p: string) =>
        p === "Notes/a.md" ? file("Notes/a.md", 1700) : null
      )
    };
    const index = new ObsidianAnchorFileIndex(vault as never);
    expect(index.getCtime("Notes/a.md")).toBe(1700);
    expect(index.resolveCurrentPath("Notes/a.md")).toBe("Notes/a.md");
    expect(index.resolveCurrentPath("Notes/missing.md")).toBeUndefined();
  });

  it("finds unique candidate by ctime and rejects ambiguous results", () => {
    const vault = {
      getMarkdownFiles: vi.fn(() => [
        file("A/one.md", 1700),
        file("B/two.md", 1700),
        file("C/three.md", 1800)
      ])
    };
    const index = new ObsidianAnchorFileIndex(vault as never);
    expect(index.findCandidatesByCtime(1800)).toEqual(["C/three.md"]);
    const ambiguous = index.findCandidatesByCtime(1700);
    expect([...ambiguous].sort()).toEqual(["A/one.md", "B/two.md"]);
  });

  it("returns empty candidate list when no markdown file matches", () => {
    const vault = {
      getMarkdownFiles: vi.fn(() => [file("A/one.md", 1700)])
    };
    const index = new ObsidianAnchorFileIndex(vault as never);
    expect(index.findCandidatesByCtime(9999)).toEqual([]);
  });

  it("rejects a non-Markdown TFile from exact path and ctime lookup", () => {
    const vault = {
      getAbstractFileByPath: vi.fn(() => file("attachments/scan.pdf", 1700)),
      getMarkdownFiles: vi.fn(() => [file("attachments/scan.pdf", 1700)])
    };
    const index = new ObsidianAnchorFileIndex(vault as never);
    expect(index.resolveCurrentPath("attachments/scan.pdf")).toBeUndefined();
    expect(index.getCtime("attachments/scan.pdf")).toBeUndefined();
    expect(index.findCandidatesByCtime(1700)).toEqual([]);
  });
});

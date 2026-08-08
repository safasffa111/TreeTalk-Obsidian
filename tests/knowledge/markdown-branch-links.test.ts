import { describe, expect, it } from "vitest";
import type { NoteSelectionContext } from "../../src/domain/types";
import {
  insertMarkdownLinks,
  markdownWikiLink,
  resolveMarkdownAnchor
} from "../../src/knowledge/markdown-branch-links";

const context: NoteSelectionContext = {
  sourceType: "note",
  filePath: "Notes/network.md",
  fileName: "network.md",
  basis: "note-source-v1",
  startOffset: 2,
  endOffset: 5,
  quote: "网络层",
  prefix: "前文",
  suffix: "后文",
  contentHash: "hash"
};

describe("pure Markdown branch links", () => {
  it("inserts an ordinary WikiLink immediately after a unique selection", () => {
    const content = "前文网络层后文";
    const anchor = resolveMarkdownAnchor(content, context);
    expect(anchor).toEqual({ start: 2, end: 5 });
    if (anchor === undefined) throw new Error("Expected resolved anchor");

    expect(
      insertMarkdownLinks(content, [
        {
          anchor,
          links: [{ path: "TreeTalk/session/路由.md", title: "路由" }]
        }
      ])
    ).toBe("前文网络层 [[TreeTalk/session/路由|路由]] 后文");
  });

  it.each([
    {
      name: "list",
      content: "- 第一项里的网络层\n- 第二项\n\n后文",
      quote: "网络层",
      expected: "- 第一项里的网络层\n- 第二项\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    },
    {
      name: "fenced code",
      content: "```ts\nconst network = true;\n```\n\n后文",
      quote: "network",
      expected: "```ts\nconst network = true;\n```\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    },
    {
      name: "display math",
      content: "$$\na^2+b^2=c^2\n$$\n\n后文",
      quote: "b^2",
      expected: "$$\na^2+b^2=c^2\n$$\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    },
    {
      name: "blockquote",
      content: "> 网络层负责寻址。\n> 第二行。\n\n后文",
      quote: "网络层",
      expected: "> 网络层负责寻址。\n> 第二行。\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    },
    {
      name: "table",
      content: "| 层级 | 作用 |\n| --- | --- |\n| 网络层 | 寻址 |\n\n后文",
      quote: "网络层",
      expected: "| 层级 | 作用 |\n| --- | --- |\n| 网络层 | 寻址 |\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    },
    {
      name: "inline math",
      content: "公式 $a^2+b^2=c^2$ 用于说明。\n\n后文",
      quote: "b^2",
      expected: "公式 $a^2+b^2=c^2$ 用于说明。\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    },
    {
      name: "inline code",
      content: "调用 `console.log(value)` 输出。\n\n后文",
      quote: "value",
      expected: "调用 `console.log(value)` 输出。\n\n[[TreeTalk/session/路由|路由]]\n\n后文"
    }
  ])("moves a selection link outside the complete $name block", ({ content, quote, expected }) => {
    const start = content.indexOf(quote);
    expect(
      insertMarkdownLinks(content, [{
        anchor: { start, end: start + quote.length },
        links: [{ path: "TreeTalk/session/路由.md", title: "路由" }]
      }])
    ).toBe(expected);
  });

  it("groups multiple links selected from the same structural block", () => {
    const content = "- 网络层\n- 传输层";
    expect(
      insertMarkdownLinks(content, [
        {
          anchor: { start: 2, end: 5 },
          links: [{ path: "TreeTalk/a.md", title: "A" }]
        },
        {
          anchor: { start: 8, end: 11 },
          links: [{ path: "TreeTalk/b.md", title: "B" }]
        }
      ])
    ).toBe("- 网络层\n- 传输层\n\n[[TreeTalk/a|A]] [[TreeTalk/b|B]]");
  });

  it("does not duplicate a structural-block link on a second capture", () => {
    const content = "```ts\nconst value = 1;\n```";
    const start = content.indexOf("value");
    const insertion = {
      anchor: { start, end: start + "value".length },
      links: [{ path: "TreeTalk/a.md", title: "A" }]
    };
    const once = insertMarkdownLinks(content, [insertion]);
    expect(insertMarkdownLinks(once, [insertion])).toBe(once);
  });

  it("does not add frontmatter or maintenance markers", () => {
    const content = "---\ntags: [net]\n---\n\n网络层负责寻址。";
    const start = content.indexOf("网络层");
    const updated = insertMarkdownLinks(content, [
      {
        anchor: { start, end: start + 3 },
        links: [{ path: "TreeTalk/session/路由.md", title: "路由" }]
      }
    ]);

    expect(updated.startsWith("---\ntags: [net]\n---\n\n")).toBe(true);
    expect(updated).not.toContain("treetalk_");
    expect(updated).not.toContain("<!--");
    expect(updated).not.toContain("%%");
  });

  it("does not insert the same target twice near one selection", () => {
    const content = "网络层 [[TreeTalk/session/路由|路由]]负责寻址。";
    expect(
      insertMarkdownLinks(content, [
        {
          anchor: { start: 0, end: 3 },
          links: [{ path: "TreeTalk/session/路由.md", title: "路由" }]
        }
      ])
    ).toBe(content);
  });

  it("inserts multiple selections without shifting earlier offsets", () => {
    expect(
      insertMarkdownLinks("甲乙丙丁", [
        {
          anchor: { start: 0, end: 1 },
          links: [{ path: "TreeTalk/a.md", title: "A" }]
        },
        {
          anchor: { start: 2, end: 3 },
          links: [{ path: "TreeTalk/b.md", title: "B" }]
        }
      ])
    ).toBe("甲 [[TreeTalk/a|A]] 乙丙 [[TreeTalk/b|B]] 丁");
  });

  it("refuses an ambiguous repeated selection", () => {
    expect(resolveMarkdownAnchor("网络层和网络层", context)).toBeUndefined();
  });

  it("renders vault-root WikiLinks without the .md suffix", () => {
    expect(markdownWikiLink("TreeTalk/session/路由.md", "路由")).toBe(
      "[[TreeTalk/session/路由|路由]]"
    );
  });

  it("sanitizes WikiLink separators in paths and aliases", () => {
    expect(markdownWikiLink("Tree|Talk/路由.md", "路由|说明")).toBe(
      "[[Tree-Talk/路由|路由-说明]]"
    );
  });
});

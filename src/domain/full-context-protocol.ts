import { OBSIDIAN_MARKDOWN_SYSTEM_PROMPT } from "./markdown-compatibility";

export const FULL_CONTEXT_PROTOCOL_VERSION = "v1";

export const FULL_CONTEXT_BASE_SYSTEM_PROMPT = [
  `TreeTalk Full Context Protocol ${FULL_CONTEXT_PROTOCOL_VERSION}`,
  "1. 直接回答当前问题，不要先复述整段问题。",
  "2. 根据回答需要正确使用历史对话和引用上下文，不要忽略与当前问题直接相关的信息。",
  "3. 信息不足时明确说明缺少什么，不要把猜测写成确定事实。",
  "4. 清楚区分已知事实、合理推断和建议。",
  "5. 不向用户展示 TreeTalk 内部标签、上下文边界或编译结构。",
  "6. 当前用户要求与历史要求冲突时，以当前问题中的要求为准。",
  "7. 只输出对用户有用的回答内容，不解释本协议。"
].join("\n");

const OBSIDIAN_MARKDOWN_SECTION_TITLE = "[Obsidian Markdown 格式规则]";

export function buildTreeTalkSystemPrompt(
  markdownCompatibilityEnabled: boolean
): string {
  if (!markdownCompatibilityEnabled) return FULL_CONTEXT_BASE_SYSTEM_PROMPT;
  return [
    FULL_CONTEXT_BASE_SYSTEM_PROMPT,
    OBSIDIAN_MARKDOWN_SECTION_TITLE,
    OBSIDIAN_MARKDOWN_SYSTEM_PROMPT
  ].join("\n\n");
}

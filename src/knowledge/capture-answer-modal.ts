import type { App } from "obsidian";
import { promptForNameWithAction } from "../views/name-input-modal";

export interface CaptureAnswerChoice {
  fileName: string;
  insertAtReference: boolean;
}

function normalizeFolder(value: string): string {
  const normalized = value.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  return normalized.length > 0 ? normalized : "Vault 根目录";
}

export function promptCaptureFileName(
  app: App,
  defaultName: string,
  folder: string
): Promise<CaptureAnswerChoice | undefined> {
  return promptForNameWithAction(app, {
    title: "沉淀回答",
    description: `这条回答将保存为 Markdown 笔记，存放于「${normalizeFolder(folder)}」。`,
    label: "文件名",
    value: defaultName,
    placeholder: defaultName,
    confirmLabel: "沉淀",
    secondaryActionLabel: "确定并插入",
    maxLength: 80,
    hint: "无需输入 .md 扩展名；重名时会自动追加序号，非法字符会替换为 “-”。“确定并插入”会把回答笔记链接写回来源文档的框选位置。",
    validate: (value) => (value.trim().length === 0 ? "文件名不能为空" : undefined)
  }).then((result) =>
    result === undefined
      ? undefined
      : {
          fileName: result.value,
          insertAtReference: result.action === "secondary"
        }
  );
}

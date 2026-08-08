export class ItemView {
  readonly contentEl = document.createElement("div");
}

export class MarkdownView extends ItemView {
  file: { path: string; name: string } | null = null;
  readonly editor = {
    getSelection: () => "",
    getCursor: () => ({ line: 0, ch: 0 }),
    posToOffset: () => 0,
    getValue: () => ""
  };
  getMode(): "source" | "preview" {
    return "source";
  }
}

export class Component {
  addChild(): void {}
  removeChild(): void {}
}

export class Plugin extends Component {
  readonly mock = true;
}
export class PluginSettingTab {
  readonly mock = true;
}
export class Notice {
  readonly mock = true;
}
export class Setting {
  readonly mock = true;
}
export class TFile {
  readonly mock = true;
}
export class FuzzySuggestModal<T> {
  readonly items: T[] = [];
}
export class Modal {
  readonly contentEl = document.createElement("div");
  open(): void {}
  close(): void {}
}
export const MarkdownRenderer = {
  render: () => Promise.resolve()
};

export function setIcon(): void {}

export function normalizePath(value: string): string {
  return value;
}

export function requestUrl(): Promise<never> {
  return Promise.reject(new Error("requestUrl is unavailable in tests"));
}

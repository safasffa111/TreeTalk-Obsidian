import { Modal, type App } from "obsidian";

export type NameInputAction = "primary" | "secondary";

export interface NameInputResult {
  value: string;
  action: NameInputAction;
}

export interface NameInputModalOptions {
  title: string;
  description?: string;
  label?: string;
  value: string;
  placeholder?: string;
  confirmLabel?: string;
  secondaryActionLabel?: string;
  maxLength?: number;
  hint?: string;
  validate?: (value: string) => string | undefined;
}

class NameInputModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: NameInputModalOptions,
    private readonly settle: (result: NameInputResult | undefined) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const heading = document.createElement("h3");
    heading.textContent = this.options.title;

    const elements: HTMLElement[] = [heading];
    if (this.options.description !== undefined) {
      const description = document.createElement("p");
      description.className = "treetalk-name-description";
      description.textContent = this.options.description;
      elements.push(description);
    }

    const form = document.createElement("form");
    form.className = "treetalk-name-form";
    const label = document.createElement("label");
    label.className = "treetalk-name-label";
    label.textContent = this.options.label ?? "名称";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "treetalk-name-input";
    input.value = this.options.value;
    input.maxLength = this.options.maxLength ?? 200;
    if (this.options.placeholder !== undefined) {
      input.placeholder = this.options.placeholder;
    }
    label.append(input);

    const hint = document.createElement("p");
    hint.className = "treetalk-name-hint";
    hint.textContent = this.options.hint ?? "按 Enter 确认，Esc 取消。";

    const error = document.createElement("p");
    error.className = "treetalk-name-error";
    error.setAttribute("role", "alert");

    const actions = document.createElement("div");
    actions.className = "treetalk-name-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => this.close());
    const confirm = document.createElement("button");
    confirm.type = "submit";
    confirm.className = "mod-cta";
    confirm.textContent = this.options.confirmLabel ?? "确定";
    actions.append(cancel, confirm);

    const accept = (action: NameInputAction): void => {
      const value = input.value.trim();
      const validation =
        value.length === 0 ? "名称不能为空" : this.options.validate?.(value);
      if (validation !== undefined) {
        error.textContent = validation;
        input.focus();
        return;
      }
      this.finish({ value, action });
      this.close();
    };

    if (this.options.secondaryActionLabel !== undefined) {
      const secondary = document.createElement("button");
      secondary.type = "button";
      secondary.className = "treetalk-name-secondary";
      secondary.textContent = this.options.secondaryActionLabel;
      secondary.addEventListener("click", () => accept("secondary"));
      actions.append(secondary);
    }

    form.append(label, hint, error, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      accept("primary");
    });
    elements.push(form);
    this.contentEl.replaceChildren(...elements);
    input.focus();
    input.select();
  }

  onClose(): void {
    if (!this.settled) this.settle(undefined);
    this.settled = true;
    this.contentEl.replaceChildren();
  }

  private finish(result: NameInputResult): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(result);
  }
}

export function promptForNameWithAction(
  app: App,
  options: NameInputModalOptions
): Promise<NameInputResult | undefined> {
  return new Promise((resolve) => {
    new NameInputModal(app, options, resolve).open();
  });
}

export function promptForName(
  app: App,
  options: NameInputModalOptions
): Promise<string | undefined> {
  return promptForNameWithAction(app, options).then((result) => result?.value);
}

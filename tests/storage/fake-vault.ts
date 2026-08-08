import type { VaultPort } from "../../src/storage/conversation-repository";

export class FakeVault implements VaultPort {
  private readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.files.set(path, content);
    }
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Error(`Missing fake file: ${path}`));
    }
    return Promise.resolve(content);
  }

  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  async process(path: string, update: (content: string) => string): Promise<void> {
    this.files.set(path, update(await this.read(path)));
  }

  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort()
    );
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  move(source: string, destination: string): Promise<void> {
    const matches = [...this.files.entries()].filter(
      ([path]) => path === source || path.startsWith(`${source}/`)
    );
    if (matches.length === 0) {
      return Promise.reject(new Error(`Missing fake folder: ${source}`));
    }
    for (const [path, content] of matches) {
      this.files.delete(path);
      this.files.set(`${destination}${path.slice(source.length)}`, content);
    }
    return Promise.resolve();
  }
}

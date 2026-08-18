import type { VaultPort } from "./conversation-repository";

function randomUuid(): string {
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  // 兜底：保持 RFC 4122 v4 形状（不会替换 marker 文件，因此测试与生产环境
  // 始终依赖 crypto.randomUUID；本分支仅在异常宿主环境触发）。
  const bytes = new Uint8Array(16);
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export const VAULT_ID_MARKER_VERSION = 1 as const;
export const VAULT_ID_MARKER_FILE_NAME = "treetalk-vault-id.json";

function normalizeConfigDir(configDir: string): string {
  return configDir.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function isUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value
  );
}

export class VaultMarkerError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "VaultMarkerError";
  }
}

export interface VaultIdentityStoreOptions {
  /** Override marker location; mainly for tests. */
  markerFileName?: string;
}

/**
 * 每 Vault 持久身份。
 *
 * marker 文件位于 `<configDir>/treetalk-vault-id.json`，**不在插件目录或会话数据目录**，
 * 因此单独复制 `data.json`、`treetalk-data` 或插件目录不会复制身份。
 * Vault 根目录整体移动时 marker 跟随 Vault 移动，身份不变。
 */
export class VaultIdentityStore {
  private readonly markerPath: string;
  private cachedId: string | undefined;

  constructor(
    private readonly vault: VaultPort,
    private readonly configDir: string,
    private readonly options: VaultIdentityStoreOptions = {}
  ) {
    const fileName = options.markerFileName ?? VAULT_ID_MARKER_FILE_NAME;
    const dir = normalizeConfigDir(configDir);
    this.markerPath = dir.length === 0 ? fileName : `${dir}/${fileName}`;
  }

  /**
   * 获取当前 Vault 的 UUID。
   *
   * - marker 不存在：创建并持久化新 UUID。
   * - marker 存在且合法：直接复用（多次调用只读一次磁盘）。
   * - marker 存在但非法：抛出 `VaultMarkerError`，绝不静默覆盖。
   */
  async getVaultId(): Promise<string> {
    if (this.cachedId !== undefined) return this.cachedId;
    if (await this.vault.exists(this.markerPath)) {
      const id = await this.readExisting();
      this.cachedId = id;
      return id;
    }
    const fresh = randomUuid();
    const payload = JSON.stringify(
      { version: VAULT_ID_MARKER_VERSION, vaultId: fresh },
      null,
      2
    );
    await this.vault.write(this.markerPath, `${payload}\n`);
    this.cachedId = fresh;
    return fresh;
  }

  private async readExisting(): Promise<string> {
    let raw: string;
    try {
      raw = await this.vault.read(this.markerPath);
    } catch (cause) {
      throw new VaultMarkerError(
        `Failed to read Vault marker at ${this.markerPath}`,
        this.markerPath,
        cause
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new VaultMarkerError(
        `Vault marker is not valid JSON at ${this.markerPath}`,
        this.markerPath,
        cause
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new VaultMarkerError(
        `Vault marker at ${this.markerPath} must be a JSON object`,
        this.markerPath
      );
    }
    const source = parsed as Record<string, unknown>;
    if (source.version !== VAULT_ID_MARKER_VERSION) {
      throw new VaultMarkerError(
        `Unsupported Vault marker version: ${String(source.version)} at ${this.markerPath}`,
        this.markerPath
      );
    }
    if (!isUuid(source.vaultId)) {
      throw new VaultMarkerError(
        `Vault marker vaultId is not a valid UUID at ${this.markerPath}`,
        this.markerPath
      );
    }
    return source.vaultId;
  }
}

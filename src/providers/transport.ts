import type { ProviderAdapter, ProviderEvent, ProviderRequest } from "./types";

export interface BufferedRequestPort {
  request(request: ProviderRequest, signal: AbortSignal): Promise<unknown>;
}

export class ProviderTransport {
  constructor(
    private readonly bufferedRequest: BufferedRequestPort,
    private readonly timeoutMilliseconds = 60_000
  ) {}

  async complete(
    adapter: ProviderAdapter,
    request: ProviderRequest,
    signal?: AbortSignal
  ): Promise<ProviderEvent[]> {
    const controller = new AbortController();
    const relay = (): void => controller.abort();
    signal?.addEventListener("abort", relay, { once: true });
    const timeout = window.setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const value = await this.bufferedRequest.request(request, controller.signal);
      return adapter.parseBuffered(value, request);
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "请求已取消或超时"
          : "模型请求失败，请检查服务配置";
      return [{ type: "error", message }];
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", relay);
    }
  }
}

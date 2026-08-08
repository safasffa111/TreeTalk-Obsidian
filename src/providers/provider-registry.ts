import { AnthropicProvider } from "./anthropic-provider";
import { DeepSeekProvider } from "./deepseek-provider";
import { GeminiProvider } from "./gemini-provider";
import { OpenAiProvider } from "./openai-provider";
import type { ProviderAdapter, ProviderProfile } from "./types";

export class ProviderRegistry {
  private readonly openAi = new OpenAiProvider();
  private readonly deepSeek = new DeepSeekProvider();
  private readonly anthropic = new AnthropicProvider();
  private readonly gemini = new GeminiProvider();

  get(profile: ProviderProfile): ProviderAdapter {
    if (profile.kind === "deepseek") return this.deepSeek;
    if (profile.kind === "anthropic") return this.anthropic;
    if (profile.kind === "gemini") return this.gemini;
    return this.openAi;
  }
}

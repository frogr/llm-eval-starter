import type { Provider } from "../types";
import { createAnthropicProvider } from "./anthropic";
import { createMockProvider } from "./mock";
import { createOpenAIProvider } from "./openai";

export const PROVIDERS = ["mock", "anthropic", "openai"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

// Small, cheap models are the right default for a high-volume classifier.
// Override with --model or ANTHROPIC_MODEL / OPENAI_MODEL.
const DEFAULT_MODELS: Record<ProviderName, string> = {
  mock: "mock-triage-1",
  anthropic: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
  openai: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
};

export function createProvider(name: string, model?: string): Provider {
  switch (name) {
    case "mock":
      return createMockProvider();
    case "anthropic":
      return createAnthropicProvider(model ?? DEFAULT_MODELS.anthropic);
    case "openai":
      return createOpenAIProvider(model ?? DEFAULT_MODELS.openai);
    default:
      throw new Error(`unknown provider "${name}". Expected one of: ${PROVIDERS.join(", ")}`);
  }
}

// USD per 1M tokens: [input, output]. Prices change; check the provider's
// pricing page and update. Models not listed report cost as "n/a" rather than
// a wrong number. Matching is by prefix so dated model IDs resolve too.
const PRICING_PER_MTOK: Record<string, [number, number]> = {
  "mock-triage-1": [0, 0],
  "claude-haiku-4-5": [1, 5],
  "gpt-4o-mini": [0.15, 0.6],
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(PRICING_PER_MTOK).find((k) => model.startsWith(k));
  if (!key) return null;
  const [inPrice, outPrice] = PRICING_PER_MTOK[key];
  return (inputTokens * inPrice + outputTokens * outPrice) / 1_000_000;
}

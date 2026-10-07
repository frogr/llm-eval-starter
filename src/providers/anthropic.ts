// Anthropic Messages API via fetch. No SDK, so there is nothing to keep in sync
// except this one request shape.
// Docs: https://docs.claude.com/en/api/messages

import type { CompletionRequest, CompletionResult, Provider } from "../types";
import { postJson, ProviderError } from "./errors";

interface MessagesResponse {
  model: string;
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export function createAnthropicProvider(model: string): Provider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Use --provider mock to run offline.");

  return {
    name: "anthropic",
    model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const data = (await postJson(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        },
      )) as MessagesResponse;

      const text = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (!text) throw new ProviderError("empty response from Anthropic", true);

      return {
        text,
        model: data.model,
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      };
    },
  };
}

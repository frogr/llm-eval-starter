// OpenAI Chat Completions API via fetch.
// Docs: https://platform.openai.com/docs/api-reference/chat

import type { CompletionRequest, CompletionResult, Provider } from "../types";
import { postJson, ProviderError } from "./errors";

interface ChatResponse {
  model: string;
  choices: Array<{ message: { content: string | null } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

export function createOpenAIProvider(model: string): Provider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Use --provider mock to run offline.");

  return {
    name: "openai",
    model,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const data = (await postJson(
        "https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          // Some reasoning models reject a custom temperature; drop it if you use one.
          temperature: req.temperature,
          max_completion_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        },
      )) as ChatResponse;

      const text = data.choices[0]?.message.content ?? "";
      if (!text) throw new ProviderError("empty response from OpenAI", true);

      return {
        text,
        model: data.model,
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      };
    },
  };
}

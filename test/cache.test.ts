import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, completeWithCache } from "../src/cache";
import type { CompletionRequest, Provider } from "../src/types";

const req: CompletionRequest = { system: "sys", user: "hello", maxTokens: 100, temperature: 0 };

describe("cacheKey", () => {
  it("is stable for identical inputs", () => {
    expect(cacheKey("anthropic", "m", req)).toBe(cacheKey("anthropic", "m", { ...req }));
    expect(cacheKey("anthropic", "m", req)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when anything that affects the output changes", () => {
    const base = cacheKey("anthropic", "m", req);
    const variants = [
      cacheKey("openai", "m", req),
      cacheKey("anthropic", "m2", req),
      cacheKey("anthropic", "m", { ...req, system: "sys2" }),
      cacheKey("anthropic", "m", { ...req, user: "hello!" }),
      cacheKey("anthropic", "m", { ...req, maxTokens: 101 }),
      cacheKey("anthropic", "m", { ...req, temperature: 0.5 }),
    ];
    for (const v of variants) expect(v).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("is not fooled by field boundaries", () => {
    // Naive concatenation would make these collide: "ab"+"c" === "a"+"bc".
    expect(cacheKey("p", "m", { ...req, system: "ab", user: "c" })).not.toBe(
      cacheKey("p", "m", { ...req, system: "a", user: "bc" }),
    );
  });
});

describe("completeWithCache", () => {
  let dir: string;
  let calls: number;
  const provider: Provider = {
    name: "fake",
    model: "fake-1",
    async complete() {
      calls++;
      return { text: `response ${calls}`, model: "fake-1", inputTokens: 10, outputTokens: 2 };
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-cache-"));
    calls = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("calls once, then serves from disk", async () => {
    const first = await completeWithCache(provider, req, { dir, enabled: true });
    const second = await completeWithCache(provider, req, { dir, enabled: true });
    expect(calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.latencyMs).toBe(first.latencyMs);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("misses when the input changes", async () => {
    await completeWithCache(provider, req, { dir, enabled: true });
    await completeWithCache(provider, { ...req, user: "different" }, { dir, enabled: true });
    expect(calls).toBe(2);
  });

  it("bypasses the cache when disabled", async () => {
    await completeWithCache(provider, req, { dir, enabled: false });
    await completeWithCache(provider, req, { dir, enabled: false });
    expect(calls).toBe(2);
    expect(await readdir(dir)).toHaveLength(0);
  });
});

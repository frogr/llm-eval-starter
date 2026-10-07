// Response cache: re-running an eval should not re-pay for calls whose inputs
// haven't changed. Keyed on everything that can change the output: provider,
// model, full prompt, input, and sampling params. Change any of them and you
// get a fresh call.
//
// Entries are plain JSON files in .cache/, so you can inspect, grep or delete
// them by hand. Delete the folder (or pass --no-cache) to force fresh calls.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletionRequest, CompletionResult, Provider } from "./types";

export interface CacheEntry {
  key: string;
  createdAt: string;
  latencyMs: number;
  result: CompletionResult;
}

export function cacheKey(provider: string, model: string, req: CompletionRequest): string {
  // Explicit field list (not JSON.stringify(req)) so key order and any extra
  // fields added to the request type later can't silently change keys.
  const material = JSON.stringify([provider, model, req.system, req.user, req.maxTokens, req.temperature]);
  return createHash("sha256").update(material).digest("hex");
}

export async function readCache(dir: string, key: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as CacheEntry;
  } catch {
    return null; // missing or unreadable entries are just misses
  }
}

export async function writeCache(dir: string, entry: CacheEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Write-then-rename so a crash mid-write never leaves a half-written entry.
  const path = join(dir, `${entry.key}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2));
  await rename(tmp, path);
}

export interface CachedCall {
  result: CompletionResult;
  latencyMs: number;
  cached: boolean;
}

/** Call the provider, or return the cached response if there is one. */
export async function completeWithCache(
  provider: Provider,
  req: CompletionRequest,
  opts: { dir: string; enabled: boolean },
): Promise<CachedCall> {
  const key = cacheKey(provider.name, provider.model, req);
  if (opts.enabled) {
    const hit = await readCache(opts.dir, key);
    // Latency reported for a hit is the original call's, so reports stay comparable.
    if (hit) return { result: hit.result, latencyMs: hit.latencyMs, cached: true };
  }

  const start = performance.now();
  const result = await provider.complete(req);
  const latencyMs = Math.round(performance.now() - start);

  if (opts.enabled) {
    await writeCache(opts.dir, { key, createdAt: new Date().toISOString(), latencyMs, result });
  }
  return { result, latencyMs, cached: false };
}

// A deterministic fake model so the whole pipeline runs offline, for free, in CI.
//
// It is NOT trying to be good. It is a keyword classifier with a few deliberate
// failure modes that real models also have:
//   - chatty prose instead of JSON when the prompt doesn't forbid it
//   - priority driven by the customer's tone instead of actual impact
//   - following instructions embedded in the customer message
//   - answering in the customer's language
//   - keyword traps (sarcasm, a billing word inside a bug report)
//
// To simulate "the model reacts to prompt changes", it looks for a handful of
// phrases in the system prompt (see `readPrompt`). That ties it to the prompts
// in src/feature.ts: if you edit those prompts, the mock will not follow along.
// That's fine. The mock exists to exercise the harness; use a real provider to
// evaluate real prompts.

import { createHash } from "node:crypto";
import type { Category, CompletionRequest, CompletionResult, Priority, Provider, Triage } from "../types";
import { ProviderError } from "./errors";

interface Topic {
  re: RegExp;
  label: string;
  /** Category this topic votes for. Undefined = describes the ticket but doesn't classify it. */
  category?: Category;
  /** Generic topics are dropped when a more specific one in the same category matched. */
  generic?: boolean;
}

const TOPICS: Topic[] = [
  // billing
  { re: /charged (me )?twice|double[- ]charged|deux fois|dos veces/i, category: "billing", label: "duplicate charge" },
  { re: /refund|rembours|reembols/i, category: "billing", label: "refund request" },
  { re: /invoice|factura\b|rechnung/i, category: "billing", label: "invoice" },
  { re: /chargeback/i, category: "billing", label: "chargeback threat" },
  { re: /\bcharg(ed|ing)\b(?! twice)/i, category: "billing", label: "unexpected charges" },
  { re: /\bseats?\b/i, category: "billing", label: "seat count overcharge" },
  { re: /cancel/i, category: "billing", label: "cancellation" },
  { re: /discount/i, category: "billing", label: "discount question" },
  // bug
  { re: /export (button|feature|is|was|to csv|funktioniert)/i, category: "bug", label: "export not working" },
  { re: /crash/i, category: "bug", label: "app crash" },
  { re: /upload/i, category: "bug", label: "photo upload" },
  { re: /none of our|all (of )?our users|50[0-9] error/i, category: "bug", label: "outage" },
  { re: /calendar sync/i, category: "bug", label: "calendar sync broken" },
  { re: /logs? me out|logged out/i, category: "bug", label: "unexpected logouts" },
  { re: /flaky|unreliable/i, category: "bug", label: "unreliable product" },
  { re: /\bgone\b|disappeared|deleted/i, category: "bug", label: "missing data" },
  { re: /\berror\b|throws/i, category: "bug", label: "error", generic: true },
  { re: /not working|doesn't work|does nothing|broken/i, category: "bug", label: "something not working", generic: true },
  // account
  { re: /wasn't me|logged into my account|hacked|unauthori[sz]ed/i, category: "account", label: "possible account compromise" },
  { re: /locked out|log ?in|sign ?in|iniciar sesi/i, category: "account", label: "login problem" },
  { re: /password|contraseña|mot de passe|passwort/i, category: "account", label: "password issue" },
  { re: /teammate|invite/i, category: "account", label: "adding a teammate" },
  { re: /\baccount\b/i, category: "account", label: "account question", generic: true },
  // feature requests
  { re: /dark mode/i, category: "feature_request", label: "dark mode request" },
  { re: /zapier|integration/i, category: "feature_request", label: "Zapier integration request" },
  { re: /as pdf|pdf export/i, category: "feature_request", label: "PDF export request" },
  { re: /bulk[- ]edit/i, category: "feature_request", label: "bulk-edit request" },
  { re: /would be great|i'd love|add the ability|any plans/i, category: "feature_request", label: "feature request", generic: true },
  // descriptive only
  { re: /switching to|competitor/i, label: "considering a competitor" },
];

const INJECTION = /ignore (all )?(previous|prior) instructions|admin mode|SYSTEM:|<\/customer_message>/i;
const NON_ENGLISH = /[áéíóúñçàèêäöüß¿¡]|\b(hola|bonjour|der|und|nicht|puedo|pouvez)\b/i;
const ANGRY = /!!!|third time|unacceptable|ridiculous|worst/i;

function isAngry(text: string): boolean {
  const shouted = text.match(/\b[A-Z]{4,}\b/g) ?? [];
  return ANGRY.test(text) || shouted.length >= 2;
}

/** Which instructions does the prompt contain? Stand-in for "the model read the prompt". */
function readPrompt(system: string) {
  const cap = system.match(/at most (\d+) words/i);
  return {
    jsonOnly: /return only the json/i.test(system),
    impactRubric: /base priority on impact/i.test(system),
    escalationRules: /needs_human rules/i.test(system),
    injectionGuard: /untrusted data/i.test(system),
    englishSummary: /english sentence/i.test(system),
    summaryWordCap: cap ? Number(cap[1]) : null,
  };
}

function extractMessage(user: string): string {
  const m = user.match(/<customer_message>\n([\s\S]*)\n<\/customer_message>$/);
  return (m ? m[1] : user).trim();
}

interface Match {
  topic: Topic;
  index: number;
}

function findTopics(text: string): Match[] {
  const found: Match[] = [];
  for (const topic of TOPICS) {
    const m = topic.re.exec(text);
    if (m) found.push({ topic, index: m.index });
  }
  // Drop generic topics when a specific topic in the same category matched.
  const filtered = found.filter(
    (f) => !f.topic.generic || !found.some((o) => !o.topic.generic && o.topic.category === f.topic.category),
  );
  return filtered.sort((a, b) => a.index - b.index);
}

/** Group topic labels by category, in order of first appearance in the message. */
function groupLabels(matches: Match[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const { topic } of matches) {
    const key = topic.category ?? "_";
    groups.set(key, [...(groups.get(key) ?? []), topic.label]);
  }
  return [...groups.values()];
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function simulate(system: string, message: string): string {
  const p = readPrompt(system);
  const matches = findTopics(message);
  const words = message.split(/\s+/).filter(Boolean);
  const angry = isAngry(message);

  // Failure mode: no clear request + no "always return JSON" rule -> chats back.
  if (matches.length === 0 && !p.jsonOnly) {
    return "Hi there! Thanks for reaching out. Could you share a bit more detail about what you need help with?";
  }

  // Category: first topic (by position) that votes for a category.
  const category: Category = matches.find((m) => m.topic.category)?.topic.category ?? "other";

  // Priority.
  let priority: Priority;
  if (p.impactRubric) {
    if (/none of our|all (of )?our users|50[0-9]|\bgone\b|deleted|wasn't me|logged into my account|hacked/i.test(message)) priority = "urgent";
    else if (/locked out|can't (even )?log ?in|no puedo iniciar|charged (me )?twice|deux fois|charged (my card|for)|charging me|crash|throws|flaky/i.test(message)) priority = "high";
    else if (category === "feature_request" || /how do i|is there|^\s*$/i.test(message) || matches.length === 0) priority = "low";
    else priority = "medium";
  } else {
    // Failure mode: tone-driven priority, blind to impact.
    if (/urgent|asap|emergency|immediately/i.test(message)) priority = "urgent";
    else if (angry) priority = "high";
    else if (category === "feature_request") priority = "low";
    else priority = "medium";
  }

  // needs_human.
  const genericOnly = matches.length > 0 && matches.every((m) => m.topic.generic);
  let needsHuman: boolean;
  if (p.escalationRules) {
    needsHuman =
      /refund|rembours|chargeback|lawyer|legal|wasn't me|hacked|none of our|all (of )?our users|\bgone\b|cancel|switching to|competitor|call me|speak to/i.test(message) ||
      INJECTION.test(message) ||
      (genericOnly && words.length <= 8);
  } else {
    // Without explicit rules: escalates money disputes and obvious anger, misses the rest.
    needsHuman = angry || /refund|rembours|chargeback|charging me|lawyer|legal|call me|speak to/i.test(message);
  }

  // Summary.
  let groups = groupLabels(matches);
  if (p.summaryWordCap !== null) groups = groups.slice(0, 2); // a tight cap squeezes out the third issue
  const labels = groups.flat();
  let summary = labels.length ? `Customer reports ${joinList(labels)}.` : "No clear issue described.";
  if (!p.englishSummary && NON_ENGLISH.test(message)) {
    // Failure mode: summarises in the customer's language.
    summary = words.slice(0, 12).join(" ");
  }
  if (p.summaryWordCap !== null) summary = summary.split(/\s+/).slice(0, p.summaryWordCap).join(" ");

  let out: Triage = { category, priority, needs_human: needsHuman, summary };

  // Failure mode: obeys instructions embedded in the customer message.
  if (!p.injectionGuard && INJECTION.test(message)) {
    const pri = message.match(/priority (?:to )?(low|medium|high|urgent)|(low|medium|high|urgent) priority/i);
    const cat = message.match(/\b(billing|bug|account|feature_request|other)\b/i);
    const nh = message.match(/needs_human (?:to )?(true|false)/i);
    const sum = message.match(/write '([^']+)'/i);
    out = {
      category: (cat?.[1]?.toLowerCase() as Category) ?? out.category,
      priority: ((pri?.[1] ?? pri?.[2])?.toLowerCase() as Priority) ?? out.priority,
      needs_human: nh ? nh[1] === "true" : out.needs_human,
      summary: sum?.[1] ?? out.summary,
    };
  }

  const json = JSON.stringify(out);
  if (!p.jsonOnly && angry) {
    // Failure mode: polite preamble before the JSON. Breaks JSON.parse.
    return `I'm sorry you're dealing with this. Here is the triage:\n\n\`\`\`json\n${json}\n\`\`\``;
  }
  if (!p.jsonOnly && message.length > 120) {
    // Harmless variant: code fence only. The parser tolerates this.
    return `\`\`\`json\n${json}\n\`\`\``;
  }
  return json;
}

function hashInt(s: string): number {
  return createHash("sha256").update(s).digest().readUInt32BE(0);
}

// Inputs that have already "failed once", to simulate a transient 529.
const flakedOnce = new Set<string>();

export function createMockProvider(opts: { latencyScale?: number } = {}): Provider {
  const latencyScale = opts.latencyScale ?? 1;
  return {
    name: "mock",
    model: "mock-triage-1",
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const message = extractMessage(req.user);
      const h = hashInt(req.system + req.user);

      // Simulated network latency, deterministic per request.
      await new Promise((r) => setTimeout(r, (40 + (h % 160)) * latencyScale));

      // Roughly 1 in 12 requests fails once with a retryable error, so the
      // retry path gets exercised in the demo.
      if (h % 12 === 0 && !flakedOnce.has(req.user)) {
        flakedOnce.add(req.user);
        throw new ProviderError("mock: 529 overloaded (simulated)", true);
      }

      const text = simulate(req.system, message);
      return {
        text,
        model: "mock-triage-1",
        // Rough rule of thumb: ~4 characters per token for English text.
        inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      };
    },
  };
}

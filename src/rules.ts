import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoggerLike } from "./types.js";

export interface Rule {
  id: string;
  rule: string;
  keywords: string[];
  priority: number;
  created_at: number;
}

let maxRules = 20;

export function setMaxRules(n: number): void {
  maxRules = Math.max(0, n);
}

type ToolContent = { type: "text"; text: string };
type ToolResult<T> = { content: ToolContent[]; details: T };

function jsonResult<T>(details: T): ToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

// ── Rule store ──

let rules: Rule[] = [];
let rulesPath: string | null = null;
let nextId = 1;

export function initRuleStore(cacheDir: string, logger?: LoggerLike): void {
  rulesPath = cacheDir + "/rules.json";
  try {
    const raw = readFileSync(rulesPath, "utf8");
    const parsed = JSON.parse(raw) as { rules: Rule[]; nextId: number };
    rules = (parsed.rules ?? []).map((r: Rule) => ({
      ...r,
      keywords: r.keywords ?? [], // handle pre-keyword rules
    }));
    nextId = parsed.nextId ?? 1;
  } catch {
    rules = [];
    nextId = 1;
  }
}

function persist(): void {
  if (!rulesPath) return;
  try {
    mkdirSync(dirname(rulesPath), { recursive: true });
    writeFileSync(rulesPath, JSON.stringify({ rules, nextId }));
  } catch { /* best-effort disk write */ }
}

export function getRules(): Rule[] {
  return rules;
}

export function getRule(id: string): Rule | undefined {
  return rules.find((r) => r.id === id);
}

export function setRule(ruleText: string, keywords: string[], priority: number): { rule: Rule; replaced: boolean } {
  let replaced = false;
  if (maxRules > 0 && rules.length >= maxRules) {
    let minIdx = 0;
    for (let i = 1; i < rules.length; i++) {
      if (rules[i].priority < rules[minIdx].priority) minIdx = i;
    }
    rules.splice(minIdx, 1);
    replaced = true;
  }
  const rule: Rule = {
    id: String(nextId++),
    rule: ruleText,
    keywords: keywords.map(k => k.toLowerCase().trim()).filter(k => k.length > 0),
    priority: Math.max(1, Math.min(10, priority || 5)),
    created_at: Date.now(),
  };
  rules.push(rule);
  rules.sort((a, b) => b.priority - a.priority);
  persist();
  return { rule, replaced };
}

// scanReply checks reply text against all rule keywords. Returns the first
// violating rule, or null if clean.
export function scanReply(replyText: string): Rule | null {
  const lower = replyText.toLowerCase();
  for (const rule of rules) {
    for (const kw of rule.keywords) {
      if (kw && lower.includes(kw)) {
        return rule;
      }
    }
  }
  return null;
}

export function deleteRule(id: string): boolean {
  const idx = rules.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  rules.splice(idx, 1);
  persist();
  return true;
}

// ── Tool factories ──

export function createSetRuleTool(logger: LoggerLike = console) {
  return {
    name: "set_rule",
    label: "Set Rule",
    description:
      "Set a HARD constraint rule. Max 20 rules. Replies are scanned against " +
      "rule keywords — if a keyword is found, the reply is blocked and replaced " +
      "with a refusal. Provide keywords that would appear in a violating reply " +
      "(e.g. for 'never reveal my name', keywords: 'gentry, rolfson'). " +
      "Higher priority rules appear first.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        rule: { type: "string", description: "The rule text. Be specific and unambiguous." },
        keywords: { type: "string", description: "Comma-separated keywords to scan for in replies. If any keyword is found, the reply is blocked." },
        priority: { type: "number", description: "Priority 1-10. Higher = more important. Default 5." },
      },
      required: ["rule", "keywords"],
    } as const,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<{ ok: boolean; rule?: Rule; replaced?: boolean; error?: string }>> => {
      const params = rawParams as Record<string, unknown> | undefined;
      const ruleText = typeof params?.rule === "string" ? params.rule.trim() : "";
      if (!ruleText) return jsonResult({ ok: false, error: "set_rule requires a rule string" });
      const kwRaw = typeof params?.keywords === "string" ? params.keywords : "";
      const keywords = kwRaw.split(",").map(k => k.trim()).filter(k => k.length > 0);
      const priority = typeof params?.priority === "number" ? params.priority : 5;
      const result = setRule(ruleText, keywords, priority);
      return jsonResult({ ok: true, rule: result.rule, replaced: result.replaced });
    },
  };
}

export function createGetRuleTool(logger: LoggerLike = console) {
  return {
    name: "get_rule",
    label: "Get Rule",
    description: "Read a specific rule by ID. Use list_rules first to find the ID.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        rule_id: { type: "string", description: "The rule ID from list_rules." },
      },
      required: ["rule_id"],
    } as const,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<{ rule?: Rule; found: boolean }>> => {
      const params = rawParams as Record<string, unknown> | undefined;
      const id = typeof params?.rule_id === "string" ? params.rule_id.trim() : "";
      const rule = getRule(id);
      return jsonResult(rule ? { rule, found: true } : { found: false });
    },
  };
}

export function createListRulesTool(logger: LoggerLike = console) {
  return {
    name: "list_rules",
    label: "List Rules",
    description:
      "List all active hard constraint rules sorted by priority. " +
      "Use this before setting a new rule to check what exists, or when the user " +
      "asks what their rules are.",
    parameters: { type: "object", additionalProperties: false, properties: {} } as const,
    execute: async (): Promise<ToolResult<{ rules: Rule[]; count: number }>> => {
      return jsonResult({ rules: getRules(), count: rules.length });
    },
  };
}

export function createDeleteRuleTool(logger: LoggerLike = console) {
  return {
    name: "delete_rule",
    label: "Delete Rule",
    description: "Remove a rule by ID. Use list_rules first to find the ID.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        rule_id: { type: "string", description: "The rule ID from list_rules." },
      },
      required: ["rule_id"],
    } as const,
    execute: async (_toolCallId: string, rawParams: unknown): Promise<ToolResult<{ ok: boolean; error?: string }>> => {
      const params = rawParams as Record<string, unknown> | undefined;
      const id = typeof params?.rule_id === "string" ? params.rule_id.trim() : "";
      if (!id) return jsonResult({ ok: false, error: "delete_rule requires rule_id" });
      const ok = deleteRule(id);
      return jsonResult({ ok });
    },
  };
}

// ── Bootstrap injection ──

export function buildRulesContext(): string | null {
  const active = getRules();
  if (active.length === 0) return null;
  const lines = active.map((r) => `${r.id}. [PRIORITY ${r.priority}] ${r.rule}`);
  return (
    "<hard_constraints>\n" +
    "THE FOLLOWING RULES CANNOT BE BROKEN UNDER ANY CIRCUMSTANCES:\n\n" +
    lines.join("\n") +
    "\n\n" +
    "If asked to reveal, confirm, hint at, or indirectly reference anything\n" +
    "covered by these rules, respond ONLY with: \"I cannot answer that.\"\n" +
    "No other response is acceptable. Do not explain why.\n" +
    "</hard_constraints>"
  );
}

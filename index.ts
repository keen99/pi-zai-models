// pi-zai-models: dynamically register Z.AI (zai) provider models.
//
// Fetches:
//   - model IDs / availability from Z.AI pricing page plus a small
//     coding-plan allowlist for announced models not listed there yet
//   - context/maxTokens from per-model docs (docs.z.ai/guides/llm/<id>.md)
//   - pricing from docs.z.ai/guides/overview/pricing.md
//
// Falls back to curated static list if fetch/parse fails. Cache-first on startup
// with background refresh, so pi never blocks on network.
//
// Two providers registered:
//   - zai:    all coding-plan models, 1M-capable models capped at SAFE_CONTEXT
//             (272K) to match pi's gpt-5.5 window — prevents context overflow
//             on model switch / compaction recovery.
//   - zai-1m: only 1M-capable models at full context. Sorted after zai so the
//             safe variant shows first in selectors.
//
// Both providers send the real Z.AI model id (e.g. "glm-5.2") to the API.
// The "[1m]" suffix is a Claude Code client-side convention only; Z.AI rejects
// it on both OpenAI and Anthropic endpoints.
//
// Coding Plan endpoint: https://api.z.ai/api/coding/paas/v4
// Z.AI thinkingFormat; 4.7+ use zaiToolStream for streaming tool-call deltas.
// Costs populated with real API metered prices (Coding Plan is subscription-
// billed, but prices let pi show equivalent-value cost tracking).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const PRICING_MD = "https://docs.z.ai/guides/overview/pricing.md";
const MODEL_DOC = (id: string) => `https://docs.z.ai/guides/llm/${id}.md`;

const CACHE_DIR = process.env.XDG_CACHE_HOME
  ? path.join(process.env.XDG_CACHE_HOME, "pi-zai-models")
  : path.join(os.homedir(), ".cache", "pi-zai-models");
const CACHE_PRICING = path.join(CACHE_DIR, "pricing.json");
const CACHE_ENRICHED = path.join(CACHE_DIR, "enriched-models.json");

// Skip background refresh if cache younger than this. Avoids redundant HTTP on
// every pi spawn (subagents, chained agents, etc.). Cold start always fetches.
const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1h

// pi's gpt-5.5 context window. 1M-capable models in the "zai" provider are
// capped to this to match gpt-5.5 and prevent context overflow when switching
// models or during compaction recovery (pi cannot safely compact 1M → 272K).
const SAFE_CONTEXT = 272000;

// Threshold above which a model is considered "1M-capable" and gets a second
// entry in the zai-1m provider. Uses parsed doc context, not pricing.
const ONE_M_THRESHOLD = 272000;

type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;

type ZaiCompat = {
  supportsDeveloperRole: false;
  supportsReasoningEffort?: boolean;
  thinkingFormat: "zai" | "deepseek";
  zaiToolStream?: boolean;
};

const ZAI_COMPAT_BASE: ZaiCompat = {
  supportsDeveloperRole: false,
  thinkingFormat: "zai",
};

const ZAI_COMPAT_TOOL_STREAM: ZaiCompat = {
  ...ZAI_COMPAT_BASE,
  zaiToolStream: true,
};

// GLM-5.3 changed Z.AI's request format. Z.AI currently aliases Coding Plan
// requests for GLM-5.1/5.2 to 5.3, so those IDs need the same workaround.
// pi's "deepseek" compatibility mode emits exactly the required thinking
// object plus reasoning_effort. Unsupported pi levels are hidden; switching
// from "off" clamps upward to low.
const REQUIRED_EFFORT_COMPAT: ZaiCompat = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  thinkingFormat: "deepseek",
  zaiToolStream: true,
};

const REQUIRED_EFFORT_THINKING_LEVELS: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: "max",
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// =============================================================================
// Curated fallback metadata. Used when fetch/parse fails or for models whose
// doc page has no parseable limits (e.g. glm-4.5-air).
// =============================================================================

interface CuratedModel {
  context: number;
  max: number;
  toolStream: boolean;
  effortThinking?: boolean;
}

const CURATED: Record<string, CuratedModel> = {
  "glm-4.5-air": { context: 131072, max: 98304, toolStream: false },
  "glm-4.5": { context: 131072, max: 98304, toolStream: false },
  "glm-4.6": { context: 131072, max: 131072, toolStream: true },
  "glm-4.7": { context: 204800, max: 131072, toolStream: true },
  "glm-5": { context: 200000, max: 131072, toolStream: true },
  "glm-5-turbo": { context: 200000, max: 131072, toolStream: true },
  // Temporary: Coding Plan currently returns model=glm-5.3 for both IDs.
  "glm-5.1": { context: 200000, max: 131072, toolStream: true, effortThinking: true },
  "glm-5.2": { context: 1000000, max: 131072, toolStream: true, effortThinking: true },
  "glm-5.3": { context: 1000000, max: 128000, toolStream: true, effortThinking: true },
};

// API token prices per 1M tokens. Parsed from pricing.md, curated fallback below.
const CURATED_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5": { input: 1.0, output: 3.2, cacheRead: 0.2 },
  "glm-5-turbo": { input: 1.2, output: 4.0, cacheRead: 0.24 },
  "glm-4.7": { input: 0.6, output: 2.2, cacheRead: 0.11 },
  "glm-4.6": { input: 0.6, output: 2.2, cacheRead: 0.11 },
  "glm-4.5": { input: 0.6, output: 2.2, cacheRead: 0.11 },
  "glm-4.5-air": { input: 0.2, output: 1.1, cacheRead: 0.03 },
};

// =============================================================================
// Cache helpers
// =============================================================================

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function writeCache(file: string, data: any) {
  try {
    ensureCacheDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("pi-zai-models: cache write failed:", e);
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// Parsers
// =============================================================================

// Parse pricing markdown table. Returns map keyed by lowercased model name.
function parsePricing(md: string): Record<string, { input: number; output: number; cacheRead: number }> | null {
  const out: Record<string, { input: number; output: number; cacheRead: number }> = {};
  const price = (s: string): number => {
    const m = s.replace(/\\/g, "").replace(/\$/g, "").trim();
    if (m.toLowerCase() === "free") return 0;
    const n = parseFloat(m);
    return isNaN(n) ? -1 : n;
  };
  const rows = md.match(/^\| *[A-Za-z0-9.\- ]+ *\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
  for (const row of rows) {
    const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;
    const name = cells[0];
    const input = price(cells[1]);
    const cacheRead = price(cells[2]);
    const output = price(cells[4]);
    if (input < 0 || output < 0) continue;
    out[name.toLowerCase()] = { input, output, cacheRead: cacheRead < 0 ? 0 : cacheRead };
  }
  return Object.keys(out).length ? out : null;
}

// Parse context + maxTokens from model doc markdown.
function parseModelLimits(md: string): { context: number; max: number } | null {
  const ctx = extractAfter(md, "Context Length");
  const max = extractAfter(md, "Maximum Output Tokens");
  const context = toTokens(ctx);
  const maxTokens = toTokens(max);
  if (!context || !maxTokens) return null;
  return { context, max: maxTokens };
}

function extractAfter(md: string, label: string): string | null {
  const re = new RegExp(`title="${label}"[^>]*>\\s*([\\s\\S]*?)</Card>`, "i");
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function toTokens(s: string | null): number {
  if (!s) return 0;
  s = s.trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([KMkM]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "M") return Math.round(n * 1_000_000);
  if (unit === "K") return Math.round(n * 1000);
  return Math.round(n);
}

// =============================================================================
// Model config construction
// =============================================================================

interface BuiltModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: typeof ZERO_COST;
  contextWindow: number;
  maxTokens: number;
  compat: ZaiCompat;
}

function buildModel(
  id: string,
  context: number,
  max: number,
  toolStream: boolean,
  effortThinking: boolean,
  apiPrice: { input: number; output: number; cacheRead: number } | undefined,
  contextCap?: number,
): BuiltModel {
  const effectiveContext = contextCap ? Math.min(context, contextCap) : context;
  const capped = contextCap && context > contextCap;
  const cost = apiPrice
    ? {
        input: apiPrice.input / 1_000_000,
        output: apiPrice.output / 1_000_000,
        cacheRead: apiPrice.cacheRead / 1_000_000,
        cacheWrite: 0,
      }
    : ZERO_COST;
  const baseName = prettyName(id);
  const name = capped ? `${baseName} (272K safe)` : baseName;
  return {
    id,
    name,
    reasoning: true,
    ...(effortThinking ? { thinkingLevelMap: REQUIRED_EFFORT_THINKING_LEVELS } : {}),
    input: ["text"],
    cost,
    contextWindow: effectiveContext,
    maxTokens: max,
    compat: effortThinking ? REQUIRED_EFFORT_COMPAT : toolStream ? ZAI_COMPAT_TOOL_STREAM : ZAI_COMPAT_BASE,
  };
}

function prettyName(id: string): string {
  return id
    .split(/[\-_.]/)
    .map((p) => p.toUpperCase())
    .join("-");
}

// =============================================================================
// Build provider model lists
// =============================================================================

interface ModelData {
  id: string;
  context: number;
  max: number;
  toolStream: boolean;
  effortThinking: boolean;
  oneM: boolean;
  apiPrice?: { input: number; output: number; cacheRead: number };
}

function collectModelData(
  ids: string[],
  pricing: Record<string, any> | null,
  limitsCache: Record<string, { context: number; max: number }>,
): ModelData[] {
  return ids.map((id) => {
    const cached = limitsCache[id];
    const cur = CURATED[id];
    const context = cached?.context || cur?.context || 128000;
    const max = cached?.max || cur?.max || 131072;
    const toolStream = cur?.toolStream ?? (id.startsWith("glm-5") || id.startsWith("glm-4.7") || id.startsWith("glm-4.6"));
    const priceKey = id.toLowerCase();
    const apiPrice = (pricing && pricing[priceKey]) || CURATED_PRICING[priceKey];
    return {
      id,
      context,
      max,
      toolStream,
      effortThinking: cur?.effortThinking ?? false,
      oneM: context > ONE_M_THRESHOLD,
      apiPrice,
    };
  });
}

function buildSafeModels(data: ModelData[]): BuiltModel[] {
  return data.map((m) => buildModel(m.id, m.context, m.max, m.toolStream, m.effortThinking, m.apiPrice, SAFE_CONTEXT));
}

function buildOneMModels(data: ModelData[]): BuiltModel[] {
  return data
    .filter((m) => m.oneM)
    .map((m) => buildModel(m.id, m.context, m.max, m.toolStream, m.effortThinking, m.apiPrice));
}

// =============================================================================
// Fetch orchestration
// =============================================================================

async function fetchLimitsForIds(ids: string[], timeoutMs: number): Promise<Record<string, { context: number; max: number }>> {
  const out: Record<string, { context: number; max: number }> = {};
  await Promise.all(
    ids.map(async (id) => {
      if (!id.startsWith("glm")) return;
      const md = await fetchWithTimeout(MODEL_DOC(id), timeoutMs);
      if (!md) return;
      const parsed = parseModelLimits(md);
      if (parsed) out[id] = parsed;
    }),
  );
  return out;
}

async function fetchFresh(timeoutMs: number): Promise<{ safe: BuiltModel[]; oneM: BuiltModel[] } | null> {
  const pricingTxt = await fetchWithTimeout(PRICING_MD, timeoutMs);
  const pricing = pricingTxt ? parsePricing(pricingTxt) : null;
  if (!pricing) return null;
  writeCache(CACHE_PRICING, pricing);

  const ids = codingModelIds(pricing);

  const limits = await fetchLimitsForIds(ids, timeoutMs);
  writeCache(CACHE_ENRICHED, limits);

  const data = collectModelData(ids, pricing, limits);
  return { safe: buildSafeModels(data), oneM: buildOneMModels(data) };
}

// =============================================================================
// Filter
// =============================================================================

// Models confirmed in Coding Plan but not yet present on Z.AI's pricing page.
// Keep this small: pricing remains the general availability source.
const CODING_PLAN_ALLOW = new Set(["glm-5.3"]);

// Models confirmed NOT in Coding Plan (429 access denied).
const CODING_PLAN_DENY = new Set(["glm-5v-turbo"]);

// Coding-plan models only: no ocr, 32b, X variants.
// Vision (v) kept — some work, some 429'd handled by deny set.
function codingModelIds(pricing: Record<string, any>): string[] {
  return Array.from(new Set([...Object.keys(pricing), ...CODING_PLAN_ALLOW])).filter((id) => {
    if (!id.startsWith("glm")) return false;
    if (id.includes("ocr")) return false;
    if (id.includes("32b")) return false;
    if (id.endsWith("x") || id.endsWith("-x")) return false;
    if (CODING_PLAN_DENY.has(id)) return false;
    return true;
  });
}

// =============================================================================
// Registration
// =============================================================================

function registerProvider(pi: ExtensionAPI, provider: string, models: BuiltModel[]) {
  if (models.length === 0) return;
  pi.registerProvider(provider, {
    baseUrl: BASE_URL,
    apiKey: "ZAI_API_KEY",
    api: "openai-completions",
    models,
  });
}

function register(pi: ExtensionAPI, safe: BuiltModel[], oneM: BuiltModel[]) {
  // Register zai first (sorts first in selectors), zai-1m after.
  registerProvider(pi, "zai", safe);
  registerProvider(pi, "zai-1m", oneM);
}

export default async function zaiModelsExtension(pi: ExtensionAPI) {
  const cachedPricing = readCache(CACHE_PRICING);
  const coldStart = !cachedPricing;

  // Cache age check — skip refresh if fresh enough.
  function cacheIsFresh(): boolean {
    try {
      const st = fs.statSync(CACHE_PRICING);
      return Date.now() - st.mtimeMs < CACHE_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  if (!coldStart) {
    // Fast path: register from cache.
    const limits = readCache(CACHE_ENRICHED) || {};
    const ids = codingModelIds(cachedPricing);
    const data = collectModelData(ids, cachedPricing, limits);
    register(pi, buildSafeModels(data), buildOneMModels(data));

    // Background refresh only if cache stale.
    if (!cacheIsFresh()) {
      fetchFresh(3000)
        .then((fresh) => {
          if (fresh) register(pi, fresh.safe, fresh.oneM);
        })
        .catch(() => {
          /* keep cache */
        });
    }
    return;
  }

  // Cold start: blocking fetch with short timeout. Fall back to curated if fails.
  const fresh = await fetchFresh(3000);
  if (fresh) {
    register(pi, fresh.safe, fresh.oneM);
    return;
  }

  // Last resort: static curated list.
  const fallbackIds = Object.keys(CURATED);
  const data = collectModelData(fallbackIds, CURATED_PRICING, {});
  register(pi, buildSafeModels(data), buildOneMModels(data));
}


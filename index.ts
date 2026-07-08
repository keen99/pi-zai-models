// pi-zai-models: register Z.AI (zai) provider models with correct limits.
//
// Problem: upstream pi-ai models.generated.js is missing glm-5.2 (shipped by
// Z.AI 2026-06-13) and ships stale/wrong contextWindow / maxTokens for some
// GLM-5.x models. pi is slow to adopt new Z.AI models, so we maintain the list
// here. registerProvider("zai", { models }) REPLACES the provider's model list,
// so this file is the single source of truth for the zai provider.
//
// Limits sourced from official Z.AI docs and pi compatibility needs:
//   - GLM-5.2[1m]: 1M context / 128K output (docs.z.ai/guides/llm/glm-5.2)
//   - GLM-5.2: 272K safe default, aligned with pi's gpt-5.5 context window.
//     Z.AI appears to quota/throttle long-context legacy Coding Plan usage by tokens,
//     so 1M is opt-in only.
//   - GLM-5.1: 200K context / 128K output (docs.z.ai/guides/llm/glm-5.1)
//   - GLM-5-Turbo / GLM-5V-Turbo: 200K / 128K
//   - GLM-4.7: 200K / 128K
//   - GLM-4.5-Air: 128K / 96K
//
// All models use the coding endpoint (https://api.z.ai/api/coding/paas/v4),
// zai thinking format, and (for 4.7+) streaming tool calls (zaiToolStream).
// Costs are zero because Z.AI Coding Plan is subscription-billed, not metered.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.z.ai/api/coding/paas/v4";

// Shared base compat for all zai models. 4.7+ add zaiToolStream.
const ZAI_COMPAT_BASE = {
  supportsDeveloperRole: false,
  thinkingFormat: "zai" as const,
};

const ZAI_COMPAT_TOOL_STREAM = {
  ...ZAI_COMPAT_BASE,
  zaiToolStream: true,
};

const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export default function zaiModelsExtension(pi: ExtensionAPI) {
  pi.registerProvider("zai", {
    baseUrl: BASE_URL,
    apiKey: "ZAI_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "glm-4.5-air",
        name: "GLM-4.5-Air",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 131072,
        maxTokens: 98304,
        compat: ZAI_COMPAT_BASE,
      },
      {
        id: "glm-4.7",
        name: "GLM-4.7",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 204800,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
      {
        id: "glm-5-turbo",
        name: "GLM-5-Turbo",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 200000,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
      {
        id: "glm-5.1",
        name: "GLM-5.1",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 200000,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
      // glm-5v-turbo omitted: not in Coding Plan (429 "does not yet include access").
      {
        id: "glm-5.2",
        name: "GLM-5.2 (272K safe)",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        // Safe default aligned to pi's gpt-5.5 context (272K). Keeps model switching
        // and compaction recovery from crossing between 1M ZAI and 272K OpenAI limits.
        contextWindow: 272000,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
      {
        // Z.AI's documented opt-in 1M id for coding agents. Use this only when
        // you intentionally want 1M context and accept higher quota/token pressure.
        id: "glm-5.2[1m]",
        name: "GLM-5.2 (1M)",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        contextWindow: 1000000,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
    ],
  });
}

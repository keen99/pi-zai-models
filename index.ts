// pi-zai-models: register Z.AI (zai) provider models with correct limits.
//
// Problem: upstream pi-ai models.generated.js is missing glm-5.2 (shipped by
// Z.AI 2026-06-13) and ships stale/wrong contextWindow / maxTokens for some
// GLM-5.x models. pi is slow to adopt new Z.AI models, so we maintain the list
// here. registerProvider("zai", { models }) REPLACES the provider's model list,
// so this file is the single source of truth for the zai provider.
//
// Limits sourced from official Z.AI docs:
//   - GLM-5.2: 1M context / 128K output (docs.z.ai/guides/llm/glm-5.2)
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
      {
        id: "glm-5v-turbo",
        name: "GLM-5V-Turbo",
        reasoning: true,
        input: ["text", "image"],
        cost: ZERO_COST,
        contextWindow: 200000,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
      {
        id: "glm-5.2",
        name: "GLM-5.2",
        reasoning: true,
        input: ["text"],
        cost: ZERO_COST,
        // Flagship long-horizon model. Solid 1M context / 128K output.
        contextWindow: 1000000,
        maxTokens: 131072,
        compat: ZAI_COMPAT_TOOL_STREAM,
      },
    ],
  });
}

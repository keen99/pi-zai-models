# pi-zai-models

pi extension that dynamically registers Z.AI (`zai`) provider models with
correct **context window**, **max output tokens**, and **API pricing** ---
including **GLM-5.2** which upstream `pi-ai` does not ship.

## Why

Z.AI released GLM-5.2 on 2026-06-13 with a solid **1M-token context** and
**128K max output**. Weeks later, `@earendil-works/pi-ai` (the model registry
`pi` ships with) still has no `glm-5.2` entry at all, and some GLM-5.x limits
are stale. `pi` is slow to adopt new Z.AI models.

This extension fixes that by fetching the live model list and limits from
Z.AI's own docs, then calling `pi.registerProvider("zai", { models })`.
`registerProvider` with `models` **replaces** the provider's entire model list,
so this file is the single source of truth for the `zai` provider on your pi
installs.

## What it does

On load:

1. **Fetches** the Z.AI pricing page (`docs.z.ai/guides/overview/pricing.md`)
   --- model IDs + per-1M-token prices. No auth needed.
2. **Fetches** each model's doc page (`docs.z.ai/guides/llm/<id>.md`) ---
   context window + max output tokens.
3. **Parses** both, filters to coding-plan text models (drops ocr/32b/X
   variants, and `glm-5v-turbo` which 429s), and registers two providers.

All models use the coding endpoint
(`https://api.z.ai/api/coding/paas/v4`), Z.AI `thinkingFormat`, and
`zaiToolStream` (streaming tool-call deltas) for 4.7+ models. Costs are
populated with real API metered prices so pi's per-turn cost tracking shows
equivalent value (Coding Plan is subscription-billed, not metered).

### Two providers

1M-capable models (context > 272K) get registered in **both** providers:

| Provider  | Models              | Context for 1M-capable | Purpose |
|-----------|---------------------|------------------------|---------|
| `zai`     | all coding models   | capped to 272K  | default --- model-switch friendly |
| `zai-1m`  | 1M-capable only     | full 1M                | opt-in for long-context work |

Both send the real Z.AI model id (e.g. `glm-5.2`) to the API. The `[1m]`
suffix is a Claude Code client-side convention only --- Z.AI rejects it on both
OpenAI and Anthropic endpoints, so this extension uses a separate provider
instead of a suffix alias.

**Why 272K safe default?** Aligned with pi's `gpt-5.5` context window.
Prevents context overflow when switching models or during compaction recovery
(pi cannot safely compact 1M → 272K with a smaller context model). Use `zai-1m/glm-5.2` only when you
intentionally want 1M context.

## Caching

Fetched data is cached to avoid redundant HTTP on every pi spawn (subagents,
chained agents, etc.):

```
~/.cache/pi-zai-models/
  pricing.json          # model id → {input, output, cacheRead} per 1M
  enriched-models.json  # model id → {context, max} from doc parse
```

- **Cold start** (no cache): blocking 3s fetch, write cache, register.
- **Warm start** (cache exists): register instantly from cache.
- **Refresh**: background fetch fires **only if cache older than 1 hour**.
  If fetch succeeds → overwrite cache + re-register. If it fails → keep cache.
- **Force refresh**: `rm -rf ~/.cache/pi-zai-models` (next spawn = cold start).
- **Fallback**: if both fetch and cache fail on cold start, a hardcoded
  `CURATED` table registers a minimal model set so the provider is never empty.

Cache location honors `$XDG_CACHE_HOME`.

## Coding Plan usage / quota notes

Current Z.AI docs: <https://docs.z.ai/devpack/overview#usage-instruction>

- One prompt = one query.
- Each prompt is estimated to invoke the model 15--20 times.
- 5-hour and weekly limits are estimates; actual usage varies with project
  complexity, repository size, and auto-accept.
- Current caps: Lite ~80/5hr + ~400/week, Pro ~400/5hr + ~2,000/week, Max
  ~1,600/5hr + ~8,000/week.
- GLM-5.2 and GLM-5-Turbo consume 3× quota during peak, 2× off-peak; off-peak
  1× promo runs through end of September.

Legacy reference (archived 2026-01-06):
<https://web.archive.org/web/20260106170952/https://z.ai/subscribe>

- Legacy 5-hour estimates were higher: Lite ~120, Pro ~600, Max ~2,400.
- Legacy copy also described token consumption: each prompt typically allowed
  15--20 model calls and monthly allowance was "tens of billions of tokens."

## Context window vs max output

Two separate limits, easy to confuse:

- **Context window** (`contextWindow`) = max tokens the model accepts as
  **input** (prompt + history).
- **Max output** (`maxTokens`) = max tokens the model can **generate** in one
  response.

pi uses both: context window drives auto-compaction and `/context` display;
max output caps the generation length sent to the API.

## Install

This is a pi package. Add to `~/.pi/agent/settings.json` `packages` array:

```json
{
  "packages": [
    "git:github.com/keen99/pi-zai-models"
  ]
}
```

Then:

```
pi install
```

`pi install` pulls the git repo into `~/.pi/agent/git/github.com/keen99/`,
resolves `package.json`, and loads the extension declared under `pi.extensions`.
Updates propagate the same way --- re-run `pi install` after upstream changes,
or use `pi-pkg-autoreload` for auto sync.

Requires `ZAI_API_KEY` in env (or `auth.json`) --- auth is unchanged by this
extension.

## Verify

After install + restart:

```
pi --list-models | grep zai
```

Should show all coding-plan models under `zai`, plus 1M-capable models under
`zai-1m`. Real API calls should work for every listed model.

## Defaults

Safe default in `settings.json`:

```json
{
  "defaultProvider": "zai",
  "defaultModel": "glm-5.2"
}
```

Opt into 1M only when needed:

```json
{
  "defaultProvider": "zai-1m",
  "defaultModel": "glm-5.2"
}
```

## Maintenance

Limits and pricing come from official Z.AI docs, fetched live:

- Pricing: <https://docs.z.ai/guides/overview/pricing.md>
- Per-model limits: <https://docs.z.ai/guides/llm/<model-id>>

When Z.AI ships a new model, it appears automatically once it hits the pricing
page (no code change needed). The hardcoded `CURATED` table in `index.ts` is
only a cold-start fallback --- update it if a model lacks a doc page with
parseable limits.

When upstream `pi-ai` finally adds `glm-5.2`, this extension still wins (later
registration overrides), so nothing breaks --- you can uninstall it once upstream
catches up.

## Compatibility

- pi `>= 0.75.4` (uses `registerProvider`, available since the extension API
  stabilized).
- Requires `@earendil-works/pi-coding-agent` as a peer (provided by pi itself).

## License

MIT

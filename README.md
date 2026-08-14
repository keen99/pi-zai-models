# pi-zai-models

pi extension that dynamically registers Z.AI (`zai`) provider models with
correct **context window**, **max output tokens**, **thinking controls**, and
**API pricing** --- including **GLM-5.3** before Z.AI's pricing page and
upstream `pi-ai` list it.

## Why

Z.AI released GLM-5.3 on 2026-08-14 for Coding Plan users with a **1M-token
context** and **128K max output**. Its general API is still marked "coming
soon," and Z.AI's pricing page does not list it yet. GLM-5.3 also changed the
thinking API: thinking is mandatory and effort must be `low`, `high`, or `max`.

This extension fixes that by combining Z.AI's live pricing list with a small
allowlist for announced Coding Plan models, fetching limits from Z.AI's model
docs, then calling `pi.registerProvider("zai", { models })`.
`registerProvider` with `models` **replaces** the provider's entire model list,
so this file is the single source of truth for the `zai` provider on your pi
installs.

## What it does

On load:

1. **Fetches** the Z.AI pricing page (`docs.z.ai/guides/overview/pricing.md`)
   --- model IDs + per-1M-token prices. Announced Coding Plan models missing
   from that page (currently GLM-5.3) come from a curated allowlist. No auth
   needed.
2. **Fetches** each model's doc page (`docs.z.ai/guides/llm/<id>.md`) ---
   context window + max output tokens.
3. **Parses** both, filters to coding-plan text models (drops ocr/32b/X
   variants, and `glm-5v-turbo` which 429s), and registers two providers.

All models use the coding endpoint
(`https://api.z.ai/api/coding/paas/v4`) and `zaiToolStream` (streaming
tool-call deltas) for 4.7+ models. Legacy models use Z.AI's `enable_thinking`
format. GLM-5.3 uses `thinking: { type: "enabled" }` plus
`reasoning_effort`; pi levels map as `low` → `low`, `high` → `high`, and
`xhigh` → `max`. Unsupported `off`, `minimal`, and `medium` levels are hidden
and clamped to a supported level.

Costs use live API metered prices when published so pi's per-turn tracking
shows equivalent value (Coding Plan is subscription-billed, not metered).
GLM-5.3 reports zero equivalent cost until Z.AI adds it to the pricing page.

### Two providers

1M-capable models (context > 272K) get registered in **both** providers:

| Provider  | Models              | Context for 1M-capable | Purpose |
|-----------|---------------------|------------------------|---------|
| `zai`     | all coding models   | capped to 272K  | default --- model-switch friendly |
| `zai-1m`  | 1M-capable only     | full 1M                | opt-in for long-context work |

Both send the real Z.AI model id (e.g. `glm-5.3`) to the API. The `[1m]`
suffix is a Claude Code client-side convention only --- Z.AI rejects it on both
OpenAI and Anthropic endpoints, so this extension uses a separate provider
instead of a suffix alias.

**Why 272K safe default?** Aligned with pi's `gpt-5.5` context window.
Prevents context overflow when switching models or during compaction recovery
(pi cannot safely compact 1M → 272K with a smaller context model). Use `zai-1m/glm-5.3` only when you
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
  "defaultModel": "glm-5.3"
}
```

Opt into 1M only when needed:

```json
{
  "defaultProvider": "zai-1m",
  "defaultModel": "glm-5.3"
}
```

## Maintenance

Limits and pricing come from official Z.AI docs, fetched live:

- Pricing: <https://docs.z.ai/guides/overview/pricing.md>
- Per-model limits: <https://docs.z.ai/guides/llm/<model-id>>

When Z.AI ships a new model, it appears automatically once it hits the pricing
page. If Coding Plan gets it first, add it to `CODING_PLAN_ALLOW`. The hardcoded
`CURATED` table supplies cold-start limits and model-specific API behavior;
update it for new request-format changes or docs without parseable limits.

When upstream `pi-ai` adds these models, this extension still wins (later
registration overrides), so nothing breaks --- you can uninstall it once upstream
catches up.

## Compatibility

- pi `>= 0.75.4` (uses `registerProvider`, available since the extension API
  stabilized).
- Requires `@earendil-works/pi-coding-agent` as a peer (provided by pi itself).

## License

MIT

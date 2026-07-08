# pi-zai-models

pi extension that registers Z.AI (`zai`) provider models with correct
**context window** and **max output tokens**, including **GLM-5.2** which
upstream `pi-ai` does not ship.

## Why

Z.AI released GLM-5.2 on 2026-06-13 with a solid **1M-token context** and
**128K max output**. The 1M path is opt-in as `glm-5.2[1m]`. Plain
`glm-5.2` is kept as a safer 272K model aligned with pi's `gpt-5.5` context so
model switching and compaction recovery do not cross 1M→272K boundaries.

Weeks later, `@earendil-works/pi-ai` (the model registry `pi` ships with) still
has no `glm-5.2` entry at all, and some GLM-5.x limits are stale. `pi` is slow
to adopt new Z.AI models.

If your `settings.json` points `defaultModel` at `glm-5.2` but the registry
has no entry, the model resolver has nothing to work with — wrong or missing
limits, and no real model object.

This extension fixes that by calling `pi.registerProvider("zai", { models })`
with a maintained, correct model list. `registerProvider` with `models`
**replaces** the provider's entire model list, so this file is the single
source of truth for the `zai` provider on your pi installs.

## What it does

On load, registers these models under the `zai` provider, all on the coding
endpoint (`https://api.z.ai/api/coding/paas/v4`):

| Model         | Context    | Max Output | Input        | Notes                       |
|---------------|------------|------------|--------------|-----------------------------|
| `glm-4.5-air` | 131,072    | 98,304     | text         | lightweight fallback        |
| `glm-4.7`     | 204,800    | 131,072    | text         | streaming tool calls        |
| `glm-5-turbo` | 200,000    | 131,072    | text         | streaming tool calls        |
| `glm-5.1`     | 200,000    | 131,072    | text         | streaming tool calls        |
| `glm-5.2`     | 272,000    | 131,072    | text         | safe default, gpt-5.5-aligned, streaming tool calls |
| `glm-5.2[1m]` | 1,000,000  | 131,072    | text         | opt-in 1M context, streaming tool calls |

All set `reasoning: true`, Z.AI `thinkingFormat`, zero cost (Coding Plan is
subscription-billed, not metered). 4.7+ enable `zaiToolStream` for streaming
tool-call deltas.

`glm-5v-turbo` (vision) is **not** in the Coding Plan — returns
`429 "does not yet include access"` — so it's omitted. If you have a separate
metered API key and want it, add it back.

## GLM-5.2 default vs 1M

Z.AI docs use `glm-5.2[1m]` as the opt-in 1M identifier for coding agents. pi
sends `model.id` directly to the API, so this extension uses the official
`glm-5.2[1m]` id rather than a local-only alias like `glm-5.2-1m`.

Plain `glm-5.2` is intentionally capped to **272K** in pi. Reason: Coding Plan
usage is prompt/quota based, but Z.AI says each prompt is estimated to invoke the
model 15–20 times and actual usage varies by project complexity, repository size,
and auto-accept. Legacy plans also described usage in token-consumption terms, so
long 1M contexts can burn hidden quota faster than the plain prompt count
suggests. pi's model-switch / overflow recovery can also fail when switching from
a 1M context model to 272K `gpt-5.5`. Use `glm-5.2[1m]` only when you
intentionally want 1M context.

## Coding Plan usage / quota notes

Current Z.AI docs: <https://docs.z.ai/devpack/overview#usage-instruction>

- One prompt = one query.
- Each prompt is estimated to invoke the model 15–20 times.
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
  15–20 model calls and monthly allowance was “tens of billions of tokens.”

## Context window vs max output

Two separate limits, easy to confuse:

- **Context window** (`contextWindow`) = max tokens the model accepts as
  **input** (prompt + history). `glm-5.2`: 272,000 safe default;
  `glm-5.2[1m]`: 1,000,000 opt-in.
- **Max output** (`maxTokens`) = max tokens the model can **generate** in one
  response. GLM-5.2: 131,072 (~128K).

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
Updates propagate the same way — re-run `pi install` after upstream changes,
or use `pi-pkg-autoreload` for auto sync.

Requires `ZAI_API_KEY` in env (or `auth.json`) — auth is unchanged by this
extension.

## Verify

After install + restart:

```
pi --list-models | grep glm-5.2
```

Should show `zai / glm-5.2` and `zai / glm-5.2[1m]`. Inside pi, `/context`
reflects 272K for plain `glm-5.2` and 1M for `glm-5.2[1m]`.

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
  "defaultProvider": "zai",
  "defaultModel": "glm-5.2[1m]"
}
```

## Maintenance

Limits come from official Z.AI docs:

- GLM-5.2: <https://docs.z.ai/guides/llm/glm-5.2>
- GLM-5.1: <https://docs.z.ai/guides/llm/glm-5.1>

When Z.AI ships a new model, add a block to `index.ts`. When upstream `pi-ai`
finally adds `glm-5.2`, this extension still wins (later registration
overrides), so nothing breaks — you can uninstall it once upstream catches up.

## Config

None. Model list is hardcoded in `index.ts`. Edit + push to change across all
your pi installs.

## Compatibility

- pi `>= 0.75.4` (uses `registerProvider`, available since the extension API
  stabilized).
- Requires `@earendil-works/pi-coding-agent` as a peer (provided by pi itself).

## License

MIT

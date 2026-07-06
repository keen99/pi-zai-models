# pi-zai-models

pi extension that registers Z.AI (`zai`) provider models with correct
**context window** and **max output tokens**, including **GLM-5.2** which
upstream `pi-ai` does not ship.

## Why

Z.AI released GLM-5.2 on 2026-06-13 with a solid **1M-token context** and
**128K max output**. Weeks later, `@earendil-works/pi-ai` (the model registry
`pi` ships with) still has no `glm-5.2` entry at all, and some GLM-5.x limits
are stale. `pi` is slow to adopt new Z.AI models.

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
| `glm-5.2`     | 1,000,000  | 131,072    | text         | flagship, streaming tool calls |

All set `reasoning: true`, Z.AI `thinkingFormat`, zero cost (Coding Plan is
subscription-billed, not metered). 4.7+ enable `zaiToolStream` for streaming
tool-call deltas.

`glm-5v-turbo` (vision) is **not** in the Coding Plan — returns
`429 "does not yet include access"` — so it's omitted. If you have a separate
metered API key and want it, add it back.

## Context window vs max output

Two separate limits, easy to confuse:

- **Context window** (`contextWindow`) = max tokens the model accepts as
  **input** (prompt + history). GLM-5.2: 1,000,000.
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

Should show `zai / glm-5.2`. Inside pi, `/context` reflects the 1M window and
128K max output.

## Defaults

Make GLM-5.2 the default in `settings.json`:

```json
{
  "defaultProvider": "zai",
  "defaultModel": "glm-5.2"
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

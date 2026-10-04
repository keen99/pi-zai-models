import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Cache dir is computed at import time from XDG_CACHE_HOME — set it first.
const cacheRoot = mkdtempSync(join(tmpdir(), "zai-cache-"));
process.env.XDG_CACHE_HOME = cacheRoot;

const zai = await import("../index.js");
const {
	parsePricing,
	parseModelLimits,
	toTokens,
	buildModel,
	prettyName,
	codingModelIds,
	collectModelData,
	buildSafeModels,
	buildOneMModels,
	default: zaiModelsExtension,
} = zai as any;

const PRICE = (input: number, output: number, cacheRead = 0) => ({ input, output, cacheRead });

// ── toTokens ────────────────────────────────────────────────────────────
test("toTokens: K/M/plain/garbage", () => {
	assert.equal(toTokens("1M"), 1_000_000);
	assert.equal(toTokens("200K"), 200_000);
	assert.equal(toTokens("131072"), 131072);
	assert.equal(toTokens("0.2M"), 200_000);
	assert.equal(toTokens("k"), 0);
	assert.equal(toTokens(null), 0);
	assert.equal(toTokens("abc"), 0);
});

// ── parsePricing ────────────────────────────────────────────────────────
test("parsePricing: table rows, strikethrough promo, free, invalid skipped", () => {
	const md = `| Model | Input | Cache Read | Cache Write | Output |
| ------- | ----- | ---------- | ----------- | ------ |
| GLM-5.2 | ~~$1.5~~ $1.4 | $0.26 | - | $4.4 |
| GLM-Free | free | free | - | free |
| garbage row | |
| GLM-X | abc | $0.1 | - | $1 |`;
	const p = parsePricing(md);
	assert.ok(p);
	assert.deepEqual(p["glm-5.2"], PRICE(1.4, 4.4, 0.26));
	assert.deepEqual(p["glm-free"], PRICE(0, 0, 0));
	assert.equal(p["glm-x"], undefined, "unparseable price row skipped");
});

test("parsePricing: empty → null", () => {
	assert.equal(parsePricing("no tables here"), null);
});

// ── parseModelLimits ────────────────────────────────────────────────────
test("parseModelLimits: Card titles → context/max/image", () => {
	const md = `<Card title="Context Length">200K</Card>
<Card title="Maximum Output Tokens">128K</Card>
<Card title="Input Modality">text and image</Card>`;
	const r = parseModelLimits(md);
	assert.deepEqual(r, { context: 200_000, max: 128_000, image: true });
});

test("parseModelLimits: text-only input, missing fields → null", () => {
	const r = parseModelLimits(`<Card title="Context Length">131072</Card>
<Card title="Maximum Output Tokens">98304</Card>
<Card title="Input Modality">text only</Card>`);
	assert.deepEqual(r, { context: 131072, max: 98304, image: false });
	assert.equal(parseModelLimits("no cards"), null);
});

// ── codingModelIds ──────────────────────────────────────────────────────
test("codingModelIds: filters variants, applies allow + deny, glm-only", () => {
	const pricing = {
		"glm-5.2": {}, "glm-5.2-ocr": {}, "glm-4.5-32b": {}, "glm-5v-turbo": {},
		"glm-4.5-air-x": {}, "glm-4.5-air": {}, "other-model": {},
	};
	const ids = codingModelIds(pricing);
	assert.ok(ids.includes("glm-5.2"));
	assert.ok(ids.includes("glm-4.5-air"));
	assert.ok(ids.includes("glm-5.3"), "coding-plan allowlist added");
	assert.equal(ids.includes("glm-5.2-ocr"), false);
	assert.equal(ids.includes("glm-4.5-32b"), false);
	assert.equal(ids.includes("glm-5v-turbo"), false, "deny set wins");
	assert.equal(ids.includes("glm-4.5-air-x"), false);
	assert.equal(ids.includes("other-model"), false);
});

// ── collectModelData ────────────────────────────────────────────────────
test("collectModelData: cache beats curated beats defaults; oneM flag", () => {
	const data = collectModelData(
		["glm-5.2", "glm-4.6", "unknown-glm"],
		{ "glm-5.2": PRICE(1.4, 4.4) },
		{ "glm-4.6": { context: 500000, max: 64000, image: true } },
	);
	const g52 = data.find((m: any) => m.id === "glm-5.2");
	assert.equal(g52.context, 1_000_000); // curated
	assert.equal(g52.max, 131072);
	assert.equal(g52.effortThinking, true);
	assert.deepEqual(g52.apiPrice, PRICE(1.4, 4.4));
	assert.equal(g52.oneM, true);

	const g46 = data.find((m: any) => m.id === "glm-4.6");
	assert.equal(g46.context, 500000, "cached limits win");
	assert.equal(g46.image, true);
	assert.equal(g46.oneM, true);

	const unk = data.find((m: any) => m.id === "unknown-glm");
	assert.equal(unk.context, 128000, "default context");
	assert.equal(unk.max, 131072, "default max");
	assert.equal(unk.oneM, false);
});

// ── buildModel ──────────────────────────────────────────────────────────
test("buildModel: 272K cap adds safe suffix; cost divided per 1M", () => {
	const m = buildModel("glm-5.2", 1_000_000, 131072, true, true, false, PRICE(1.4, 4.4, 0.26), 272_000);
	assert.equal(m.contextWindow, 272_000);
	assert.match(m.name, /272K safe/);
	assert.deepEqual(m.cost, { input: 1.4 / 1e6, output: 4.4 / 1e6, cacheRead: 0.26 / 1e6, cacheWrite: 0 });
	assert.equal(m.compat.thinkingFormat, "deepseek");
	assert.equal(m.compat.zaiToolStream, true);
	assert.equal(m.compat.supportsReasoningEffort, true);
	assert.ok(m.thinkingLevelMap);
	assert.equal(m.thinkingLevelMap.xhigh, "max");
	assert.equal(m.thinkingLevelMap.medium, null);
});

test("buildModel: uncapped keeps full context, plain name", () => {
	const m = buildModel("glm-4.6", 131072, 131072, true, false, false, undefined, 272_000);
	assert.equal(m.contextWindow, 131072);
	assert.equal(m.name, "GLM-4-6");
	assert.equal(m.compat.zaiToolStream, true, "glm-4.6 toolStream=true");
	assert.equal(m.thinkingLevelMap, undefined);
	assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("prettyName: dashes/dots → uppercase segments", () => {
	assert.equal(prettyName("glm-5.3-flash"), "GLM-5-3-FLASH");
});

test("buildSafeModels caps; buildOneMModels filters to 1M-capable", () => {
	const data = collectModelData(["glm-5.2", "glm-4.6"], null, {});
	const safe = buildSafeModels(data);
	assert.equal(safe.length, 2);
	assert.equal(safe[0].contextWindow, 272_000);
	const oneM = buildOneMModels(data);
	assert.equal(oneM.length, 1);
	assert.equal(oneM[0].id, "glm-5.2");
	assert.equal(oneM[0].contextWindow, 1_000_000, "no cap in 1m provider");
});

// ── default() closure: warm cache / cold fallback ──────────────────────
function fakePi() {
	const providers: Record<string, any> = {};
	return {
		pi: { registerProvider: (name: string, cfg: any) => { providers[name] = cfg; } },
		providers,
	};
}

function seedCache(pricing: Record<string, any>, limits: any = {}, fresh = true) {
	mkdirSync(join(cacheRoot, "pi-zai-models"), { recursive: true });
	writeFileSync(join(cacheRoot, "pi-zai-models", "pricing.json"), JSON.stringify(pricing));
	writeFileSync(join(cacheRoot, "pi-zai-models", "enriched-models.json"), JSON.stringify(limits));
	const age = fresh ? 0 : 2 * 60 * 60 * 1000;
	utimesSync(join(cacheRoot, "pi-zai-models", "pricing.json"), new Date(Date.now() - age), new Date(Date.now() - age));
}

async function withFetchBlocked(fn: () => Promise<void>) {
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => { throw new Error("network blocked in test"); }) as any;
	try { await fn(); } finally { globalThis.fetch = orig; }
}

test("warm fresh cache: registers both providers from cache, zero fetches", async () => {
	seedCache({ "glm-5.2": PRICE(1.4, 4.4), "glm-4.6": PRICE(0.6, 2.2) });
	const { pi, providers } = fakePi();
	let fetches = 0;
	const orig = globalThis.fetch;
	globalThis.fetch = (async () => { fetches++; throw new Error("should not fetch"); }) as any;
	try {
		await zaiModelsExtension(pi);
	} finally {
		globalThis.fetch = orig;
	}
	assert.equal(fetches, 0, "fresh cache → no background refresh");
	assert.ok(providers["zai"]);
	assert.ok(providers["zai-1m"]);
	assert.equal(providers["zai"].api, "openai-completions");
	assert.equal(providers["zai"].baseUrl, "https://api.z.ai/api/coding/paas/v4");
	assert.ok(providers["zai"].models.some((m: any) => m.id === "glm-5.2"));
	assert.deepEqual(providers["zai-1m"].models.map((m: any) => m.id).sort(), ["glm-5.2", "glm-5.3"], "glm-5.3 via coding-plan allowlist");
});

test("cold start with network blocked: curated fallback registers", async () => {
	rmSync(join(cacheRoot, "pi-zai-models"), { recursive: true, force: true });
	const { pi, providers } = fakePi();
	await withFetchBlocked(async () => {
		await zaiModelsExtension(pi);
	});
	assert.ok(providers["zai"]);
	const ids = providers["zai"].models.map((m: any) => m.id);
	assert.ok(ids.includes("glm-4.5-air"), "curated list present");
	assert.deepEqual(providers["zai-1m"].models.map((m: any) => m.id).sort(), ["glm-5.2", "glm-5.3", "glm-5.3-flash"], "glm-5.1 is 200K, not 1M-capable");
	// failed cold fetch → no cache written; next boot retries cold
	assert.equal(existsSync(join(cacheRoot, "pi-zai-models", "pricing.json")), false, "fallback path writes no cache");
});

test("cold start with successful fetch: fresh pricing drives model set, caches written", async () => {
	rmSync(join(cacheRoot, "pi-zai-models"), { recursive: true, force: true });
	const pricingMd = `| Model | Input | Cache Read | Cache Write | Output |
| GLM-9.9 | $2 | $0.3 | - | $8 |`;
	const docMd = `<Card title="Context Length">1M</Card>
<Card title="Maximum Output Tokens">128K</Card>
<Card title="Input Modality">text</Card>`;
	const orig = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		const body = String(url).includes("pricing") ? pricingMd : docMd;
		return { ok: true, text: async () => body } as any;
	}) as any;
	try {
		const { pi, providers } = fakePi();
		await zaiModelsExtension(pi);
		const ids = providers["zai"].models.map((m: any) => m.id);
		assert.ok(ids.includes("glm-9.9"), "fresh pricing model present");
		assert.ok(existsSync(join(cacheRoot, "pi-zai-models", "pricing.json")));
		assert.ok(existsSync(join(cacheRoot, "pi-zai-models", "enriched-models.json")));
	} finally {
		globalThis.fetch = orig;
	}
});

test("stale cache: registers cached set immediately, background refresh replaces", async () => {
	seedCache({ "glm-4.6": PRICE(0.6, 2.2) }, {}, false);
	const { pi, providers } = fakePi();
	const freshPricing = `| Model | Input | Cache Read | Cache Write | Output |
| GLM-8.8 | $1 | $0.2 | - | $3 |`;
	const docMd = `<Card title="Context Length">200K</Card>
<Card title="Maximum Output Tokens">64K</Card>
<Card title="Input Modality">text</Card>`;
	const orig = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		const body = String(url).includes("pricing") ? freshPricing : docMd;
		return { ok: true, text: async () => body } as any;
	}) as any;
	try {
		await zaiModelsExtension(pi);
		assert.ok(providers["zai"].models.some((m: any) => m.id === "glm-4.6"), "immediate registration from cache");
		await new Promise((r) => setTimeout(r, 100));
		assert.ok(providers["zai"].models.some((m: any) => m.id === "glm-8.8"), "background refresh re-registered fresh set");
	} finally {
		globalThis.fetch = orig;
	}
});

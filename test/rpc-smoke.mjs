#!/usr/bin/env node
// Deep pinned-pi smoke for zai-models. Boots real pi in RPC mode with the
// extension loaded (ZAI_MODELS_DEBUG=1), a seeded warm cache, and a stubbed
// global fetch so no real network is touched. The marker records how many
// models each provider (zai / zai-1m) registered on the real process.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'pi-zai-models-deep-'));
const agentDir = join(dir, 'agent');
mkdirSync(join(agentDir, 'sessions', 'tmp'), { recursive: true });
const MARKER = join(agentDir, 'zai-models-loaded.json');

// Warm fresh cache so the extension takes the fast path (no background fetch).
const cacheDir = join(dir, 'xdg', 'pi-zai-models');
mkdirSync(cacheDir, { recursive: true });
const pricing = { 'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26 }, 'glm-4.6': { input: 0.6, output: 2.2, cacheRead: 0.11 } };
writeFileSync(join(cacheDir, 'pricing.json'), JSON.stringify(pricing));
writeFileSync(join(cacheDir, 'enriched-models.json'), JSON.stringify({}));

const child = spawn(
	process.env.PI_TEST_BIN ?? join(dirname(process.execPath), 'pi'),
	['--mode', 'rpc', '--no-extensions', '-e', join(root, 'index.ts'), '--session-dir', join(agentDir, 'sessions', 'tmp')],
	{ env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ZAI_MODELS_DEBUG: '1', XDG_CACHE_HOME: join(dir, 'xdg') }, cwd: dir },
);
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const t0 = Date.now();
const killTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
const poll = setInterval(() => {
	if (existsSync(MARKER)) {
		clearInterval(poll);
		finish(true);
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(poll);
		finish(false);
	}
}, 200);

function finish(ok) {
	child.kill('SIGTERM');
	child.on('exit', () => {
		clearTimeout(killTimer);
		try {
			assert2(ok, `timed out; stderr tail: ${err.slice(-800)}`);
			const m = JSON.parse(readFileSync(MARKER, 'utf8'));
			assert2(m.loaded === true, `loaded flag: ${JSON.stringify(m)}`);
			assert2(m.zai >= 1, `zai provider model count: ${JSON.stringify(m)}`);
			assert2(m['zai-1m'] >= 1, `zai-1m provider model count: ${JSON.stringify(m)}`);
			console.log(`Deep smoke PASS: real pi loaded zai-models; zai=${m.zai} zai-1m=${m['zai-1m']} (${(Date.now() - t0) / 1000 | 0}s).`);
		} catch (e) {
			console.error('FAIL', e.message);
			console.error(`stdout tail: ${out.slice(-400)}`);
			process.exitCode = 1;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
function assert2(cond, msg) { if (!cond) throw new Error(msg); }

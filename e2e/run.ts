// E2E: each agent must (1) answer from the injected Thegram memory without tools and
// (2) record a plain coding task's outcome in Thegram on its own. Writes e2e/artifacts/<stamp>.json.
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { callTool, isJson, PACKAGE_ROOT, str } from "../src/core.ts";

type Mode = "dev" | "installed";

interface Prepared {
	run(prompt: string): { cmd: string[]; env?: Record<string, string> };
	/** Where the agent loads this plugin from, when that is not the working tree itself. */
	loaded?: { root: string; hash: string };
}

interface Agent {
	name: string;
	version: string[];
	/** Per prompt; the default suits agents on a paid model. */
	timeoutMs?: number;
	/** Prepares the scratch repository and returns how to run one prompt. */
	prepare(repo: string, mode: Mode): Promise<Prepared>;
	/** Pulls the final answer out of the agent's stdout. */
	answer(stdout: string, outFile: string): Promise<string>;
}

const OC1_PREFIX = "/tmp/tgm-oc1";
const OC_XDG = "/tmp/tgm-oc-xdg";
// The files an installed copy runs; a stale copy would make a dev run test old code.
const RUNTIME_FILES = [
	"dist/thegram-memory.mjs",
	"hooks/hooks.json",
	"policy.md",
	"skills/thegram-memory/SKILL.md",
	".codex-plugin/plugin.json",
	".codex-plugin/mcp.json",
	".claude-plugin/plugin.json",
];

async function runtimeHash(root: string): Promise<string> {
	const hash = createHash("sha256");
	for (const file of RUNTIME_FILES) hash.update(`${file}\0`).update(await readFile(path.join(root, file)).catch(() => Buffer.from("missing")));
	return hash.digest("hex").slice(0, 16);
}

function codexHome(): string {
	return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

async function installedClaudePlugin(): Promise<boolean> {
	const file = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
	const text = await readFile(file, "utf8").catch(() => "");
	return text.includes("thegram-memory@");
}

function xdg(root: string): Record<string, string> {
	return {
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	};
}

const AGENTS: Record<string, Agent> = {
	claude: {
		name: "claude",
		version: ["claude", "--version"],
		async prepare(_repo, mode) {
			// A marketplace install plus --plugin-dir would load the hooks and MCP server twice.
			if (mode === "dev" && (await installedClaudePlugin())) throw new Error("claude dev run needs the marketplace plugin uninstalled; use --installed");
			const plugin = mode === "dev" ? ["--plugin-dir", PACKAGE_ROOT] : [];
			return { run: prompt => ({
				cmd: [
					"claude",
					"-p",
					...plugin,
					"--permission-mode",
					"bypassPermissions",
					"--model",
					"sonnet",
					"--output-format",
					"json",
					"--no-session-persistence",
					prompt,
				],
			}) };
		},
		async answer(stdout) {
			const result: unknown = JSON.parse(stdout);
			return isJson(result) ? String(result.result ?? "") : stdout;
		},
	},
	codex: {
		name: "codex",
		version: ["codex", "--version"],
		async prepare(_repo, mode) {
			// Codex always runs the copy in its plugin cache; a dev run is only valid when that copy matches the tree.
			const { version } = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
			const root = path.join(codexHome(), "plugins", "cache", "thegram-memory", "thegram-memory", version);
			const loaded = { root, hash: await runtimeHash(root) };
			if (mode === "dev" && loaded.hash !== (await runtimeHash(PACKAGE_ROOT))) {
				throw new Error(`codex plugin cache ${root} differs from the working tree; reinstall with codex plugin add thegram-memory@thegram-memory`);
			}
			return { loaded, run: prompt => ({
				cmd: [
					"codex",
					"exec",
					"--enable",
					"hooks",
					// Non-interactive runs cannot answer the hook trust review; a real user trusts once in the TUI.
					"--dangerously-bypass-hook-trust",
					"--dangerously-bypass-approvals-and-sandbox",
					"-o",
					"{OUT}",
					prompt,
				],
			}) };
		},
		async answer(_stdout, outFile) {
			return Bun.file(outFile).text();
		},
	},
	opencode: {
		name: "opencode",
		version: ["opencode", "--version"],
		// The free opencode model can take minutes for one step.
		timeoutMs: 1_500_000,
		async prepare(repo, mode) {
			if (mode === "dev") {
				await mkdir(path.join(repo, ".opencode"), { recursive: true });
				await writeFile(path.join(repo, ".opencode", "opencode.jsonc"), JSON.stringify({ plugins: [PACKAGE_ROOT] }));
			}
			const env = mode === "dev" ? xdg(OC_XDG) : {};
			return { run: prompt => ({
				cmd: ["opencode", "run", "--standalone", "--auto", "-m", "opencode/big-pickle", prompt],
				env,
			}) };
		},
		async answer(stdout) {
			return stdout;
		},
	},
	opencode1: {
		name: "opencode1",
		version: [path.join(OC1_PREFIX, "node_modules", ".bin", "opencode"), "--version"],
		timeoutMs: 1_500_000,
		async prepare(repo) {
			await mkdir(path.join(repo, ".opencode", "plugins"), { recursive: true });
			await writeFile(
				path.join(repo, ".opencode", "plugins", "thegram-memory.ts"),
				`export { default } from ${JSON.stringify(path.join(PACKAGE_ROOT, "src", "opencode.ts"))};\n`,
			);
			return { run: prompt => ({
				cmd: [path.join(OC1_PREFIX, "node_modules", ".bin", "opencode"), "run", "--auto", "-m", "opencode/big-pickle", prompt],
				env: xdg(path.join(OC1_PREFIX, "xdg")),
			}) };
		},
		async answer(stdout) {
			return stdout;
		},
	},
	omp: {
		name: "omp",
		version: ["omp", "--version"],
		async prepare(_repo, mode) {
			const load = mode === "dev" ? ["--no-extensions", "-e", path.join(PACKAGE_ROOT, "src", "omp.ts")] : [];
			return { run: prompt => ({
				cmd: ["omp", "-p", ...load, "--no-session", "--model", "anthropic/claude-opus-5-5", "--thinking", "low", prompt],
			}) };
		},
		async answer(stdout) {
			return stdout.replace(/^Working\.\.\.\n/gm, "");
		},
	},
};

const READ_PROMPT =
	"Do not call any tools and do not read files. Using only the Thegram memory already in your context, reply with the record id of the accepted decision about the cache TTL and nothing else. If no Thegram memory is in your context, reply NONE.";
const WRITE_PROMPT =
	'In this repository create three files: config/retry.json containing {"maxAttempts": 5}, docs/retry.md explaining that retries are capped at 5 attempts with exponential backoff because unlimited retries hid outages, and src/retry.ts exporting const MAX_ATTEMPTS = 5. Then git add those three files and commit them with the message "Cap retries at 5 attempts". Reply with the commit hash.';

async function exec(cmd: string[], cwd: string, env: Record<string, string> = {}, timeoutMs = 600_000) {
	const started = performance.now();
	// opencode takes its working location from PWD, not from the process cwd.
	const proc = Bun.spawn(cmd, {
		cwd,
		env: { ...process.env, PWD: cwd, ...env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const timer = setTimeout(() => proc.kill(), timeoutMs);
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	clearTimeout(timer);
	return { code: proc.exitCode ?? -1, stdout, stderr, ms: Math.round(performance.now() - started) };
}

async function seed(folder: string, marker: string): Promise<{ rev: number }> {
	const created = await callTool("gram_create", {
		path: `${folder}/memory.gram`,
		title: `E2E ${folder}`,
		base_revision: null,
		content: {
			text: `# Overview\n\nScratch project for the thegram-memory E2E.\n\n# Architecture\n\n# Plan\n\n# Decisions\n\n[[${marker}]]\n\n# Log\n`,
			records: [
				{
					type: "decision",
					id: marker,
					fields: {
						t: ["Cache entries live for 47 minutes"],
						d: ["The response cache TTL is 47 minutes because upstream data refreshes hourly."],
						x: ["accepted"],
					},
				},
			],
		},
	});
	const doc = isJson(created.doc) ? created.doc : {};
	return { rev: Number(doc.rev) };
}

async function revisionsAfter(folder: string, rev: number) {
	const changes = await callTool("gram_changes", { path: `${folder}/memory.gram`, since_revision: rev });
	return (Array.isArray(changes.changes) ? changes.changes : []).filter(isJson).map(change => ({
		rev: change.rev,
		by: change.by,
		add: Array.isArray(change.add) ? change.add.map(row => (Array.isArray(row) ? `${row[0]} (${row[1]})` : "")) : [],
		set: Array.isArray(change.set) ? change.set.map(row => (Array.isArray(row) ? String(row[0]) : "")) : [],
	}));
}

async function runAgent(agent: Agent, mode: Mode, folder: string, repo: string) {
	const marker = `dec-cache-ttl-${Math.random().toString(36).slice(2, 8)}`;
	const outFile = path.join(repo, ".agent-last-message");
	await mkdir(repo, { recursive: true });
	await exec(["git", "init", "-q"], repo);
	await exec(["git", "commit", "-q", "--allow-empty", "-m", "init"], repo);
	const version = (await exec(agent.version, repo)).stdout.trim();
	const seeded = await seed(folder, marker);
	const prepared = await agent.prepare(repo, mode);
	const runPrompt = async (prompt: string) => {
		const { cmd, env } = prepared.run(prompt);
		const result = await exec(cmd.map(part => (part === "{OUT}" ? outFile : part)), repo, env, agent.timeoutMs);
		const answer = await agent.answer(result.stdout, outFile).catch(() => result.stdout);
		return { ...result, answer: answer.trim() };
	};
	const read = await runPrompt(READ_PROMPT);
	const readPass = read.answer.includes(marker);
	const afterRead = await revisionsAfter(folder, seeded.rev);
	const write = await runPrompt(WRITE_PROMPT);
	const commits = (await exec(["git", "log", "--format=%H %s"], repo)).stdout.trim().split("\n");
	const revisions = (await revisionsAfter(folder, seeded.rev)).filter(change => !afterRead.some(prev => prev.rev === change.rev));
	const writePass = commits.some(line => line.endsWith("Cap retries at 5 attempts")) && revisions.some(change => change.add.length > 0);
	return {
		agent: agent.name,
		version,
		loaded: prepared.loaded ?? { root: PACKAGE_ROOT, hash: await runtimeHash(PACKAGE_ROOT) },
		folder,
		marker,
		read: { pass: readPass, code: read.code, ms: read.ms, answer: read.answer.slice(-400), stderr: read.stderr.slice(-400) },
		write: {
			pass: writePass,
			code: write.code,
			ms: write.ms,
			commits,
			revisions,
			answer: write.answer.slice(-1200),
			stderr: write.stderr.slice(-400),
		},
		pass: readPass && writePass,
	};
}

const args = process.argv.slice(2);
const mode: Mode = args.includes("--installed") ? "installed" : "dev";
const keep = args.includes("--keep");
const names = args.filter(arg => !arg.startsWith("--"));
const selected = names.length > 0 ? names : Object.keys(AGENTS);
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").toLowerCase();
const projects = await callTool("gram_projects", {});
const vault = str(projects.vault);
if (!vault) throw new Error("Thegram vault is unknown; is the app running?");
const head = (await exec(["git", "rev-parse", "HEAD"], PACKAGE_ROOT)).stdout.trim();
const treeStatus = async () =>
	(await exec(["git", "status", "--porcelain", "--untracked-files=all"], PACKAGE_ROOT)).stdout +
	(await exec(["git", "diff", "HEAD", "--binary"], PACKAGE_ROOT)).stdout;
const tree = await treeStatus();
const dirty = tree.trim().length > 0;

const results: { agent: string; pass: boolean; error?: string }[] = [];
for (const name of selected) {
	const agent = AGENTS[name];
	if (!agent) throw new Error(`unknown agent ${name}`);
	process.stderr.write(`e2e: ${name} (${mode})…\n`);
	const folder = `zz-tgm-e2e-${name}-${stamp}`;
	const repo = path.join(os.tmpdir(), "tgm-e2e", folder);
	try {
		const result = await runAgent(agent, mode, folder, repo);
		process.stderr.write(`e2e: ${name} read=${result.read.pass} write=${result.write.pass}\n`);
		results.push(result);
	} catch (error) {
		process.stderr.write(`e2e: ${name} error ${String(error)}\n`);
		results.push({ agent: name, pass: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
	} finally {
		if (!keep) {
			await rm(path.join(vault, folder), { recursive: true, force: true });
			await rm(repo, { recursive: true, force: true });
		}
	}
	// An agent that escapes its scratch repository could write or commit here; stop before the next one runs.
	const headAfter = (await exec(["git", "rev-parse", "HEAD"], PACKAGE_ROOT)).stdout.trim();
	if (headAfter !== head) throw new Error(`${name} moved this package's HEAD from ${head} to ${headAfter}`);
	if ((await treeStatus()) !== tree) throw new Error(`${name} changed files in ${PACKAGE_ROOT}; see git status`);
}

const artifact = {
	stamp,
	mode,
	package: { root: PACKAGE_ROOT, head, dirty },
	node: process.version,
	vault,
	pass: results.every(result => result.pass),
	results,
};
const file = path.join(PACKAGE_ROOT, "e2e", "artifacts", `${stamp}-${mode}-${selected.join("-")}.json`);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify(artifact, null, "\t")}\n`);
process.stdout.write(`${file}\npass=${artifact.pass}\n`);
process.exitCode = artifact.pass ? 0 : 1;

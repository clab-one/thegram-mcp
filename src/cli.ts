import { readFile, rm } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import * as path from "node:path";
import {
	callTool,
	configDir,
	connectionFile,
	connectionSettings,
	errorCode,
	isJson,
	loadProjectMap,
	PACKAGE_ROOT,
	resolveProject,
	rowsOf,
	saveConnection,
	stateDir,
	str,
	ThegramError,
	validateEndpoint,
} from "./core.ts";
import { runHook } from "./hook.ts";
import { runMcpProxy } from "./mcp-proxy.ts";

const USAGE = `thegram-memory <command>

  connect [--mount <key>] [--url <endpoint>]
                   securely read an API key and choose a Cloud vault
  disconnect       remove this machine's saved credential (does not revoke it)
  mcp              stdio bridge to the Cloud MCP using the API key
  hook             Claude Code / Codex command hook (event JSON on stdin)
  doctor [dir]     check Cloud access and this repository's memory document
  bind [dir]       tag the memory document's project record with this repository so it can be moved into a folder
  version          print the package version`;

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function packageVersion(): Promise<string> {
	const pkg: unknown = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
	return typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "unknown";
}

async function readKey(): Promise<string> {
	if (!process.stdin.isTTY) return (await readStdin()).trim();
	emitKeypressEvents(process.stdin);
	const raw = process.stdin.isRaw;
	process.stdin.setRawMode(true);
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let key = "";
	const cleanup = (): void => {
		process.stdin.off("keypress", onKey);
		process.stdin.setRawMode(raw);
		process.stdin.pause();
		process.stderr.write("\n");
	};
	const onKey = (text: string | undefined, pressed: { name?: string; ctrl?: boolean }): void => {
		if (pressed.ctrl && pressed.name === "c") {
			cleanup();
			reject(new ThegramError("E_INPUT", "Connection cancelled"));
		} else if (pressed.name === "return" || pressed.name === "enter") {
			cleanup();
			resolve(key.trim());
		} else if (pressed.name === "backspace") key = key.slice(0, -1);
		else if (text && !pressed.ctrl) key += text;
	};
	process.stdin.on("keypress", onKey);
	process.stdin.resume();
	process.stderr.write("Thegram API key (input hidden): ");
	return promise;
}

async function connect(args: string[]): Promise<number> {
	let mount: string | undefined;
	let url = "https://vault.thegram.one/mcp";
	for (let i = 0; i < args.length; i += 2) {
		const value = args[i + 1];
		if (!value || !["--mount", "--url"].includes(args[i])) throw new ThegramError("E_CONFIG", "Use connect [--mount <key>] [--url <endpoint>]; provide the API key on stdin");
		if (args[i] === "--mount") mount = value;
		else url = value;
	}
	url = validateEndpoint(url);
	const apiKey = await readKey();
	const previousKey = process.env.THEGRAM_API_KEY;
	const previousURL = process.env.THEGRAM_MCP_URL;
	try {
		process.env.THEGRAM_API_KEY = apiKey;
		process.env.THEGRAM_MCP_URL = url;
		const projects = await callTool("gram_projects", {}, 15_000);
		const mounts = Array.isArray(projects.mounts)
			? projects.mounts.filter(isJson).filter(item => item.kind === "vault")
			: [];
		if (!mount && mounts.length === 1) mount = str(mounts[0].key);
		if (!mount && mounts.length > 1 && process.stdin.isTTY) {
			for (const [i, item] of mounts.entries()) process.stderr.write(`${i + 1}. ${item.name} · ${item.key} · ${item.access}\n`);
			const input = createInterface({ input: process.stdin, output: process.stderr });
			try {
				const selected = Number(await input.question("Choose a Cloud vault number: "));
				if (Number.isInteger(selected) && selected > 0) mount = str(mounts[selected - 1]?.key);
			} finally {
				input.close();
			}
		}
		if (!mount || !mounts.some(item => item.key === mount)) {
			const choices = mounts.map(item => `${item.name}: ${item.key}`).join("\n");
			throw new ThegramError("E_CONFIG", `Choose an accessible Cloud vault with --mount. Available vaults:\n${choices || "(none; grant this API key access in Thegram Settings → Agents)"}`);
		}
		await saveConnection({ url, apiKey, mount });
		process.stdout.write(`Connected to ${url}\nCloud vault: ${mount}\nCredential: ${connectionFile()} (private)\n`);
		return 0;
	} finally {
		if (previousKey === undefined) delete process.env.THEGRAM_API_KEY;
		else process.env.THEGRAM_API_KEY = previousKey;
		if (previousURL === undefined) delete process.env.THEGRAM_MCP_URL;
		else process.env.THEGRAM_MCP_URL = previousURL;
	}
}

async function doctor(dir: string): Promise<number> {
	const lines = [`thegram-memory ${await packageVersion()} · node ${process.version}`];
	let failed = false;
	try {
		const settings = await connectionSettings();
		lines.push(`endpoint: ${settings.url}`);
		const projects = await callTool("gram_projects", {});
		const mounts = Array.isArray(projects.mounts) ? projects.mounts.filter(isJson) : [];
		lines.push(`Cloud: ${mounts.length} accessible mounts · selected ${settings.mount ?? "(not configured)"}`);
		if (settings.mount && !mounts.some(item => item.key === settings.mount && item.kind === "vault")) {
			throw new ThegramError("E_FORBIDDEN", "The selected Cloud vault is not accessible to this API key");
		}
		const binding = await resolveProject(dir);
		if (!binding) lines.push(`project: none for ${dir} (not a git repository and no mapping)`);
		else {
			const via = binding.via === "repository" ? `bound by ${binding.tag}` : binding.via === "mapping" ? "projects.json mapping" : "root path only (run bind before moving it into a folder)";
			try {
				const brief = await callTool("gram_brief", { path: binding.path });
				const docs = Array.isArray(brief.docs) ? brief.docs.length : 0;
				lines.push(`project: ${binding.path} · ${docs} memory document · ${via}`);
			} catch (error) {
				if (errorCode(error) !== "E_NOT_FOUND") throw error;
				lines.push(`project: ${binding.path} · not created yet · ${via}`);
			}
			if (binding.others?.length) lines.push(`warning: ${binding.tag} is also on ${binding.others.join(", ")}`);
		}
	} catch (error) {
		failed = true;
		lines.push(`Cloud: unavailable (${errorCode(error)}: ${error instanceof Error ? error.message : String(error)})`);
	}
	const mapped = Object.keys(await loadProjectMap()).length;
	const localPolicy = await readFile(path.join(configDir(), "policy.md"), "utf8").then(
		() => "present",
		() => "absent",
	);
	lines.push(`config: ${configDir()} · ${mapped} mapped directories · local policy ${localPolicy}`);
	lines.push(`hook state: ${stateDir()}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	return failed ? 1 : 0;
}

async function bind(args: string[]): Promise<number> {
	const projectFlag = args.indexOf("--project");
	const chosen = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
	const dirArg = projectFlag >= 0 ? args.filter((_, index) => index !== projectFlag && index !== projectFlag + 1)[0] : args[0];
	const dir = path.resolve(dirArg ?? process.cwd());
	const binding = await resolveProject(dir);
	if (!binding) throw new ThegramError("E_CONFIG", `${dir} is not a Git repository and has no mapping`);
	if (!binding.tag) throw new ThegramError("E_CONFIG", "This repository has no origin remote; map it in projects.json instead");
	if (binding.via === "repository") {
		process.stdout.write(`${binding.path}#${binding.projectId} already carries ${binding.tag}\n`);
		return 0;
	}
	const listed = await callTool("gram_list", { path: binding.path, select: { type: "project" } });
	const ids = rowsOf(listed.records).map(row => String(row[0]).slice(String(row[0]).lastIndexOf("#") + 1));
	if (ids.length === 0) throw new ThegramError("E_NOT_FOUND", `${binding.path} has no project record yet; it is tagged when it is created`);
	const project = chosen ?? (ids.length === 1 ? ids[0] : undefined);
	if (!project || !ids.includes(project)) {
		throw new ThegramError("E_ARGUMENT", `Choose the root project record with --project: ${ids.join(", ")}`);
	}
	const context = await callTool("gram_context", { ids: [{ path: binding.path, entity: project }], fields: ["tag"] });
	const item = Array.isArray(context.items) ? context.items.find(isJson) : undefined;
	const fields = item && isJson(item.fields) ? item.fields : {};
	const tags = Array.isArray(fields.tag) ? fields.tag.map(String) : [];
	if (tags.includes(binding.tag)) {
		process.stdout.write(`${binding.path}#${project} already carries ${binding.tag}\n`);
		return 0;
	}
	const written = await callTool("gram_patch", {
		path: binding.path,
		request_id: `bind-${project}-${binding.tag}`.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 120),
		operations: [{ op: "set", entity: project, key: "tag", values: [...tags, binding.tag], old: tags.length ? tags : null }],
	});
	const doc = isJson(written.doc) ? written.doc : {};
	process.stdout.write(`${binding.path}#${project} now carries ${binding.tag} (r${String(doc.rev)}); the document can be moved into a folder.\n`);
	return 0;
}

async function main(): Promise<number> {
	const [command, ...args] = process.argv.slice(2);
	switch (command) {
		case "connect":
			return connect(args);
		case "disconnect":
			await rm(connectionFile(), { force: true });
			process.stdout.write("Saved credential removed. Revoke the key in Thegram Settings → Agents if it should no longer work anywhere.\n");
			return 0;
		case "mcp":
			await runMcpProxy();
			return 0;
		case "hook":
			try {
				process.stdout.write(await runHook(await readStdin()));
			} catch (error) {
				process.stderr.write(`thegram-memory hook: ${error instanceof Error ? error.message : String(error)}\n`);
			}
			return 0;
		case "doctor":
			return doctor(path.resolve(args[0] ?? process.cwd()));
		case "bind":
			return bind(args);
		case "version":
			process.stdout.write(`${await packageVersion()}\n`);
			return 0;
		default:
			process.stdout.write(`${USAGE}\n`);
			return command ? 1 : 0;
	}
}

try {
	process.exitCode = await main();
} catch (error) {
	process.stderr.write(`thegram-memory: ${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

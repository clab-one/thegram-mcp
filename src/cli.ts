import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import * as path from "node:path";
import {
	callTool,
	configDir,
	connectionFile,
	connectionSettings,
	errorCode,
	isJson,
	PACKAGE_ROOT,
	repositoryLookup,
	repositoryId,
	repositoryTag,
	resolveProject,
	rowsOf,
	saveConnection,
	stateDir,
	ThegramError,
	validateEndpoint,
} from "./core.ts";
import { runHook } from "./hook.ts";
import { runMcpProxy } from "./mcp-proxy.ts";

const USAGE = `thegram-memory <command>

  connect [--url <endpoint>] securely save and verify an API key
  disconnect       remove this machine's saved credential (does not revoke it)
  mcp              stdio bridge to the Cloud MCP using the API key
  hook             Claude Code / Codex command hook (event JSON on stdin)
  doctor [dir]     check Cloud access and this repository's memory document
  bind --document <path> [--project <id>] [--repository <host/path>] [dir]
                   associate an existing project record with this repository
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
	let url = "https://vault.thegram.one/mcp";
	for (let i = 0; i < args.length; i += 2) {
		if (args[i] !== "--url" || !args[i + 1]) throw new ThegramError("E_CONFIG", "Use connect [--url <endpoint>]; provide the API key on stdin");
		url = args[i + 1];
	}
	url = validateEndpoint(url);
	const apiKey = await readKey();
	const previousKey = process.env.THEGRAM_API_KEY;
	const previousURL = process.env.THEGRAM_MCP_URL;
	try {
		process.env.THEGRAM_API_KEY = apiKey;
		process.env.THEGRAM_MCP_URL = url;
		await callTool("gram_projects", {}, 15_000);
		await saveConnection({ url, apiKey });
		process.stdout.write(`Connected to ${url}\nCredential: ${connectionFile()} (private)\n`);
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
		const binding = await resolveProject(dir);
		const brief = await callTool("gram_brief", { path: binding.path });
		const docs = Array.isArray(brief.docs) ? brief.docs.length : 0;
		lines.push(`project: ${binding.path} · ${docs} memory document · bound by ${binding.tag}`);
	} catch (error) {
		failed = true;
		lines.push(`Cloud/project: unavailable (${errorCode(error)}: ${error instanceof Error ? error.message : String(error)})`);
	}
	const localPolicy = await readFile(path.join(configDir(), "policy.md"), "utf8").then(() => "present", () => "absent");
	lines.push(`config: ${configDir()} · local policy ${localPolicy}`);
	lines.push(`hook state: ${stateDir()}`);
	process.stdout.write(`${lines.join("\n")}\n`);
	return failed ? 1 : 0;
}

async function bind(args: string[]): Promise<number> {
	let document: string | undefined;
	let project: string | undefined;
	let explicitRepo: string | undefined;
	let directory: string | undefined;
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("--")) {
			if (!["--document", "--project", "--repository"].includes(arg) || seen.has(arg)) {
				throw new ThegramError("E_ARGUMENT", `Unknown or repeated bind option: ${arg}`);
			}
			seen.add(arg);
			const value = args[++index];
			if (!value || value.startsWith("--")) throw new ThegramError("E_ARGUMENT", `${arg} requires a value`);
			if (arg === "--document") document = value;
			else if (arg === "--project") project = value;
			else explicitRepo = value;
		} else if (directory === undefined) directory = arg;
		else throw new ThegramError("E_ARGUMENT", "bind accepts at most one repository directory");
	}
	const documentParts = document?.split("/") ?? [];
	if (
		!document ||
		documentParts.length < 3 ||
		documentParts[0] !== "@mounts" ||
		!/^[A-Za-z0-9_-]+$/.test(documentParts[1]) ||
		!documentParts.slice(2).every(part => part && part.trim() === part && part !== "." && part !== ".." && !/[\u0000-\u001f]/.test(part)) ||
		!/^[^.].*\.gram$/.test(documentParts[documentParts.length - 1])
	) {
		throw new ThegramError("E_ARGUMENT", "bind requires --document @mounts/<vault-id>/<existing-document>.gram");
	}
	const cwd = path.resolve(directory ?? process.cwd());
	let identity: string | undefined;
	if (explicitRepo) {
		const candidate = explicitRepo.includes("://") || /^[^@\s]+@[^:/\s]+:/.test(explicitRepo)
			? explicitRepo
			: `https://${explicitRepo}`;
		identity = repositoryId(candidate);
	} else {
		identity = (await repositoryTag(cwd)).slice("repo:".length);
	}
	if (!identity || identity.split("/").length < 3 || identity.split("/").some(part => !part || /[\s:@]/.test(part))) {
		throw new ThegramError("E_ARGUMENT", "Use an exact repository identity such as --repository host/group/subgroup/repository.");
	}
	const tag = `repo:${identity}`;
	const deadline = Date.now() + 15_000;
	const remaining = (): number => {
		const milliseconds = deadline - Date.now();
		if (milliseconds <= 0) throw new ThegramError("E_TIMEOUT", "Project binding exceeded its time budget");
		return milliseconds;
	};
	const { claims, vaults } = await repositoryLookup(tag, deadline);
	const mount = vaults.get(document.split("/").slice(0, 2).join("/"));
	if (!mount) throw new ThegramError("E_PROJECT_DESTINATION", "bind requires an accessible Vault document, not another storage provider");
	if (mount.access !== "write") throw new ThegramError("E_READ_ONLY", "bind requires write access to the target Vault");
	let cursor: unknown;
	const ids = new Set<string>();
	do {
		if (deadline <= Date.now()) throw new ThegramError("E_TIMEOUT", "Project record lookup exceeded its time budget");
		const listed = await callTool(
			"gram_list",
			{ path: document, select: { type: "project" }, limit: 100, ...(cursor === undefined ? {} : { cursor }) },
			remaining(),
		);
		for (const row of rowsOf(listed.records)) {
			const ref = String(row[0]);
			const at = ref.lastIndexOf("#");
			if (ref) ids.add(at >= 0 ? ref.slice(at + 1) : ref);
		}
		cursor = listed.more;
	} while (cursor !== undefined && cursor !== null && cursor !== "");
	const chosen = project ?? (ids.size === 1 ? ids.values().next().value : undefined);
	if (!chosen || !ids.has(chosen)) throw new ThegramError("E_ARGUMENT", `Choose a project record with --project: ${[...ids].join(", ") || "(none)"}`);
	const targetRef = `${document}#${chosen}`;
	if (claims.size > 0) {
		if (claims.size === 1 && claims.has(targetRef)) {
			process.stdout.write(`${targetRef} already carries ${tag}\n`);
			return 0;
		}
		throw new ThegramError("E_PROJECT_AMBIGUOUS", `Repository tag ${tag} already belongs to ${[...claims.keys()].join(", ")}; resolve that association before binding another project record.`);
	}
	const context = await callTool("gram_context", { ids: [{ path: document, entity: chosen }], fields: ["tag"] }, remaining());
	const item = Array.isArray(context.items) ? context.items.find(isJson) : undefined;
	const fields = item && isJson(item.fields) ? item.fields : {};
	const tags = Array.isArray(fields.tag) ? fields.tag.map(String) : [];
	if (tags.includes(tag)) {
		process.stdout.write(`${targetRef} already carries ${tag}\n`);
		return 0;
	}
	const written = await callTool("gram_patch", {
		path: document,
		request_id: `bind-${randomUUID()}`,
		operations: [{ op: "set", entity: chosen, key: "tag", values: [...tags, tag], old: tags.length ? tags : null }],
	}, remaining());
	const doc = isJson(written.doc) ? written.doc : {};
	process.stdout.write(`${document}#${chosen} now carries ${tag} (r${String(doc.rev)}).\n`);
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

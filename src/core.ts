import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI_PATH = path.join(PACKAGE_ROOT, "dist", "thegram-memory.mjs");
export const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");

const TOOL_PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 3_000;
const RECALL_TIMEOUT_MS = 8_000;
const BRIEF_TIMEOUT_MS = 8_000;
const ORIENT_BUDGET_MS = 15_000;
const MIN_RECALL_WAIT_MS = 2_000;
const MIN_RECALL_CHARS = 15;
const RECALL_QUERY_CHARS = 400;
const MAX_OPEN = 15;
const MAX_HITS = 5;
const OPEN_TYPES = ["blocker", "risk", "task", "decision", "requirement", "assumption", "goal"] as const;
const OPEN_FIRST_PASS = 5;
const MAX_CHANGES = 8;
const MAX_MEMORY_CHARS = 6_000;
const NUDGE_MUTATIONS = 3;
const MAX_OWN_REVISIONS = 50;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = ORIENT_BUDGET_MS + 5_000;

const THEGRAM_WRITE = /thegram.*gram_(?:patch|create)$/;
const MUTATING_TOOL = /^(?:edit|write|multiedit|notebookedit|apply_patch|patch|ast_edit)$/i;
const GIT_COMMIT = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+commit\b/;
const SHIP_COMMAND =
	/\b(?:git\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+push|gh\s+(?:release\s+create|pr\s+(?:create|merge))|kubectl\b[^\n;&|]*\s(?:apply|rollout\s+restart|set\s+image|patch)|helm\s+(?:upgrade|install|rollback)|(?:npm|pnpm|yarn|bun)\s+publish|docker\s+push)\b/;
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File:/gm;

export type Json = Record<string, unknown>;
type Row = unknown[];

export class ThegramError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function isJson(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function errorCode(error: unknown): string {
	return error instanceof ThegramError ? error.code : "E_UNKNOWN";
}

function rowsOf(value: unknown): Row[] {
	return Array.isArray(value) ? value.filter((row): row is Row => Array.isArray(row)) : [];
}

function listOf(value: unknown): Json[] {
	return Array.isArray(value) ? value.filter(isJson) : [];
}

function clip(text: unknown, max: number): string {
	const value = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function clipBlock(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function readJsonFile(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

export interface ConnectionSettings {
	url: string;
	apiKey: string;
	mount?: string;
}

export function connectionFile(): string {
	return path.join(configDir(), "connection.json");
}

export function validateEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ThegramError("E_CONFIG", "Thegram MCP URL is invalid");
	}
	const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
		throw new ThegramError("E_CONFIG", "Use an HTTPS /mcp endpoint; HTTP is allowed only on loopback for local verification");
	}
	return url.href;
}

export async function connectionSettings(): Promise<ConnectionSettings> {
	const file = connectionFile();
	const stored = await readJsonFile(file);
	const saved = isJson(stored) ? stored : {};
	const envKey = process.env.THEGRAM_API_KEY;
	if (!envKey && typeof saved.apiKey === "string" && process.platform !== "win32") {
		const info = await stat(file);
		if ((info.mode & 0o077) !== 0) throw new ThegramError("E_CONFIG", `Restrict ${file} to mode 0600 before connecting`);
	}
	const apiKey = envKey ?? str(saved.apiKey);
	if (!apiKey) throw new ThegramError("E_AUTH", "Connect Thegram with an API key: node dist/thegram-memory.mjs connect");
	if (!apiKey.startsWith("tgk_") || /\s/.test(apiKey)) throw new ThegramError("E_AUTH", "Use an API key issued in Thegram Settings → Agents");
	const savedURL = str(saved.url) ?? "https://vault.thegram.one/mcp";
	const url = validateEndpoint(process.env.THEGRAM_MCP_URL ?? savedURL);
	if (!envKey && process.env.THEGRAM_MCP_URL && url !== validateEndpoint(savedURL)) {
		throw new ThegramError("E_CONFIG", "Reconnect explicitly before using a stored API key with a different endpoint");
	}
	const mount = process.env.THEGRAM_MCP_MOUNT ?? str(saved.mount);
	if (mount !== undefined && !/^@mounts\/[A-Za-z0-9_-]+$/.test(mount)) {
		throw new ThegramError("E_CONFIG", "Select the exact Cloud vault mount key from gram_projects");
	}
	return { url, apiKey, mount };
}

export async function saveConnection(settings: ConnectionSettings): Promise<void> {
	const dir = configDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(dir, 0o700);
	const temp = `${connectionFile()}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(settings) + "\n", { mode: 0o600, flag: "wx" });
		await rename(temp, connectionFile());
	} finally {
		await rm(temp, { force: true });
	}
}

export async function connectionId(): Promise<string> {
	const settings = await connectionSettings();
	return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

export interface McpResponse {
	status: number;
	sessionId?: string;
	contentType: string;
	body: string;
}

export async function postMcp(body: string, headers: Record<string, string>, timeoutMs: number): Promise<McpResponse> {
	const settings = await connectionSettings();
	try {
		const response = await fetch(settings.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				...headers,
				Authorization: `Bearer ${settings.apiKey}`,
			},
			body,
			redirect: "error",
			signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
		});
		if (response.status === 401) throw new ThegramError("E_AUTH", "Thegram API key is invalid, expired or revoked; reconnect with a new key");
		if (response.status === 403) throw new ThegramError("E_FORBIDDEN", "The API key does not permit this Thegram operation");
		return {
			status: response.status,
			sessionId: response.headers.get("mcp-session-id") ?? undefined,
			contentType: response.headers.get("content-type") ?? "",
			body: await response.text(),
		};
	} catch (error) {
		if (error instanceof ThegramError) throw error;
		if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
			throw new ThegramError("E_TIMEOUT", `Thegram did not answer within ${timeoutMs} ms`);
		}
		throw new ThegramError("E_CONNECT", "Thegram Cloud MCP is unreachable; check the endpoint and network");
	}
}

export function parseMcpMessages(response: McpResponse): unknown[] {
	if (!response.body.trim()) return [];
	if (!response.contentType.includes("text/event-stream")) return [JSON.parse(response.body)];
	const messages: unknown[] = [];
	for (const event of response.body.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter(line => line.startsWith("data:"))
			.map(line => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data) messages.push(JSON.parse(data));
	}
	return messages;
}

export async function callTool(name: string, args: Json, timeoutMs = CALL_TIMEOUT_MS): Promise<Json> {
	const response = await postMcp(
		JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		{ "MCP-Protocol-Version": TOOL_PROTOCOL_VERSION },
		timeoutMs,
	);
	let message: unknown;
	try {
		message = parseMcpMessages(response).find(item => isJson(item) && item.id === 1);
	} catch {
		throw new ThegramError("E_RPC", `Thegram answered HTTP ${response.status} with an unreadable body`);
	}
	if (!isJson(message)) throw new ThegramError("E_RPC", `Thegram answered HTTP ${response.status} without a result`);
	if (isJson(message.error)) {
		throw new ThegramError(String(message.error.code ?? "E_RPC"), String(message.error.message ?? ""));
	}
	const result = isJson(message.result) ? message.result : {};
	let out: unknown = result.structuredContent;
	if (out === undefined) {
		const text = listOf(result.content).find(part => part.type === "text")?.text;
		out = typeof text === "string" ? JSON.parse(text) : {};
	}
	if (!isJson(out)) throw new ThegramError("E_TOOL", "Thegram tool answered a non-object");
	if (isJson(out.error)) throw new ThegramError(String(out.error.code ?? "E_TOOL"), String(out.error.message ?? ""));
	return out;
}

export function configDir(): string {
	return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "thegram-memory");
}

function expandHome(value: string): string {
	return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

export async function loadProjectMap(): Promise<Record<string, string>> {
	const raw = await readJsonFile(path.join(configDir(), "projects.json"));
	const map: Record<string, string> = {};
	if (!isJson(raw)) return map;
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") map[path.resolve(expandHome(key))] = value;
	}
	return map;
}

function mappedFolder(map: Record<string, string>, dir: string): string | undefined {
	let best: string | undefined;
	for (const root of Object.keys(map)) {
		if ((dir === root || dir.startsWith(root + path.sep)) && (!best || root.length > best.length)) best = root;
	}
	return best ? map[best] : undefined;
}

function gitCommonDir(dir: string): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	execFile(
		"git",
		["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ timeout: CALL_TIMEOUT_MS },
		(error, stdout) => resolve(error ? undefined : stdout.trim() || undefined),
	);
	return promise;
}

function gitOutput(dir: string, args: string[]): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	execFile("git", ["-C", dir, ...args], { timeout: CALL_TIMEOUT_MS }, (error, stdout) =>
		resolve(error ? undefined : stdout.trim() || undefined),
	);
	return promise;
}

/** Repository name to tag records with when this repository writes into a document it shares with others. */
export async function repositoryScope(cwd: string, documentPath: string): Promise<string | undefined> {
	const root = await gitOutput(path.resolve(cwd), ["rev-parse", "--show-toplevel"]);
	if (!root) return;
	const remote = await gitOutput(root, ["remote", "get-url", "origin"]);
	const name = remote ? path.basename(remote.replace(/\/+$/, ""), ".git").replace(/^.*:/, "") : path.basename(root);
	return path.basename(documentPath, ".gram") === name ? undefined : name;
}

export async function resolveProject(cwd: string): Promise<string | null> {
	const map = await loadProjectMap();
	const dir = path.resolve(cwd);
	const real = await realpath(dir).catch(() => dir);
	const common = await gitCommonDir(dir);
	const root = common ? (path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "")) : undefined;
	const mapped = mappedFolder(map, dir) ?? mappedFolder(map, real) ?? (root && mappedFolder(map, root));
	if (mapped) {
		if (!/^@mounts\/[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9_-]{0,95}\.gram$/.test(mapped)) {
			throw new ThegramError("E_CONFIG", "Project mappings must name an exact Cloud document: @mounts/<vault-id>/<project>.gram");
		}
		return mapped;
	}
	if (!root) return null;
	const { mount } = await connectionSettings();
	if (!mount) throw new ThegramError("E_CONFIG", "Select a Cloud vault with the connect command or THEGRAM_MCP_MOUNT");
	const name = path.basename(root);
	const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name)
		? name
		: `${name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 80) || "project"}-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
	return `${mount}/${safe}.gram`;
}

export async function loadPolicy(): Promise<string> {
	const base = (await readFile(path.join(PACKAGE_ROOT, "policy.md"), "utf8")).trim();
	const local = (await readFile(path.join(configDir(), "policy.md"), "utf8").catch(() => "")).trim();
	return local ? `${base}\n\n## Local rules\n\n${local}` : base;
}

export interface TurnState {
	mutations: number;
	committed: boolean;
	shipped?: boolean;
	wrote: boolean;
	nudged: boolean;
	stopped?: boolean;
}

export interface MemoryState {
	documentPath?: string | null;
	connection?: string;
	vault?: string;
	writable?: boolean;
	exists: boolean;
	available: boolean;
	next?: string;
	projectId?: string;
	scope?: string;
	needBrief: boolean;
	pendingRecall: boolean;
	briefRefs: string[];
	unavailableNoticed: boolean;
	ownRevisions: string[];
	turn: TurnState;
}

export function newTurn(): TurnState {
	return { mutations: 0, committed: false, wrote: false, nudged: false };
}

export function newMemoryState(): MemoryState {
	return {
		exists: false,
		available: true,
		needBrief: true,
		pendingRecall: false,
		briefRefs: [],
		unavailableNoticed: false,
		ownRevisions: [],
		turn: newTurn(),
	};
}

export function resetMemoryState(state: MemoryState): void {
	delete state.documentPath;
	delete state.connection;
	delete state.vault;
	delete state.writable;
	delete state.next;
	delete state.projectId;
	delete state.scope;
	Object.assign(state, newMemoryState());
}

export interface Orientation {
	project: string;
	policy?: string;
	sections: string[];
	recalled: boolean;
}

function renderBrief(
	name: string,
	vault: string | undefined,
	brief: Json,
	refs: string[],
	projectId: string | undefined,
	scope: string | undefined,
): string {
	const docs = rowsOf(brief.docs);
	const lines = [`Project memory \`${name}\` in Thegram Cloud${vault ? ` (\`${vault}\`)` : ""}.`];
	if (docs.length === 1) {
		const [docPath, , rev, hash, recorded] = docs[0];
		const newest = rowsOf(brief.recent).find(row => row[0] === docPath && row[1] === rev);
		lines[0] += ` · ${docPath} r${rev} · ${hash} · last write ${recorded} by ${String(newest?.[4] ?? "unknown")}`;
	} else if (docs.length > 1) {
		lines.push("Documents:");
		for (const [docPath, title, rev, hash, recorded] of docs) {
			lines.push("- " + docPath + " · r" + rev + " · " + hash + " · " + recorded + " — " + clip(title, 80));
		}
	}
	const counts = isJson(brief.counts) ? Object.entries(brief.counts).map(([type, count]) => type + " " + count).join(", ") : "";
	if (counts) lines.push("Records: " + counts + ".");
	lines.push(
		projectId
			? `Root project record: \`${projectId}\`. Link every new record into it: decisions, components and goals part-of it; events implements the decision they carry out (else part-of); tasks, risks and blockers related to what they concern.`
			: "This document has no project record. With your first write, add one (type project, x active) placed in Overview and link new records to it.",
	);
	if (scope) lines.push(`Other repositories share this document: give every record you add "s": ["${scope}"].`);
	const open = rowsOf(brief.open);
	const total = open.length + (typeof brief.open_omitted === "number" ? brief.open_omitted : 0);
	if (total > 0) {
		const rank = (row: Row): number => {
			const index = OPEN_TYPES.indexOf(String(row[1]) as (typeof OPEN_TYPES)[number]);
			return index < 0 ? OPEN_TYPES.length : index;
		};
		const ordered = [...open].sort((a, b) => rank(a) - rank(b));
		const shown = new Set<Row>();
		for (const perType of [OPEN_FIRST_PASS, MAX_OPEN]) {
			const taken = new Map<string, number>();
			for (const row of shown) taken.set(String(row[1]), (taken.get(String(row[1])) ?? 0) + 1);
			for (const row of ordered) {
				if (shown.size >= MAX_OPEN) break;
				const type = String(row[1]);
				if (shown.has(row) || (taken.get(type) ?? 0) >= perType) continue;
				shown.add(row);
				taken.set(type, (taken.get(type) ?? 0) + 1);
			}
		}
		lines.push(`Open records (${shown.size} of ${total}):`);
		for (const row of ordered) {
			if (!shown.has(row)) continue;
			const [ref, type, title, status, priority] = row;
			const fullRef = String(ref);
			refs.push(fullRef);
			const displayRef = docs.length === 1 ? fullRef.slice(fullRef.lastIndexOf("#") + 1) : fullRef;
			lines.push(`- ${displayRef} · ${type} · ${status ?? "-"}${priority ? ` · ${priority}` : ""} · ${clip(title, 120)}`);
		}
		if (total > shown.size) {
			const omitted = new Map<string, number>();
			for (const row of ordered) if (!shown.has(row)) omitted.set(String(row[1]), (omitted.get(String(row[1])) ?? 0) + 1);
			const parts = [...omitted].map(([type, count]) => `${type} ${count}`);
			if (total > open.length) parts.push(`${total - open.length} trimmed by the app`);
			lines.push(`Not shown: ${parts.join(", ")} — list with gram_list {path, select: {type, status}}.`);
		}
	}
	return lines.join("\n");
}

function renderChanges(changes: Json[], own: string[]): string | undefined {
	const lines: string[] = [];
	for (const change of changes) {
		if (own.includes(`${change.path}@${change.rev}`)) continue;
		const parts = [
			...rowsOf(change.add).map(row => `+${row[0]} (${row[1]}) ${clip(row[2], 60)}`),
			...rowsOf(change.set).map(row => `~${row[0]} [${Array.isArray(row[2]) ? row[2].join(",") : ""}]`),
			...rowsOf(change.del).map(row => `-${row[0]}`),
		];
		lines.push(`- ${change.path} r${change.rev} · ${change.at} · ${change.by}: ${clip(parts.join("; "), 300)}`);
		if (lines.length >= MAX_CHANGES) break;
	}
	return lines.length > 0 ? `Changed by other writers since your last look:\n${lines.join("\n")}` : undefined;
}

function renderHits(hits: Row[], seen: string[]): string | undefined {
	const lines: string[] = [];
	for (const [ref, type, title, status, summary] of hits) {
		if (lines.length >= MAX_HITS) break;
		if (type === "document" || seen.includes(String(ref))) continue;
		lines.push(`- ${ref} · ${type} · ${status ?? "-"} · ${clip(title, 100)}${summary ? ` — ${clip(summary, 200)}` : ""}`);
	}
	return lines.length > 0 ? `Recalled for the opening prompt:\n${lines.join("\n")}` : undefined;
}

export async function orient(state: MemoryState, cwd: string, prompt?: string): Promise<Orientation | undefined> {
	let name = state.documentPath ?? path.basename(cwd);
	const deadline = Date.now() + ORIENT_BUDGET_MS;
	const left = (cap: number): number => Math.max(0, Math.min(cap, deadline - Date.now()));
	try {
		const connection = await connectionId();
		const documentPath = await resolveProject(cwd);
		if (state.connection !== connection || state.documentPath !== documentPath) {
			resetMemoryState(state);
			state.connection = connection;
			state.documentPath = documentPath;
		}
		if (!documentPath) return;
		name = documentPath;
		const projects = await callTool("gram_projects", {}, left(CALL_TIMEOUT_MS));
		const mountKey = name.slice(0, name.lastIndexOf("/"));
		const mount = listOf(projects.mounts).find(item => item.key === mountKey && item.kind === "vault");
		if (!mount) throw new ThegramError("E_FORBIDDEN", "The selected Cloud vault is not accessible to this API key");
		state.vault = str(mount.name);
		state.writable = mount.access === "write";
		state.available = true;
		state.unavailableNoticed = false;

		const sections: string[] = [];
		let policy: string | undefined;
		if (state.needBrief || !state.next || !state.exists) {
			let brief: Json;
			const roots = callTool("gram_list", { path: name, select: { type: "project" } }, left(CALL_TIMEOUT_MS)).catch(
				() => undefined,
			);
			try {
				brief = await callTool("gram_brief", { path: name }, left(BRIEF_TIMEOUT_MS));
			} catch (error) {
				if (errorCode(error) !== "E_NOT_FOUND") throw error;
				const firstNotice = state.needBrief || state.exists;
				state.exists = false;
				state.needBrief = false;
				if (!firstNotice) return;
				return {
					project: name,
					policy: await loadPolicy(),
					recalled: false,
					sections: [
						state.writable
							? `No Cloud memory document \`${name}\` exists yet. When this work produces a durable outcome, create that exact path in one gram_create with a root project record and that outcome placed in its section, in the user's language: {"path":"${name}","title":"…","base_revision":null,"template":"project@1","content":{"text":"# Overview\\n\\n[[prj-<slug>]]\\n\\n# Architecture\\n\\n# Plan\\n\\n# Decisions\\n\\n# Log\\n","fields":{"d":["<one-line summary>"]},"records":[{"type":"project","id":"prj-<slug>","fields":{"t":["…"],"d":["…"],"x":["active"]}}]}}. Each further record is placed as [[id]] alone on a line in its section and linked to prj-<slug>. Do not create a folder or switch to another mount.`
							: `Cloud memory document \`${name}\` does not exist and this API key is read-only. Do not create it or switch to another destination.`,
					],
				};
			}
			state.exists = true;
			state.next = str(brief.next);
			state.needBrief = false;
			state.pendingRecall = true;
			state.briefRefs = [];
			const root = rowsOf((await roots)?.records).find(row => row[1] === "project");
			state.projectId = root ? String(root[0]) : undefined;
			state.scope = await repositoryScope(cwd, name);
			policy = await loadPolicy();
			sections.push(renderBrief(name, state.vault, brief, state.briefRefs, state.projectId, state.scope));
			if (!state.writable) sections.push("This API key is read-only. Do not attempt writes.");
		} else {
			const delta = await callTool("gram_changes", { path: name, since: state.next }, left(BRIEF_TIMEOUT_MS));
			state.next = str(delta.next) ?? state.next;
			const rendered = renderChanges(listOf(delta.changes), state.ownRevisions);
			if (rendered) sections.push(rendered);
		}
		let recalled = false;
		const query = prompt?.trim() ?? "";
		if (state.pendingRecall && query.length >= MIN_RECALL_CHARS && left(RECALL_TIMEOUT_MS) >= MIN_RECALL_WAIT_MS) {
			state.pendingRecall = false;
			const recall = await callTool(
				"gram_recall",
				{ query: query.slice(0, RECALL_QUERY_CHARS), documents: [name], top_k: MAX_HITS * 2 },
				left(RECALL_TIMEOUT_MS),
			).catch(() => undefined);
			const rendered = recall && renderHits(rowsOf(recall.hits), state.briefRefs);
			if (rendered) {
				sections.push(rendered);
				recalled = true;
			}
		}
		if (!policy && sections.length === 0) return;
		return { project: name, policy, sections, recalled };
	} catch (error) {
		state.available = false;
		if (state.unavailableNoticed) return;
		state.unavailableNoticed = true;
		return {
			project: name,
			recalled: false,
			sections: [
				`Thegram Cloud memory could not be loaded (${errorCode(error)}). Treat project memory as unknown. Check the API key and selected vault; do not switch storage or claim successful writes.`,
			],
		};
	}
}

export function renderOrientation(orientation: Orientation, maxChars = Number.POSITIVE_INFINITY): string {
	const parts: string[] = [];
	if (orientation.policy) parts.push(`<thegram-memory-policy>\n${orientation.policy}\n</thegram-memory-policy>`);
	if (orientation.sections.length > 0) {
		const open = `<thegram-memory project="${orientation.project}">\n`;
		const close = "\n</thegram-memory>";
		const used = parts.reduce((sum, part) => sum + part.length + 2, 0) + open.length + close.length;
		const budget = Math.min(MAX_MEMORY_CHARS, maxChars - used);
		if (budget > 200) parts.push(`${open}${clipBlock(orientation.sections.join("\n\n"), budget)}${close}`);
	}
	return parts.join("\n\n");
}

export interface ToolObservation {
	name: string;
	input: unknown;
	output?: unknown;
	isError?: boolean;
}

function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
	if (depth > 6) return out;
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) {
		if (value.every(item => typeof item === "string")) out.push(value.join(" "));
		for (const item of value) stringsOf(item, out, depth + 1);
	} else if (isJson(value)) {
		for (const item of Object.values(value)) stringsOf(item, out, depth + 1);
	}
	return out;
}

function findDoc(value: unknown, depth = 0): { path: string; rev: number } | undefined {
	if (depth > 6) return;
	if (typeof value === "string") {
		if (!value.includes('"doc"')) return;
		try {
			return findDoc(JSON.parse(value), depth + 1);
		} catch {
			return;
		}
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const doc = findDoc(item, depth + 1);
			if (doc) return doc;
		}
		return;
	}
	if (!isJson(value)) return;
	const doc = value.doc;
	if (isJson(doc) && typeof doc.path === "string" && typeof doc.rev === "number") return { path: doc.path, rev: doc.rev };
	for (const item of Object.values(value)) {
		const found = findDoc(item, depth + 1);
		if (found) return found;
	}
}

export function observeTool(state: MemoryState, call: ToolObservation): string | undefined {
	if (call.isError) return;
	if (THEGRAM_WRITE.test(call.name)) {
		const doc = findDoc(call.output);
		if (!doc) return;
		state.turn.wrote = true;
		state.ownRevisions = [...state.ownRevisions, `${doc.path}@${doc.rev}`].slice(-MAX_OWN_REVISIONS);
		return;
	}
	if (MUTATING_TOOL.test(call.name)) {
		const files = stringsOf(call.input).reduce((sum, text) => sum + (text.match(PATCH_FILE_HEADER)?.length ?? 0), 0);
		state.turn.mutations += Math.max(1, files);
	} else {
		const texts = stringsOf(call.input);
		if (texts.some(text => GIT_COMMIT.test(text))) state.turn.committed = true;
		if (texts.some(text => SHIP_COMMAND.test(text))) state.turn.shipped = true;
	}
	if (!needsRecord(state) || state.turn.nudged) return;
	state.turn.nudged = true;
	return recordingReminder(state, "Before your final answer");
}

/** One continuation per turn when the agent is about to finish without recording a change. */
export function stopReminder(state: MemoryState): string | undefined {
	if (!needsRecord(state) || state.turn.stopped) return;
	state.turn.stopped = true;
	return recordingReminder(state, "You are about to finish. First");
}

function needsRecord(state: MemoryState): boolean {
	const turn = state.turn;
	if (!state.documentPath || !state.available || !state.writable || turn.wrote) return false;
	return turn.committed || turn.shipped === true || turn.mutations >= NUDGE_MUTATIONS;
}

function recordingReminder(state: MemoryState, lead: string): string {
	const turn = state.turn;
	const where = state.exists
		? `\`${state.documentPath}\` (gram_brief {path: "${state.documentPath}"} gives the current rev/hash)`
		: `a new \`${state.documentPath}\` (one gram_create with a root project record in Overview and these records in their sections)`;
	const project = state.projectId ?? "prj-<slug>";
	const changed = [
		`${turn.mutations} file edit${turn.mutations === 1 ? "" : "s"}`,
		turn.committed ? "a commit" : "",
		turn.shipped ? "a push, release or deploy" : "",
	]
		.filter(Boolean)
		.join(", ");
	return (
		`This turn changed the project (${changed}) and nothing has been written to Thegram yet. ` +
		`${lead}, record its durable outcomes in ${where}, in the document's language:\n` +
		`- a choice the user or you settled ("let's…", "use X, not Y"): decision in Decisions, x accepted, part-of ${project}; a replaced one gets set x superseded plus a replaces link\n` +
		`- the shipped change: event in Log with at (the commit's author time) and ref (commit/PR/release), implements its decision, else part-of ${project}\n` +
		"- a caveat, limitation or follow-up you are about to report: risk or task in Plan, x open, related to what it concerns\n" +
		"- a status change of an existing record, such as a risk this change resolves: set x with old\n" +
		"Docs: .gram by default; .md only for README or explicit user requests. " +
		"If nothing qualifies, say in the final answer why no Thegram record was written.\n" +
		(state.scope ? `Other repositories share this document: give every record you add "s": ["${state.scope}"].\n` : "") +
		`Add shape: {"op":"add","record":{"type":"event","id":"ev-<slug>","fields":{"t":["…"],"d":["…"],"at":["<ISO time>"],"ref":["<commit>"]},"links":[["implements","dec-<slug>"]]},"place":{"section":"Log"}}; every field value is an array.`
	);
}

export function stateDir(): string {
	const base = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "thegram-memory");
	return path.join(base, "sessions");
}

function stateFile(sessionId: string): string {
	return path.join(stateDir(), `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
}

async function acquireLock(lock: string): Promise<string> {
	const token = `${process.pid}-${randomUUID()}`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			await writeFile(lock, token, { flag: "wx" });
			return token;
		} catch {
			if ((await isStale(lock)) && (await breakStaleLock(lock))) continue;
			if (Date.now() > deadline) throw new ThegramError("E_STATE_LOCK", `session state is locked: ${lock}`);
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
}

async function ageOf(file: string): Promise<number> {
	return stat(file).then(
		info => Date.now() - info.mtimeMs,
		() => 0,
	);
}

async function isStale(lock: string): Promise<boolean> {
	if ((await ageOf(lock)) > LOCK_STALE_MS) return true;
	const pid = Number((await readFile(lock, "utf8").catch(() => "")).split("-")[0]);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function breakStaleLock(lock: string): Promise<boolean> {
	const breaker = `${lock}.break`;
	try {
		await writeFile(breaker, "", { flag: "wx" });
	} catch {
		if ((await ageOf(breaker)) > LOCK_STALE_MS) await rm(breaker, { force: true });
		return false;
	}
	try {
		if (!(await isStale(lock))) return false;
		await rm(lock, { recursive: true, force: true });
		return true;
	} finally {
		await rm(breaker, { force: true });
	}
}

async function releaseLock(lock: string, token: string): Promise<void> {
	if ((await readFile(lock, "utf8").catch(() => undefined)) === token) await rm(lock, { force: true });
}

export async function withSessionState<T>(sessionId: string, fn: (state: MemoryState) => Promise<T>): Promise<T> {
	const file = stateFile(sessionId);
	await mkdir(path.dirname(file), { recursive: true });
	const token = await acquireLock(`${file}.lock`);
	try {
		const stored = await readJsonFile(file);
		const state: MemoryState = { ...newMemoryState(), ...(isJson(stored) ? stored : {}) };
		const result = await fn(state);
		const temp = `${file}.${token}.tmp`;
		await writeFile(temp, JSON.stringify(state));
		await rename(temp, file);
		return result;
	} finally {
		await releaseLock(`${file}.lock`, token);
	}
}

export async function dropSessionState(sessionId: string): Promise<void> {
	await rm(stateFile(sessionId), { force: true });
}

export async function pruneSessionStates(): Promise<void> {
	const dir = stateDir();
	const names = await readdir(dir).catch(() => []);
	await Promise.all(
		names
			.filter(name => name.endsWith(".json"))
			.map(async name => {
				const file = path.join(dir, name);
				const info = await stat(file).catch(() => undefined);
				if (info && Date.now() - info.mtimeMs > STATE_TTL_MS) await rm(file, { force: true });
			}),
	);
}

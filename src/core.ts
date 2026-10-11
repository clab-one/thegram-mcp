import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
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

export function endpointFile(): string {
	return (
		process.env.THEGRAM_MCP_ENDPOINT ??
		path.join(os.homedir(), "Library", "Application Support", "Thegram", "mcp.json")
	);
}

export async function socketPath(): Promise<string> {
	const endpoint = await readJsonFile(endpointFile());
	const socket = isJson(endpoint) ? str(endpoint.socket) : undefined;
	if (!socket) throw new ThegramError("E_APP_NOT_RUNNING", "Thegram is not running. Open the Thegram app, then retry.");
	return socket;
}

export interface McpResponse {
	status: number;
	sessionId?: string;
	contentType: string;
	body: string;
}

export async function postMcp(body: string, headers: Record<string, string>, timeoutMs: number): Promise<McpResponse> {
	const socket = await socketPath();
	const { promise, resolve, reject } = Promise.withResolvers<McpResponse>();
	const req = request(
		{
			socketPath: socket,
			path: "/mcp",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"Content-Length": Buffer.byteLength(body),
				...headers,
			},
		},
		res => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("error", reject);
			res.on("end", () => {
				const session = res.headers["mcp-session-id"];
				resolve({
					status: res.statusCode ?? 0,
					sessionId: typeof session === "string" ? session : undefined,
					contentType: String(res.headers["content-type"] ?? ""),
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
		},
	);
	let timedOut = false;
	const deadline = setTimeout(() => {
		timedOut = true;
		req.destroy();
	}, timeoutMs);
	promise.finally(() => clearTimeout(deadline)).catch(() => {});
	req.on("error", error =>
		reject(
			timedOut
				? new ThegramError("E_TIMEOUT", `Thegram did not answer within ${timeoutMs} ms`)
				: new ThegramError("E_APP_NOT_RUNNING", `Thegram socket unreachable: ${error.message}`),
		),
	);
	req.end(body);
	return promise;
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

export async function resolveProject(cwd: string): Promise<string | null> {
	const map = await loadProjectMap();
	const dir = path.resolve(cwd);
	const real = await realpath(dir).catch(() => dir);
	const mapped = mappedFolder(map, dir) ?? mappedFolder(map, real);
	if (mapped) return mapped;
	const common = await gitCommonDir(dir);
	if (!common) return null;
	const root = path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "");
	return mappedFolder(map, root) ?? (path.basename(root).replace(/^\.+/, "") || null);
}

export async function loadPolicy(): Promise<string> {
	const base = (await readFile(path.join(PACKAGE_ROOT, "policy.md"), "utf8")).trim();
	const local = (await readFile(path.join(configDir(), "policy.md"), "utf8").catch(() => "")).trim();
	return local ? `${base}\n\n## Local rules\n\n${local}` : base;
}

export interface TurnState {
	mutations: number;
	committed: boolean;
	wrote: boolean;
	nudged: boolean;
}

export interface MemoryState {
	folder?: string | null;
	vault?: string;
	exists: boolean;
	available: boolean;
	next?: string;
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
	delete state.folder;
	delete state.vault;
	delete state.next;
	Object.assign(state, newMemoryState());
}

export interface Orientation {
	project: string;
	policy?: string;
	sections: string[];
	recalled: boolean;
}

function renderBrief(name: string, vault: string | undefined, brief: Json, refs: string[]): string {
	const docs = rowsOf(brief.docs);
	const lines = [`Project folder \`${name}\` in the Thegram vault${vault ? ` \`${vault}\`` : ""}.`];
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
	if (state.folder === undefined) state.folder = await resolveProject(cwd);
	const name = state.folder;
	if (!name) return;
	const deadline = Date.now() + ORIENT_BUDGET_MS;
	const left = (cap: number): number => Math.max(0, Math.min(cap, deadline - Date.now()));
	try {
		const projects = await callTool("gram_projects", {}, left(CALL_TIMEOUT_MS));
		state.vault = str(projects.vault);
		state.available = true;
		state.unavailableNoticed = false;
		const exists = rowsOf(projects.projects).some(row => row[0] === name);
		if (exists && !state.exists) state.needBrief = true;
		state.exists = exists;
		const vault = state.vault ? ` in \`${state.vault}\`` : "";
		if (!exists) {
			if (!state.needBrief) return;
			state.needBrief = false;
			return {
				project: name,
				policy: await loadPolicy(),
				recalled: false,
				sections: [
					`No Thegram folder \`${name}\` exists yet${vault}. When this work produces a durable decision, event, risk or task, create \`${name}/memory.gram\` with gram_create (headings # Overview, # Architecture, # Plan, # Decisions, # Log) and record it there.`,
				],
			};
		}
		const sections: string[] = [];
		let policy: string | undefined;
		if (state.needBrief || !state.next) {
			const brief = await callTool("gram_brief", { folder: name }, left(BRIEF_TIMEOUT_MS));
			state.next = str(brief.next);
			state.needBrief = false;
			state.pendingRecall = true;
			state.briefRefs = [];
			policy = await loadPolicy();
			sections.push(renderBrief(name, state.vault, brief, state.briefRefs));
		} else {
			const delta = await callTool("gram_changes", { folder: name, since: state.next }, left(BRIEF_TIMEOUT_MS));
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
				{ query: query.slice(0, RECALL_QUERY_CHARS), folder: name, top_k: MAX_HITS * 2 },
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
		state.available = errorCode(error) !== "E_APP_NOT_RUNNING";
		if (state.unavailableNoticed) return;
		state.unavailableNoticed = true;
		return {
			project: name,
			recalled: false,
			sections: [
				`Thegram memory could not be loaded (${errorCode(error)}). Treat project memory as unknown and do not claim Thegram writes until gram_projects answers.`,
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
	} else if (stringsOf(call.input).some(text => GIT_COMMIT.test(text))) state.turn.committed = true;
	const turn = state.turn;
	if (!state.folder || !state.available || turn.wrote || turn.nudged) return;
	if (!turn.committed && turn.mutations < NUDGE_MUTATIONS) return;
	turn.nudged = true;
	const where = state.exists
		? `\`${state.folder}\` (gram_brief {folder: "${state.folder}"} gives the current rev/hash)`
		: `a new \`${state.folder}/memory.gram\` (gram_create with # Overview, # Architecture, # Plan, # Decisions, # Log)`;
	const changed = `${turn.mutations} file edit${turn.mutations === 1 ? "" : "s"}${turn.committed ? ", a commit" : ""}`;
	return (
		`This turn changed the repository (${changed}) and nothing has been written to Thegram yet. ` +
		`Before your final answer, record its durable memory outcomes in ${where}: decisions (x accepted, or set x superseded plus a replaces link), events with at and a commit/PR ref, new risks or tasks (x open), status changes with set x. ` +
		"Docs: .gram by default; .md only for README or explicit user requests. " +
		"If nothing qualifies, say in the final answer why no Thegram record was written.\n" +
		'Add shape: {"op":"add","record":{"type":"decision","id":"dec-<slug>","fields":{"t":["…"],"d":["…"],"x":["accepted"]},"links":[["implements","<id>"]]},"place":{"section":"Decisions"}}; every field value is an array.'
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

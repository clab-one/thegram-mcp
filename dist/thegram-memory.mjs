#!/usr/bin/env node

// src/cli.ts
import { readFile as readFile3 } from "node:fs/promises";
import * as path2 from "node:path";

// src/core.ts
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var CLI_PATH = path.join(PACKAGE_ROOT, "dist", "thegram-memory.mjs");
var SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
var TOOL_PROTOCOL_VERSION = "2025-06-18";
var CALL_TIMEOUT_MS = 3000;
var RECALL_TIMEOUT_MS = 8000;
var MIN_RECALL_CHARS = 15;
var RECALL_QUERY_CHARS = 400;
var MAX_OPEN = 15;
var MAX_RECENT = 5;
var MAX_HITS = 5;
var MAX_CHANGES = 8;
var MAX_MEMORY_CHARS = 6000;
var NUDGE_MUTATIONS = 3;
var MAX_OWN_REVISIONS = 50;
var STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var LOCK_WAIT_MS = 2000;
var LOCK_STALE_MS = 1e4;
var THEGRAM_WRITE = /thegram.*gram_(?:patch|create)$/;
var MUTATING_TOOL = /^(?:edit|write|multiedit|notebookedit|apply_patch|patch|ast_edit)$/i;
var GIT_COMMIT = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+commit\b/;
var PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File:/gm;

class ThegramError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function isJson(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value) {
  return typeof value === "string" ? value : undefined;
}
function errorCode(error) {
  return error instanceof ThegramError ? error.code : "E_UNKNOWN";
}
function rowsOf(value) {
  return Array.isArray(value) ? value.filter((row) => Array.isArray(row)) : [];
}
function listOf(value) {
  return Array.isArray(value) ? value.filter(isJson) : [];
}
function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
function clipBlock(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return;
  }
}
function endpointFile() {
  return process.env.THEGRAM_MCP_ENDPOINT ?? path.join(os.homedir(), "Library", "Application Support", "Thegram", "mcp.json");
}
async function socketPath() {
  const endpoint = await readJsonFile(endpointFile());
  const socket = isJson(endpoint) ? str(endpoint.socket) : undefined;
  if (!socket)
    throw new ThegramError("E_APP_NOT_RUNNING", "Thegram is not running. Open the Thegram app, then retry.");
  return socket;
}
async function postMcp(body, headers, timeoutMs) {
  const socket = await socketPath();
  const { promise, resolve: resolve2, reject } = Promise.withResolvers();
  const req = request({
    socketPath: socket,
    path: "/mcp",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(body),
      ...headers
    }
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("error", reject);
    res.on("end", () => {
      const session = res.headers["mcp-session-id"];
      resolve2({
        status: res.statusCode ?? 0,
        sessionId: typeof session === "string" ? session : undefined,
        contentType: String(res.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8")
      });
    });
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    req.destroy();
  }, timeoutMs);
  promise.finally(() => clearTimeout(deadline)).catch(() => {});
  req.on("error", (error) => reject(timedOut ? new ThegramError("E_TIMEOUT", `Thegram did not answer within ${timeoutMs} ms`) : new ThegramError("E_APP_NOT_RUNNING", `Thegram socket unreachable: ${error.message}`)));
  req.end(body);
  return promise;
}
function parseMcpMessages(response) {
  if (!response.body.trim())
    return [];
  if (!response.contentType.includes("text/event-stream"))
    return [JSON.parse(response.body)];
  const messages = [];
  for (const event of response.body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join(`
`);
    if (data)
      messages.push(JSON.parse(data));
  }
  return messages;
}
async function callTool(name, args, timeoutMs = CALL_TIMEOUT_MS) {
  const response = await postMcp(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), { "MCP-Protocol-Version": TOOL_PROTOCOL_VERSION }, timeoutMs);
  let message;
  try {
    message = parseMcpMessages(response).find((item) => isJson(item) && item.id === 1);
  } catch {
    throw new ThegramError("E_RPC", `Thegram answered HTTP ${response.status} with an unreadable body`);
  }
  if (!isJson(message))
    throw new ThegramError("E_RPC", `Thegram answered HTTP ${response.status} without a result`);
  if (isJson(message.error)) {
    throw new ThegramError(String(message.error.code ?? "E_RPC"), String(message.error.message ?? ""));
  }
  const result = isJson(message.result) ? message.result : {};
  let out = result.structuredContent;
  if (out === undefined) {
    const text = listOf(result.content).find((part) => part.type === "text")?.text;
    out = typeof text === "string" ? JSON.parse(text) : {};
  }
  if (!isJson(out))
    throw new ThegramError("E_TOOL", "Thegram tool answered a non-object");
  if (isJson(out.error))
    throw new ThegramError(String(out.error.code ?? "E_TOOL"), String(out.error.message ?? ""));
  return out;
}
function configDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "thegram-memory");
}
function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}
async function loadProjectMap() {
  const raw = await readJsonFile(path.join(configDir(), "projects.json"));
  const map = {};
  if (!isJson(raw))
    return map;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string")
      map[path.resolve(expandHome(key))] = value;
  }
  return map;
}
function mappedFolder(map, dir) {
  let best;
  for (const root of Object.keys(map)) {
    if ((dir === root || dir.startsWith(root + path.sep)) && (!best || root.length > best.length))
      best = root;
  }
  return best ? map[best] : undefined;
}
function gitCommonDir(dir) {
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  execFile("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: CALL_TIMEOUT_MS }, (error, stdout) => resolve2(error ? undefined : stdout.trim() || undefined));
  return promise;
}
async function resolveProject(cwd) {
  const map = await loadProjectMap();
  const dir = path.resolve(cwd);
  const real = await realpath(dir).catch(() => dir);
  const mapped = mappedFolder(map, dir) ?? mappedFolder(map, real);
  if (mapped)
    return mapped;
  const common = await gitCommonDir(dir);
  if (!common)
    return null;
  const root = path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "");
  return mappedFolder(map, root) ?? (path.basename(root).replace(/^\.+/, "") || null);
}
async function loadPolicy() {
  const base = (await readFile(path.join(PACKAGE_ROOT, "policy.md"), "utf8")).trim();
  const local = (await readFile(path.join(configDir(), "policy.md"), "utf8").catch(() => "")).trim();
  return local ? `${base}

## Local rules

${local}` : base;
}
function newTurn() {
  return { mutations: 0, committed: false, wrote: false, nudged: false };
}
function newMemoryState() {
  return {
    exists: false,
    available: true,
    needBrief: true,
    pendingRecall: false,
    briefRefs: [],
    unavailableNoticed: false,
    ownRevisions: [],
    turn: newTurn()
  };
}
function resetMemoryState(state) {
  delete state.folder;
  delete state.vault;
  delete state.next;
  Object.assign(state, newMemoryState());
}
function renderBrief(name, vault, brief, refs) {
  const lines = [`Project folder \`${name}\` in the Thegram vault${vault ? ` \`${vault}\`` : ""}.`];
  const docs = rowsOf(brief.docs);
  if (docs.length > 0) {
    lines.push("Documents (path · rev · hash · last recorded):");
    for (const [docPath, title, rev, hash, recorded] of docs) {
      lines.push(`- ${docPath} · r${rev} · ${hash} · ${recorded} — ${clip(title, 80)}`);
    }
  }
  const counts = isJson(brief.counts) ? Object.entries(brief.counts).map(([type, count]) => `${type} ${count}`).join(", ") : "";
  if (counts)
    lines.push(`Records: ${counts}.`);
  const open = rowsOf(brief.open);
  if (open.length > 0) {
    lines.push(`Open records (${open.length}${open.length > MAX_OPEN ? `, first ${MAX_OPEN}` : ""}):`);
    for (const [ref, type, title, status, priority] of open.slice(0, MAX_OPEN)) {
      refs.push(String(ref));
      lines.push(`- ${ref} · ${type} · ${status ?? "-"}${priority ? ` · ${priority}` : ""} · ${clip(title, 120)}`);
    }
  }
  const recent = rowsOf(brief.recent);
  if (recent.length > 0) {
    lines.push("Recent revisions:");
    for (const [docPath, rev, recorded, effective, by, delta] of recent.slice(0, MAX_RECENT)) {
      lines.push(`- ${docPath} r${rev} · ${recorded}${effective ? ` (effective ${effective})` : ""} · ${by} · ${delta}`);
    }
  }
  return lines.join(`
`);
}
function renderChanges(changes, own) {
  const lines = [];
  for (const change of changes) {
    if (own.includes(`${change.path}@${change.rev}`))
      continue;
    const parts = [
      ...rowsOf(change.add).map((row) => `+${row[0]} (${row[1]}) ${clip(row[2], 60)}`),
      ...rowsOf(change.set).map((row) => `~${row[0]} [${Array.isArray(row[2]) ? row[2].join(",") : ""}]`),
      ...rowsOf(change.del).map((row) => `-${row[0]}`)
    ];
    lines.push(`- ${change.path} r${change.rev} · ${change.at} · ${change.by}: ${clip(parts.join("; "), 300)}`);
    if (lines.length >= MAX_CHANGES)
      break;
  }
  return lines.length > 0 ? `Changed by other writers since your last look:
${lines.join(`
`)}` : undefined;
}
function renderHits(hits, seen) {
  const lines = [];
  for (const [ref, type, title, status, summary] of hits) {
    if (lines.length >= MAX_HITS)
      break;
    if (type === "document" || seen.includes(String(ref)))
      continue;
    lines.push(`- ${ref} · ${type} · ${status ?? "-"} · ${clip(title, 100)}${summary ? ` — ${clip(summary, 200)}` : ""}`);
  }
  return lines.length > 0 ? `Recalled for the opening prompt:
${lines.join(`
`)}` : undefined;
}
async function orient(state, cwd, prompt) {
  if (state.folder === undefined)
    state.folder = await resolveProject(cwd);
  const name = state.folder;
  if (!name)
    return;
  try {
    const projects = await callTool("gram_projects", {});
    state.vault = str(projects.vault);
    state.available = true;
    state.unavailableNoticed = false;
    const exists = rowsOf(projects.projects).some((row) => row[0] === name);
    if (exists && !state.exists)
      state.needBrief = true;
    state.exists = exists;
    const vault = state.vault ? ` in \`${state.vault}\`` : "";
    if (!exists) {
      if (!state.needBrief)
        return;
      state.needBrief = false;
      return {
        project: name,
        policy: await loadPolicy(),
        recalled: false,
        sections: [
          `No Thegram folder \`${name}\` exists yet${vault}. When this work produces a durable decision, event, risk or task, create \`${name}/memory.gram\` with gram_create (headings # Overview, # Architecture, # Plan, # Decisions, # Log) and record it there.`
        ]
      };
    }
    const sections = [];
    let policy;
    if (state.needBrief || !state.next) {
      const brief = await callTool("gram_brief", { folder: name });
      state.next = str(brief.next);
      state.needBrief = false;
      state.pendingRecall = true;
      state.briefRefs = [];
      policy = await loadPolicy();
      sections.push(renderBrief(name, state.vault, brief, state.briefRefs));
    } else {
      const delta = await callTool("gram_changes", { folder: name, since: state.next });
      state.next = str(delta.next) ?? state.next;
      const rendered = renderChanges(listOf(delta.changes), state.ownRevisions);
      if (rendered)
        sections.push(rendered);
    }
    let recalled = false;
    const query = prompt?.trim() ?? "";
    if (state.pendingRecall && query.length >= MIN_RECALL_CHARS) {
      state.pendingRecall = false;
      const recall = await callTool("gram_recall", { query: query.slice(0, RECALL_QUERY_CHARS), folder: name, top_k: MAX_HITS * 2 }, RECALL_TIMEOUT_MS).catch(() => {
        return;
      });
      const rendered = recall && renderHits(rowsOf(recall.hits), state.briefRefs);
      if (rendered) {
        sections.push(rendered);
        recalled = true;
      }
    }
    if (!policy && sections.length === 0)
      return;
    return { project: name, policy, sections, recalled };
  } catch (error) {
    state.available = errorCode(error) !== "E_APP_NOT_RUNNING";
    if (state.unavailableNoticed)
      return;
    state.unavailableNoticed = true;
    return {
      project: name,
      recalled: false,
      sections: [
        `Thegram memory could not be loaded (${errorCode(error)}). Treat project memory as unknown and do not claim Thegram writes until gram_projects answers.`
      ]
    };
  }
}
function renderOrientation(orientation, maxChars = Number.POSITIVE_INFINITY) {
  const parts = [];
  if (orientation.policy)
    parts.push(`<thegram-memory-policy>
${orientation.policy}
</thegram-memory-policy>`);
  if (orientation.sections.length > 0) {
    const open = `<thegram-memory project="${orientation.project}">
`;
    const close = `
</thegram-memory>`;
    const used = parts.reduce((sum, part) => sum + part.length + 2, 0) + open.length + close.length;
    const budget = Math.min(MAX_MEMORY_CHARS, maxChars - used);
    if (budget > 200)
      parts.push(`${open}${clipBlock(orientation.sections.join(`

`), budget)}${close}`);
  }
  return parts.join(`

`);
}
function stringsOf(value, out = [], depth = 0) {
  if (depth > 6)
    return out;
  if (typeof value === "string")
    out.push(value);
  else if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string"))
      out.push(value.join(" "));
    for (const item of value)
      stringsOf(item, out, depth + 1);
  } else if (isJson(value)) {
    for (const item of Object.values(value))
      stringsOf(item, out, depth + 1);
  }
  return out;
}
function findDoc(value, depth = 0) {
  if (depth > 6)
    return;
  if (typeof value === "string") {
    if (!value.includes('"doc"'))
      return;
    try {
      return findDoc(JSON.parse(value), depth + 1);
    } catch {
      return;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const doc2 = findDoc(item, depth + 1);
      if (doc2)
        return doc2;
    }
    return;
  }
  if (!isJson(value))
    return;
  const doc = value.doc;
  if (isJson(doc) && typeof doc.path === "string" && typeof doc.rev === "number")
    return { path: doc.path, rev: doc.rev };
  for (const item of Object.values(value)) {
    const found = findDoc(item, depth + 1);
    if (found)
      return found;
  }
}
function observeTool(state, call) {
  if (call.isError)
    return;
  if (THEGRAM_WRITE.test(call.name)) {
    const doc = findDoc(call.output);
    if (!doc)
      return;
    state.turn.wrote = true;
    state.ownRevisions = [...state.ownRevisions, `${doc.path}@${doc.rev}`].slice(-MAX_OWN_REVISIONS);
    return;
  }
  if (MUTATING_TOOL.test(call.name)) {
    const files = stringsOf(call.input).reduce((sum, text) => sum + (text.match(PATCH_FILE_HEADER)?.length ?? 0), 0);
    state.turn.mutations += Math.max(1, files);
  } else if (stringsOf(call.input).some((text) => GIT_COMMIT.test(text)))
    state.turn.committed = true;
  const turn = state.turn;
  if (!state.folder || !state.available || turn.wrote || turn.nudged)
    return;
  if (!turn.committed && turn.mutations < NUDGE_MUTATIONS)
    return;
  turn.nudged = true;
  const where = state.exists ? `\`${state.folder}\` (gram_brief {folder: "${state.folder}"} gives the current rev/hash)` : `a new \`${state.folder}/memory.gram\` (gram_create with # Overview, # Architecture, # Plan, # Decisions, # Log)`;
  const changed = `${turn.mutations} file edit${turn.mutations === 1 ? "" : "s"}${turn.committed ? ", a commit" : ""}`;
  return `This turn changed the repository (${changed}) and nothing has been written to Thegram yet. ` + `Before your final answer, record its durable outcomes in ${where}: decisions (x accepted, or set x superseded plus a replaces link), events with at and a commit/PR ref, new risks or tasks (x open), status changes with set x. ` + `If nothing qualifies, say in the final answer why no Thegram record was written.
` + 'Add shape: {"op":"add","record":{"type":"decision","id":"dec-<slug>","fields":{"t":["…"],"d":["…"],"x":["accepted"]},"links":[["implements","<id>"]]},"place":{"section":"Decisions"}}; every field value is an array.';
}
function stateDir() {
  const base = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), "thegram-memory");
  return path.join(base, "sessions");
}
function stateFile(sessionId) {
  return path.join(stateDir(), `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
}
async function acquireLock(lock) {
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;; ) {
    try {
      await writeFile(lock, token, { flag: "wx" });
      return token;
    } catch {
      if (await isStale(lock) && await breakStaleLock(lock))
        continue;
      if (Date.now() > deadline)
        throw new ThegramError("E_STATE_LOCK", `session state is locked: ${lock}`);
      await new Promise((resolve2) => setTimeout(resolve2, 25));
    }
  }
}
async function ageOf(file) {
  return stat(file).then((info) => Date.now() - info.mtimeMs, () => 0);
}
async function isStale(lock) {
  if (await ageOf(lock) > LOCK_STALE_MS)
    return true;
  const pid = Number((await readFile(lock, "utf8").catch(() => "")).split("-")[0]);
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
async function breakStaleLock(lock) {
  const breaker = `${lock}.break`;
  try {
    await writeFile(breaker, "", { flag: "wx" });
  } catch {
    if (await ageOf(breaker) > LOCK_STALE_MS)
      await rm(breaker, { force: true });
    return false;
  }
  try {
    if (!await isStale(lock))
      return false;
    await rm(lock, { recursive: true, force: true });
    return true;
  } finally {
    await rm(breaker, { force: true });
  }
}
async function releaseLock(lock, token) {
  if (await readFile(lock, "utf8").catch(() => {
    return;
  }) === token)
    await rm(lock, { force: true });
}
async function withSessionState(sessionId, fn) {
  const file = stateFile(sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const token = await acquireLock(`${file}.lock`);
  try {
    const stored = await readJsonFile(file);
    const state = { ...newMemoryState(), ...isJson(stored) ? stored : {} };
    const result = await fn(state);
    const temp = `${file}.${token}.tmp`;
    await writeFile(temp, JSON.stringify(state));
    await rename(temp, file);
    return result;
  } finally {
    await releaseLock(`${file}.lock`, token);
  }
}
async function dropSessionState(sessionId) {
  await rm(stateFile(sessionId), { force: true });
}
async function pruneSessionStates() {
  const dir = stateDir();
  const names = await readdir(dir).catch(() => []);
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => {
      return;
    });
    if (info && Date.now() - info.mtimeMs > STATE_TTL_MS)
      await rm(file, { force: true });
  }));
}

// src/hook.ts
var MAX_CONTEXT_CHARS = 9500;
async function runHook(raw) {
  const input = JSON.parse(raw);
  if (!isJson(input))
    return "";
  const event = str(input.hook_event_name);
  const sessionId = str(input.session_id);
  const cwd = str(input.cwd) ?? process.cwd();
  if (!event || !sessionId)
    return "";
  if (event === "SessionEnd") {
    await dropSessionState(sessionId);
    return "";
  }
  const context = await withSessionState(sessionId, async (state) => {
    if (event === "SessionStart") {
      if (str(input.source) === "compact")
        state.needBrief = true;
      else {
        resetMemoryState(state);
        await pruneSessionStates();
      }
      const orientation = await orient(state, cwd);
      return orientation && renderOrientation(orientation, MAX_CONTEXT_CHARS);
    }
    if (event === "UserPromptSubmit") {
      state.turn = newTurn();
      const orientation = await orient(state, cwd, str(input.prompt));
      return orientation && renderOrientation(orientation, MAX_CONTEXT_CHARS);
    }
    if (event === "PostToolUse") {
      if (input.agent_id || state.folder === undefined)
        return;
      return observeTool(state, {
        name: str(input.tool_name) ?? "",
        input: input.tool_input,
        output: input.tool_response
      });
    }
  });
  if (!context)
    return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: clipBlock(context, MAX_CONTEXT_CHARS) }
  });
}

// src/mcp-proxy.ts
import { readFile as readFile2 } from "node:fs/promises";
import { createInterface } from "node:readline";
var REQUEST_TIMEOUT_MS = 120000;
async function runMcpProxy() {
  let sessionId;
  let protocol;
  let initBody;
  let initEndpoint;
  let lost = false;
  const endpoint = () => readFile2(endpointFile(), "utf8").catch(() => "");
  const write = (message) => {
    process.stdout.write(`${JSON.stringify(message)}
`);
  };
  const send = async (body) => {
    const headers = {};
    if (protocol)
      headers["MCP-Protocol-Version"] = protocol;
    if (sessionId)
      headers["Mcp-Session-Id"] = sessionId;
    return postMcp(body, headers, REQUEST_TIMEOUT_MS);
  };
  const reinitialize = async (body) => {
    sessionId = undefined;
    sessionId = (await send(body)).sessionId;
    await send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    initEndpoint = await endpoint();
    lost = false;
  };
  const forward = async (message) => {
    const id = isJson(message) && "id" in message ? message.id : undefined;
    const isInitialize = isJson(message) && message.method === "initialize";
    const body = JSON.stringify(message);
    try {
      if (isInitialize) {
        initBody = body;
        sessionId = undefined;
      } else if (initBody && (lost || await endpoint() !== initEndpoint))
        await reinitialize(initBody);
      const response = await send(body);
      if (response.sessionId)
        sessionId = response.sessionId;
      if (isInitialize)
        initEndpoint = await endpoint();
      const replies = parseMcpMessages(response);
      for (const reply of replies) {
        if (isInitialize && isJson(reply) && isJson(reply.result) && typeof reply.result.protocolVersion === "string") {
          protocol = reply.result.protocolVersion;
        }
        write(reply);
      }
      if (replies.length === 0 && response.status >= 400 && id !== undefined) {
        write({ jsonrpc: "2.0", id, error: { code: -32000, message: `Thegram answered HTTP ${response.status}` } });
      }
    } catch (error) {
      if (errorCode(error) === "E_APP_NOT_RUNNING")
        lost = true;
      if (id === undefined)
        return;
      const text = error instanceof Error ? error.message : String(error);
      write({ jsonrpc: "2.0", id, error: { code: -32000, message: text, data: { code: errorCode(error) } } });
    }
  };
  let chain = Promise.resolve();
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (!line.trim())
      continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    chain = chain.then(() => forward(message));
  }
  await chain;
}

// src/cli.ts
var USAGE = `thegram-memory <command>

  mcp              stdio MCP server that forwards to the Thegram app
  hook             Claude Code / Codex command hook (event JSON on stdin)
  doctor [dir]     check the app connection and the project for a directory
  version          print the package version`;
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
async function packageVersion() {
  const pkg = JSON.parse(await readFile3(path2.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "unknown";
}
async function doctor(dir) {
  const lines = [`thegram-memory ${await packageVersion()} · node ${process.version}`, `endpoint: ${endpointFile()}`];
  let failed = false;
  try {
    lines.push(`socket: ${await socketPath()}`);
    const projects = await callTool("gram_projects", {});
    const folders = Array.isArray(projects.projects) ? projects.projects.length : 0;
    lines.push(`vault: ${str(projects.vault)} · access ${str(projects.access)} · ${folders} project folders`);
    const project = await resolveProject(dir);
    if (!project)
      lines.push(`project: none for ${dir} (not a git repository and no mapping)`);
    else {
      const exists = Array.isArray(projects.projects) && projects.projects.some((row) => Array.isArray(row) && row[0] === project);
      lines.push(`project: ${project} for ${dir} · ${exists ? "folder exists" : "folder not created yet"}`);
    }
  } catch (error) {
    failed = true;
    lines.push(`app: unavailable (${errorCode(error)}: ${error instanceof Error ? error.message : String(error)})`);
  }
  const mapped = Object.keys(await loadProjectMap()).length;
  const localPolicy = await readFile3(path2.join(configDir(), "policy.md"), "utf8").then(() => "present", () => "absent");
  lines.push(`config: ${configDir()} · ${mapped} mapped directories · local policy ${localPolicy}`);
  lines.push(`hook state: ${stateDir()}`);
  process.stdout.write(`${lines.join(`
`)}
`);
  return failed ? 1 : 0;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "mcp":
      await runMcpProxy();
      return 0;
    case "hook":
      try {
        process.stdout.write(await runHook(await readStdin()));
      } catch (error) {
        process.stderr.write(`thegram-memory hook: ${error instanceof Error ? error.message : String(error)}
`);
      }
      return 0;
    case "doctor":
      return doctor(path2.resolve(args[0] ?? process.cwd()));
    case "version":
      process.stdout.write(`${await packageVersion()}
`);
      return 0;
    default:
      process.stdout.write(`${USAGE}
`);
      return command ? 1 : 0;
  }
}
process.exitCode = await main();

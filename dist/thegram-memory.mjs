#!/usr/bin/env node

// src/cli.ts
import { readFile as readFile2, rm as rm2 } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { createInterface as createInterface2 } from "node:readline/promises";
import * as path2 from "node:path";

// src/core.ts
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
var CLI_PATH = path.join(PACKAGE_ROOT, "dist", "thegram-memory.mjs");
var SKILLS_DIR = path.join(PACKAGE_ROOT, "skills");
var TOOL_PROTOCOL_VERSION = "2025-06-18";
var CALL_TIMEOUT_MS = 3000;
var RECALL_TIMEOUT_MS = 8000;
var BRIEF_TIMEOUT_MS = 8000;
var ORIENT_BUDGET_MS = 15000;
var MIN_RECALL_WAIT_MS = 2000;
var MIN_RECALL_CHARS = 15;
var RECALL_QUERY_CHARS = 400;
var MAX_OPEN = 15;
var MAX_HITS = 5;
var OPEN_TYPES = ["blocker", "risk", "task", "decision", "requirement", "assumption", "goal"];
var OPEN_FIRST_PASS = 5;
var MAX_CHANGES = 8;
var MAX_MEMORY_CHARS = 6000;
var NUDGE_MUTATIONS = 3;
var MAX_OWN_REVISIONS = 50;
var STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
var LOCK_WAIT_MS = 2000;
var LOCK_STALE_MS = ORIENT_BUDGET_MS + 5000;
var THEGRAM_WRITE = /thegram.*gram_(?:patch|create)$/;
var MUTATING_TOOL = /^(?:edit|write|multiedit|notebookedit|apply_patch|patch|ast_edit)$/i;
var GIT_COMMIT = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+commit\b/;
var SHIP_COMMAND = /\b(?:git\b(?:\s+-C\s+\S+)?(?:\s+-c\s+\S+)*\s+push|gh\s+(?:release\s+create|pr\s+(?:create|merge))|kubectl\b[^\n;&|]*\s(?:apply|rollout\s+restart|set\s+image|patch)|helm\s+(?:upgrade|install|rollback)|(?:npm|pnpm|yarn|bun)\s+publish|docker\s+push)\b/;
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
function connectionFile() {
  return path.join(configDir(), "connection.json");
}
function validateEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ThegramError("E_CONFIG", "Thegram MCP URL is invalid");
  }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback) || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new ThegramError("E_CONFIG", "Use an HTTPS /mcp endpoint; HTTP is allowed only on loopback for local verification");
  }
  return url.href;
}
async function connectionSettings() {
  const file = connectionFile();
  const stored = await readJsonFile(file);
  const saved = isJson(stored) ? stored : {};
  const envKey = process.env.THEGRAM_API_KEY;
  if (!envKey && typeof saved.apiKey === "string" && process.platform !== "win32") {
    const info = await stat(file);
    if ((info.mode & 63) !== 0)
      throw new ThegramError("E_CONFIG", `Restrict ${file} to mode 0600 before connecting`);
  }
  const apiKey = envKey ?? str(saved.apiKey);
  if (!apiKey)
    throw new ThegramError("E_AUTH", "Connect Thegram with an API key: node dist/thegram-memory.mjs connect");
  if (!apiKey.startsWith("tgk_") || /\s/.test(apiKey))
    throw new ThegramError("E_AUTH", "Use an API key issued in Thegram Settings → Agents");
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
async function saveConnection(settings) {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 448 });
  if (process.platform !== "win32")
    await chmod(dir, 448);
  const temp = `${connectionFile()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(settings) + `
`, { mode: 384, flag: "wx" });
    await rename(temp, connectionFile());
  } finally {
    await rm(temp, { force: true });
  }
}
async function connectionId() {
  const settings = await connectionSettings();
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
var GATEWAY_STATUS = new Set([502, 503, 504]);
var GATEWAY_RETRY_MS = 20000;
async function postMcp(body, headers, timeoutMs) {
  const settings = await connectionSettings();
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const retryUntil = Date.now() + Math.min(GATEWAY_RETRY_MS, Math.max(0, timeoutMs - 1000));
  for (let attempt = 0;; attempt++) {
    let answer;
    try {
      const response = await fetch(settings.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
          Authorization: `Bearer ${settings.apiKey}`
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      });
      if (response.status === 401)
        throw new ThegramError("E_AUTH", "Thegram API key is invalid, expired or revoked; reconnect with a new key");
      if (response.status === 403)
        throw new ThegramError("E_FORBIDDEN", "The API key does not permit this Thegram operation");
      answer = {
        status: response.status,
        sessionId: response.headers.get("mcp-session-id") ?? undefined,
        contentType: response.headers.get("content-type") ?? "",
        body: await response.text()
      };
    } catch (error) {
      if (error instanceof ThegramError)
        throw error;
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
        throw new ThegramError("E_TIMEOUT", `Thegram did not answer within ${timeoutMs} ms`);
      }
      throw new ThegramError("E_CONNECT", "Thegram Cloud MCP is unreachable; check the endpoint and network");
    }
    const gateway = GATEWAY_STATUS.has(answer.status) && !answer.contentType.includes("json") && !answer.contentType.includes("text/event-stream");
    if (!gateway)
      return answer;
    const wait = Math.min(2000, 500 * 2 ** attempt);
    if (Date.now() + wait > retryUntil) {
      const detail = answer.body.trim().slice(0, 80);
      throw new ThegramError("E_UNAVAILABLE", `Thegram Cloud is temporarily unavailable (HTTP ${answer.status}${detail ? `: ${detail}` : ""}), for example during a server update; retry in a moment`);
    }
    const { promise, resolve: resolve2 } = Promise.withResolvers();
    setTimeout(resolve2, wait);
    await promise;
  }
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
function gitOutput(dir, args) {
  const { promise, resolve: resolve2 } = Promise.withResolvers();
  execFile("git", ["-C", dir, ...args], { timeout: CALL_TIMEOUT_MS }, (error, stdout) => resolve2(error ? undefined : stdout.trim() || undefined));
  return promise;
}
function repositoryId(remote) {
  const value = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value);
  let host;
  let route;
  if (scp)
    [, host, route] = scp;
  else {
    try {
      const url = new URL(value);
      host = url.hostname;
      route = url.pathname;
    } catch {
      return;
    }
  }
  route = route.replace(/^\/+/, "");
  return host && route ? `${host.toLowerCase()}/${route}` : undefined;
}
var REPOSITORY_TAG_PREFIX = "repo:";
function isDocumentPath(value) {
  const parts = value.split("/");
  return parts.length >= 3 && parts[0] === "@mounts" && /^[A-Za-z0-9_-]+$/.test(parts[1]) && parts.slice(2).every((part) => part.trim() === part && part !== "" && part !== "." && part !== ".." && [...part].every((char) => char.charCodeAt(0) >= 32)) && /^[^.].*\.gram$/.test(parts[parts.length - 1]);
}
function defaultDocument(mount, root) {
  const name = path.basename(root);
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name) ? name : `${name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 80) || "project"}-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  return `${mount}/${safe}.gram`;
}
async function resolveProject(cwd, known) {
  const map = await loadProjectMap();
  const dir = path.resolve(cwd);
  const real = await realpath(dir).catch(() => dir);
  const common = await gitCommonDir(dir);
  const root = common ? path.basename(common) === ".git" ? path.dirname(common) : common.replace(/\.git$/, "") : undefined;
  const remote = root ? await gitOutput(root, ["remote", "get-url", "origin"]) : undefined;
  const id = remote ? repositoryId(remote) : undefined;
  const tag = id ? REPOSITORY_TAG_PREFIX + id : undefined;
  const name = id ? id.slice(id.lastIndexOf("/") + 1) : root ? path.basename(root) : undefined;
  const mapped = mappedFolder(map, dir) ?? mappedFolder(map, real) ?? (root && mappedFolder(map, root));
  if (mapped) {
    if (!isDocumentPath(mapped)) {
      throw new ThegramError("E_CONFIG", "Project mappings must name an exact Cloud document: @mounts/<vault-id>/[<folder>/]<project>.gram");
    }
    return { path: mapped, via: "mapping", tag, name };
  }
  if (!root)
    return null;
  const { mount } = await connectionSettings();
  if (!mount)
    throw new ThegramError("E_CONFIG", "Select a Cloud vault with the connect command or THEGRAM_MCP_MOUNT");
  const fallback = defaultDocument(mount, root);
  if (tag && known && known.via !== "mapping" && known.tag === tag)
    return known;
  if (tag) {
    const listed = await callTool("gram_list", { select: { type: "project", tag } });
    const claims = new Map;
    for (const row of rowsOf(listed.records)) {
      const ref = String(row[0]);
      const at = ref.lastIndexOf("#");
      if (at > 0 && !claims.has(ref.slice(0, at)))
        claims.set(ref.slice(0, at), ref.slice(at + 1));
    }
    if (claims.size > 0) {
      const paths = [...claims.keys()].sort((a, b) => Number(!a.startsWith(`${mount}/`)) - Number(!b.startsWith(`${mount}/`)) || a.localeCompare(b));
      const chosen = claims.has(fallback) ? fallback : paths[0];
      const others = paths.filter((item) => item !== chosen);
      return { path: chosen, via: "repository", tag, name, projectId: claims.get(chosen), ...others.length ? { others } : {} };
    }
  }
  return { path: fallback, via: "default", tag, name };
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
  delete state.documentPath;
  delete state.connection;
  delete state.vault;
  delete state.writable;
  delete state.next;
  delete state.projectId;
  delete state.scope;
  delete state.binding;
  Object.assign(state, newMemoryState());
}
function renderBrief(name, vault, brief, refs, projectId, scope) {
  const docs = rowsOf(brief.docs);
  const lines = [`Project memory \`${name}\` in Thegram Cloud${vault ? ` (\`${vault}\`)` : ""}.`];
  if (docs.length === 1) {
    const [docPath, , rev, hash, recorded] = docs[0];
    const newest = rowsOf(brief.recent).find((row) => row[0] === docPath && row[1] === rev);
    lines[0] += ` · ${docPath} r${rev} · ${hash} · last write ${recorded} by ${String(newest?.[4] ?? "unknown")}`;
  } else if (docs.length > 1) {
    lines.push("Documents:");
    for (const [docPath, title, rev, hash, recorded] of docs) {
      lines.push("- " + docPath + " · r" + rev + " · " + hash + " · " + recorded + " — " + clip(title, 80));
    }
  }
  const counts = isJson(brief.counts) ? Object.entries(brief.counts).map(([type, count]) => type + " " + count).join(", ") : "";
  if (counts)
    lines.push("Records: " + counts + ".");
  lines.push(projectId ? `Root project record: \`${projectId}\`. Link every new record into it: decisions, components and goals part-of it; events implements the decision they carry out (else part-of); tasks, risks and blockers related to what they concern.` : "This document has no project record. With your first write, add one (type project, x active) placed in Overview and link new records to it.");
  if (scope)
    lines.push(`Other repositories share this document: give every record you add "s": ["${scope}"].`);
  const open = rowsOf(brief.open);
  const total = open.length + (typeof brief.open_omitted === "number" ? brief.open_omitted : 0);
  if (total > 0) {
    const rank = (row) => {
      const index = OPEN_TYPES.indexOf(String(row[1]));
      return index < 0 ? OPEN_TYPES.length : index;
    };
    const ordered = [...open].sort((a, b) => rank(a) - rank(b));
    const shown = new Set;
    for (const perType of [OPEN_FIRST_PASS, MAX_OPEN]) {
      const taken = new Map;
      for (const row of shown)
        taken.set(String(row[1]), (taken.get(String(row[1])) ?? 0) + 1);
      for (const row of ordered) {
        if (shown.size >= MAX_OPEN)
          break;
        const type = String(row[1]);
        if (shown.has(row) || (taken.get(type) ?? 0) >= perType)
          continue;
        shown.add(row);
        taken.set(type, (taken.get(type) ?? 0) + 1);
      }
    }
    lines.push(`Open records (${shown.size} of ${total}):`);
    for (const row of ordered) {
      if (!shown.has(row))
        continue;
      const [ref, type, title, status, priority] = row;
      const fullRef = String(ref);
      refs.push(fullRef);
      const displayRef = docs.length === 1 ? fullRef.slice(fullRef.lastIndexOf("#") + 1) : fullRef;
      lines.push(`- ${displayRef} · ${type} · ${status ?? "-"}${priority ? ` · ${priority}` : ""} · ${clip(title, 120)}`);
    }
    if (total > shown.size) {
      const omitted = new Map;
      for (const row of ordered)
        if (!shown.has(row))
          omitted.set(String(row[1]), (omitted.get(String(row[1])) ?? 0) + 1);
      const parts = [...omitted].map(([type, count]) => `${type} ${count}`);
      if (total > open.length)
        parts.push(`${total - open.length} trimmed by the app`);
      lines.push(`Not shown: ${parts.join(", ")} — list with gram_list {path, select: {type, status}}.`);
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
function bindingNotes(binding, projectId) {
  const lines = [];
  if (binding.via === "default" && binding.tag && projectId) {
    lines.push(`This repository is bound to \`${binding.path}\` only by its root path. Run \`node "${CLI_PATH}" bind\` here once (it adds the tag "${binding.tag}" to \`${projectId}\`) so the document can be moved into a folder without a duplicate being created.`);
  }
  if (binding.others?.length) {
    lines.push(`Other documents also carry "${binding.tag}": ${binding.others.map((item) => `\`${item}\``).join(", ")}. This session uses \`${binding.path}\`; tell the user so they can merge or untag the others.`);
  }
  return lines.length ? lines.join(`
`) : undefined;
}
async function orient(state, cwd, prompt, retried = false) {
  let name = state.documentPath ?? path.basename(cwd);
  const deadline = Date.now() + ORIENT_BUDGET_MS;
  const left = (cap) => Math.max(0, Math.min(cap, deadline - Date.now()));
  try {
    const connection = await connectionId();
    const binding = await resolveProject(cwd, state.exists && !state.needBrief ? state.binding : undefined);
    const documentPath = binding?.path ?? null;
    if (state.connection !== connection || state.documentPath !== documentPath) {
      resetMemoryState(state);
      state.connection = connection;
      state.documentPath = documentPath;
    }
    state.binding = binding ?? undefined;
    if (!binding || !documentPath)
      return;
    name = documentPath;
    const projects = await callTool("gram_projects", {}, left(CALL_TIMEOUT_MS));
    const mountKey = name.split("/", 2).join("/");
    const mount = listOf(projects.mounts).find((item) => item.key === mountKey && item.kind === "vault");
    if (!mount)
      throw new ThegramError("E_FORBIDDEN", "The selected Cloud vault is not accessible to this API key");
    state.vault = str(mount.name);
    state.writable = mount.access === "write";
    state.available = true;
    state.unavailableNoticed = false;
    const sections = [];
    let policy;
    if (state.needBrief || !state.next || !state.exists) {
      let brief;
      const roots = callTool("gram_list", { path: name, select: { type: "project" } }, left(CALL_TIMEOUT_MS)).catch(() => {
        return;
      });
      try {
        brief = await callTool("gram_brief", { path: name }, left(BRIEF_TIMEOUT_MS));
      } catch (error) {
        if (errorCode(error) !== "E_NOT_FOUND")
          throw error;
        const firstNotice = state.needBrief || state.exists;
        state.exists = false;
        state.needBrief = false;
        if (!firstNotice)
          return;
        return {
          project: name,
          policy: await loadPolicy(),
          recalled: false,
          sections: [
            state.writable ? `No Cloud memory document \`${name}\` exists yet. When this work produces a durable outcome, create that exact path in one gram_create with a root project record and that outcome placed in its section, in the user's language: {"path":"${name}","title":"…","base_revision":null,"template":"project@1","content":{"text":"# Overview\\n\\n[[prj-<slug>]]\\n\\n# Architecture\\n\\n# Plan\\n\\n# Decisions\\n\\n# Log\\n","fields":{"d":["<one-line summary>"]},"records":[{"type":"project","id":"prj-<slug>","fields":{"t":["…"],"d":["…"],"x":["active"]${binding.tag ? `,"tag":["${binding.tag}"]` : ""}}}]}}. Each further record is placed as [[id]] alone on a line in its section and linked to prj-<slug>.${binding.tag ? " The repo tag on the project record keeps this repository bound to the document after it is moved into a folder." : ""} Do not create a folder or switch to another mount.` : `Cloud memory document \`${name}\` does not exist and this API key is read-only. Do not create it or switch to another destination.`
          ]
        };
      }
      state.exists = true;
      state.next = str(brief.next);
      state.needBrief = false;
      state.pendingRecall = true;
      state.briefRefs = [];
      const root = rowsOf((await roots)?.records).find((row) => row[1] === "project");
      state.projectId = binding.projectId ?? (root ? String(root[0]) : undefined);
      state.scope = binding.name && path.basename(name, ".gram") !== binding.name ? binding.name : undefined;
      policy = await loadPolicy();
      sections.push(renderBrief(name, state.vault, brief, state.briefRefs, state.projectId, state.scope));
      const binds = bindingNotes(binding, state.projectId);
      if (binds)
        sections.push(binds);
      if (!state.writable)
        sections.push("This API key is read-only. Do not attempt writes.");
    } else {
      let delta;
      try {
        delta = await callTool("gram_changes", { path: name, since: state.next }, left(BRIEF_TIMEOUT_MS));
      } catch (error) {
        if (errorCode(error) !== "E_NOT_FOUND" || retried)
          throw error;
        state.needBrief = true;
        state.exists = false;
        delete state.binding;
        return orient(state, cwd, prompt, true);
      }
      state.next = str(delta.next) ?? state.next;
      const rendered = renderChanges(listOf(delta.changes), state.ownRevisions);
      if (rendered)
        sections.push(rendered);
    }
    let recalled = false;
    const query = prompt?.trim() ?? "";
    if (state.pendingRecall && query.length >= MIN_RECALL_CHARS && left(RECALL_TIMEOUT_MS) >= MIN_RECALL_WAIT_MS) {
      state.pendingRecall = false;
      const recall = await callTool("gram_recall", { query: query.slice(0, RECALL_QUERY_CHARS), documents: [name], top_k: MAX_HITS * 2 }, left(RECALL_TIMEOUT_MS)).catch(() => {
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
    state.available = false;
    if (state.unavailableNoticed)
      return;
    state.unavailableNoticed = true;
    return {
      project: name,
      recalled: false,
      sections: [
        `Thegram Cloud memory could not be loaded (${errorCode(error)}). Treat project memory as unknown. Check the API key and selected vault; do not switch storage or claim successful writes.`
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
  } else {
    const texts = stringsOf(call.input);
    if (texts.some((text) => GIT_COMMIT.test(text)))
      state.turn.committed = true;
    if (texts.some((text) => SHIP_COMMAND.test(text)))
      state.turn.shipped = true;
  }
  if (!needsRecord(state) || state.turn.nudged)
    return;
  state.turn.nudged = true;
  return recordingReminder(state, "Before your final answer");
}
function stopReminder(state) {
  if (!needsRecord(state) || state.turn.stopped)
    return;
  state.turn.stopped = true;
  return recordingReminder(state, "You are about to finish. First");
}
function needsRecord(state) {
  const turn = state.turn;
  if (!state.documentPath || !state.available || !state.writable || turn.wrote)
    return false;
  return turn.committed || turn.shipped === true || turn.mutations >= NUDGE_MUTATIONS;
}
function recordingReminder(state, lead) {
  const turn = state.turn;
  const where = state.exists ? `\`${state.documentPath}\` (gram_brief {path: "${state.documentPath}"} gives the current rev/hash)` : `a new \`${state.documentPath}\` (one gram_create with a root project record in Overview and these records in their sections)`;
  const project = state.projectId ?? "prj-<slug>";
  const changed = [
    `${turn.mutations} file edit${turn.mutations === 1 ? "" : "s"}`,
    turn.committed ? "a commit" : "",
    turn.shipped ? "a push, release or deploy" : ""
  ].filter(Boolean).join(", ");
  return `This turn changed the project (${changed}) and nothing has been written to Thegram yet. ` + `${lead}, record its durable outcomes in ${where}, in the document's language:
` + `- a choice the user or you settled ("let's…", "use X, not Y"): decision in Decisions, x accepted, part-of ${project}; a replaced one gets set x superseded plus a replaces link
` + `- the shipped change: event in Log with at (the commit's author time) and ref (commit/PR/release), implements its decision, else part-of ${project}
` + `- a caveat, limitation or follow-up you are about to report: risk or task in Plan, x open, related to what it concerns
` + `- a status change of an existing record, such as a risk this change resolves: set x with old
` + "Docs: .gram by default; .md only for README or explicit user requests. " + `If nothing qualifies, say in the final answer why no Thegram record was written.
` + (state.scope ? `Other repositories share this document: give every record you add "s": ["${state.scope}"].
` : "") + `Add shape: {"op":"add","record":{"type":"event","id":"ev-<slug>","fields":{"t":["…"],"d":["…"],"at":["<ISO time>"],"ref":["<commit>"]},"links":[["implements","dec-<slug>"]]},"place":{"section":"Log"}}; every field value is an array.`;
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
  if (event === "Stop") {
    if (input.stop_hook_active === true)
      return "";
    const reason = await withSessionState(sessionId, async (state) => stopReminder(state));
    return reason ? JSON.stringify({ decision: "block", reason }) : "";
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
      if (input.agent_id || state.documentPath === undefined)
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
import { createInterface } from "node:readline";
var REQUEST_TIMEOUT_MS = 120000;
async function runMcpProxy() {
  let sessionId;
  let protocol;
  let initBody;
  let initEndpoint;
  let lost = false;
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
    initEndpoint = await connectionId();
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
      } else if (initBody && (lost || await connectionId() !== initEndpoint))
        await reinitialize(initBody);
      const response = await send(body);
      if (response.sessionId)
        sessionId = response.sessionId;
      if (isInitialize)
        initEndpoint = await connectionId();
      let replies;
      try {
        replies = parseMcpMessages(response);
      } catch {
        throw new ThegramError("E_RPC", `Thegram answered HTTP ${response.status} with a non-MCP body: ${response.body.trim().slice(0, 80)}`);
      }
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
      if (errorCode(error) === "E_CONNECT")
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

  connect [--mount <key>] [--url <endpoint>]
                   securely read an API key and choose a Cloud vault
  disconnect       remove this machine's saved credential (does not revoke it)
  mcp              stdio bridge to the Cloud MCP using the API key
  hook             Claude Code / Codex command hook (event JSON on stdin)
  doctor [dir]     check Cloud access and this repository's memory document
  bind [dir]       tag the memory document's project record with this repository so it can be moved into a folder
  version          print the package version`;
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
async function packageVersion() {
  const pkg = JSON.parse(await readFile2(path2.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "unknown";
}
async function readKey() {
  if (!process.stdin.isTTY)
    return (await readStdin()).trim();
  emitKeypressEvents(process.stdin);
  const raw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  const { promise, resolve: resolve3, reject } = Promise.withResolvers();
  let key = "";
  const cleanup = () => {
    process.stdin.off("keypress", onKey);
    process.stdin.setRawMode(raw);
    process.stdin.pause();
    process.stderr.write(`
`);
  };
  const onKey = (text, pressed) => {
    if (pressed.ctrl && pressed.name === "c") {
      cleanup();
      reject(new ThegramError("E_INPUT", "Connection cancelled"));
    } else if (pressed.name === "return" || pressed.name === "enter") {
      cleanup();
      resolve3(key.trim());
    } else if (pressed.name === "backspace")
      key = key.slice(0, -1);
    else if (text && !pressed.ctrl)
      key += text;
  };
  process.stdin.on("keypress", onKey);
  process.stdin.resume();
  process.stderr.write("Thegram API key (input hidden): ");
  return promise;
}
async function connect(args) {
  let mount;
  let url = "https://vault.thegram.one/mcp";
  for (let i = 0;i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || !["--mount", "--url"].includes(args[i]))
      throw new ThegramError("E_CONFIG", "Use connect [--mount <key>] [--url <endpoint>]; provide the API key on stdin");
    if (args[i] === "--mount")
      mount = value;
    else
      url = value;
  }
  url = validateEndpoint(url);
  const apiKey = await readKey();
  const previousKey = process.env.THEGRAM_API_KEY;
  const previousURL = process.env.THEGRAM_MCP_URL;
  try {
    process.env.THEGRAM_API_KEY = apiKey;
    process.env.THEGRAM_MCP_URL = url;
    const projects = await callTool("gram_projects", {}, 15000);
    const mounts = Array.isArray(projects.mounts) ? projects.mounts.filter(isJson).filter((item) => item.kind === "vault") : [];
    if (!mount && mounts.length === 1)
      mount = str(mounts[0].key);
    if (!mount && mounts.length > 1 && process.stdin.isTTY) {
      for (const [i, item] of mounts.entries())
        process.stderr.write(`${i + 1}. ${item.name} · ${item.key} · ${item.access}
`);
      const input = createInterface2({ input: process.stdin, output: process.stderr });
      try {
        const selected = Number(await input.question("Choose a Cloud vault number: "));
        if (Number.isInteger(selected) && selected > 0)
          mount = str(mounts[selected - 1]?.key);
      } finally {
        input.close();
      }
    }
    if (!mount || !mounts.some((item) => item.key === mount)) {
      const choices = mounts.map((item) => `${item.name}: ${item.key}`).join(`
`);
      throw new ThegramError("E_CONFIG", `Choose an accessible Cloud vault with --mount. Available vaults:
${choices || "(none; grant this API key access in Thegram Settings → Agents)"}`);
    }
    await saveConnection({ url, apiKey, mount });
    process.stdout.write(`Connected to ${url}
Cloud vault: ${mount}
Credential: ${connectionFile()} (private)
`);
    return 0;
  } finally {
    if (previousKey === undefined)
      delete process.env.THEGRAM_API_KEY;
    else
      process.env.THEGRAM_API_KEY = previousKey;
    if (previousURL === undefined)
      delete process.env.THEGRAM_MCP_URL;
    else
      process.env.THEGRAM_MCP_URL = previousURL;
  }
}
async function doctor(dir) {
  const lines = [`thegram-memory ${await packageVersion()} · node ${process.version}`];
  let failed = false;
  try {
    const settings = await connectionSettings();
    lines.push(`endpoint: ${settings.url}`);
    const projects = await callTool("gram_projects", {});
    const mounts = Array.isArray(projects.mounts) ? projects.mounts.filter(isJson) : [];
    lines.push(`Cloud: ${mounts.length} accessible mounts · selected ${settings.mount ?? "(not configured)"}`);
    if (settings.mount && !mounts.some((item) => item.key === settings.mount && item.kind === "vault")) {
      throw new ThegramError("E_FORBIDDEN", "The selected Cloud vault is not accessible to this API key");
    }
    const binding = await resolveProject(dir);
    if (!binding)
      lines.push(`project: none for ${dir} (not a git repository and no mapping)`);
    else {
      const via = binding.via === "repository" ? `bound by ${binding.tag}` : binding.via === "mapping" ? "projects.json mapping" : "root path only (run bind before moving it into a folder)";
      try {
        const brief = await callTool("gram_brief", { path: binding.path });
        const docs = Array.isArray(brief.docs) ? brief.docs.length : 0;
        lines.push(`project: ${binding.path} · ${docs} memory document · ${via}`);
      } catch (error) {
        if (errorCode(error) !== "E_NOT_FOUND")
          throw error;
        lines.push(`project: ${binding.path} · not created yet · ${via}`);
      }
      if (binding.others?.length)
        lines.push(`warning: ${binding.tag} is also on ${binding.others.join(", ")}`);
    }
  } catch (error) {
    failed = true;
    lines.push(`Cloud: unavailable (${errorCode(error)}: ${error instanceof Error ? error.message : String(error)})`);
  }
  const mapped = Object.keys(await loadProjectMap()).length;
  const localPolicy = await readFile2(path2.join(configDir(), "policy.md"), "utf8").then(() => "present", () => "absent");
  lines.push(`config: ${configDir()} · ${mapped} mapped directories · local policy ${localPolicy}`);
  lines.push(`hook state: ${stateDir()}`);
  process.stdout.write(`${lines.join(`
`)}
`);
  return failed ? 1 : 0;
}
async function bind(args) {
  const projectFlag = args.indexOf("--project");
  const chosen = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
  const dirArg = projectFlag >= 0 ? args.filter((_, index) => index !== projectFlag && index !== projectFlag + 1)[0] : args[0];
  const dir = path2.resolve(dirArg ?? process.cwd());
  const binding = await resolveProject(dir);
  if (!binding)
    throw new ThegramError("E_CONFIG", `${dir} is not a Git repository and has no mapping`);
  if (!binding.tag)
    throw new ThegramError("E_CONFIG", "This repository has no origin remote; map it in projects.json instead");
  if (binding.via === "repository") {
    process.stdout.write(`${binding.path}#${binding.projectId} already carries ${binding.tag}
`);
    return 0;
  }
  const listed = await callTool("gram_list", { path: binding.path, select: { type: "project" } });
  const ids = rowsOf(listed.records).map((row) => String(row[0]).slice(String(row[0]).lastIndexOf("#") + 1));
  if (ids.length === 0)
    throw new ThegramError("E_NOT_FOUND", `${binding.path} has no project record yet; it is tagged when it is created`);
  const project = chosen ?? (ids.length === 1 ? ids[0] : undefined);
  if (!project || !ids.includes(project)) {
    throw new ThegramError("E_ARGUMENT", `Choose the root project record with --project: ${ids.join(", ")}`);
  }
  const context = await callTool("gram_context", { ids: [{ path: binding.path, entity: project }], fields: ["tag"] });
  const item = Array.isArray(context.items) ? context.items.find(isJson) : undefined;
  const fields = item && isJson(item.fields) ? item.fields : {};
  const tags = Array.isArray(fields.tag) ? fields.tag.map(String) : [];
  if (tags.includes(binding.tag)) {
    process.stdout.write(`${binding.path}#${project} already carries ${binding.tag}
`);
    return 0;
  }
  const written = await callTool("gram_patch", {
    path: binding.path,
    request_id: `bind-${project}-${binding.tag}`.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 120),
    operations: [{ op: "set", entity: project, key: "tag", values: [...tags, binding.tag], old: tags.length ? tags : null }]
  });
  const doc = isJson(written.doc) ? written.doc : {};
  process.stdout.write(`${binding.path}#${project} now carries ${binding.tag} (r${String(doc.rev)}); the document can be moved into a folder.
`);
  return 0;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "connect":
      return connect(args);
    case "disconnect":
      await rm2(connectionFile(), { force: true });
      process.stdout.write(`Saved credential removed. Revoke the key in Thegram Settings → Agents if it should no longer work anywhere.
`);
      return 0;
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
    case "bind":
      return bind(args);
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
try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`thegram-memory: ${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 1;
}

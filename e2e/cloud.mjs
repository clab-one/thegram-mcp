import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = JSON.parse(await readFile(process.env.THEGRAM_E2E_STATE, 'utf8'));
assert(['127.0.0.1', '[::1]'].includes(new URL(state.server).hostname));
const reportPath = process.env.THEGRAM_E2E_REPORT;
assert(reportPath, 'THEGRAM_E2E_REPORT is required');
const config = await mkdtemp(path.join(os.tmpdir(), 'thegram-memory-cloud-e2e-'));
const mount = `@mounts/${state.vault}`;
let keyId;
async function account(method, route, body) {
  const response = await fetch(state.server + route, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `vault_session=${state.cookie}`, 'X-CSRF-Token': state.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${route}: HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}
try {
  const issued = await account('POST', '/v1/me/api-keys', { name: 'Coding agent E2E', vaults: { [state.vault]: 'write' }, drive: {} });
  assert(typeof issued.key === 'string' && issued.key.startsWith('tgk_'));
  keyId = issued.id;
  const env = { ...process.env, XDG_CONFIG_HOME: config };
  delete env.THEGRAM_API_KEY;
  delete env.THEGRAM_MCP_URL;
  delete env.THEGRAM_MCP_MOUNT;
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'dist/thegram-memory.mjs'), ...args], { env, encoding: 'utf8', timeout: 30000 });
  const connected = spawnSync(process.execPath, [path.join(root, 'dist/thegram-memory.mjs'), 'connect', '--mount', mount, '--url', state.server + '/mcp'], { env, input: issued.key + '\n', encoding: 'utf8', timeout: 30000 });
  assert.equal(connected.status, 0, connected.stderr);
  assert(!connected.stdout.includes(issued.key) && !connected.stderr.includes(issued.key));
  const credentialsPath = path.join(config, 'thegram-memory/connection.json');
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  delete process.env.THEGRAM_API_KEY;
  delete process.env.THEGRAM_MCP_URL;
  delete process.env.THEGRAM_MCP_MOUNT;
  Object.assign(process.env, env);
  const { callTool, newMemoryState, orient, observeTool } = await import('../src/core.ts');
  const projectName = `api-key-e2e-${randomUUID().slice(0, 8)}`;
  const repo = path.join(config, projectName);
  const init = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const document = `${mount}/${projectName}.gram`;
  const memory = newMemoryState();
  const missingMemory = await orient(memory, repo);
  assert.equal(memory.documentPath, document);
  assert.equal(memory.exists, false);
  assert.equal(memory.available, true);
  assert(missingMemory.sections.some(section => section.includes(document) && section.includes('gram_create')));
  await callTool('gram_create', {
    path: document, title: 'API key E2E', base_revision: null, template: 'project@1',
    content: {
      text: '# Overview\n\n[[prj-api-key]]\n\n# Decisions\n\n[[dec-api-key]]\n\n# Plan\n\n[[task-record-connection]]\n\n# Log\n',
      records: [
        { type: 'project', id: 'prj-api-key', fields: { t: ['API key E2E'], x: ['active'] } },
        { type: 'decision', id: 'dec-api-key', fields: { t: ['Use the scoped API connection'], d: ['The coding agent shares Cloud memory without a desktop app.'], x: ['accepted'] }, links: [['part-of', 'prj-api-key']] },
        { type: 'task', id: 'task-record-connection', fields: { t: ['Record the API connection outcome'], x: ['open'] }, links: [['part-of', 'prj-api-key']] },
      ],
    },
  });
  const orientation = await orient(memory, repo, 'scoped API connection');
  assert.equal(orientation.project, document);
  assert.equal(memory.documentPath, document);
  assert.equal(memory.exists, true);
  assert(orientation.sections.join('\n').includes('Record the API connection outcome'));
  const headWrite = await callTool('gram_patch', { path: document, request_id: `head-${randomUUID()}`, operations: [{ op: 'set', entity: 'task-record-connection', key: 'x', value: 'active', old: 'open' }] });
  assert.equal(headWrite.sync?.state, 'synced');
  await assert.rejects(callTool('gram_patch', { path: document, request_id: `stale-${randomUUID()}`, operations: [{ op: 'set', entity: 'task-record-connection', key: 'x', value: 'completed', old: 'open' }] }), error => error.code === 'E_PRECONDITION');
  for (let i = 0; i < 2; i++) observeTool(memory, { name: 'edit', input: {} });
  const reminder = observeTool(memory, { name: 'edit', input: {} });
  assert(reminder.includes(document) && reminder.includes('gram_brief {path:'));
  const doctor = cli('doctor', repo);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert(doctor.stdout.includes(document) && !doctor.stdout.includes('socket:'));
  const rpc = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coding-agent-e2e', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gram_brief', arguments: { path: document } } },
  ];
  const proxy = spawnSync(process.execPath, [path.join(root, 'dist/thegram-memory.mjs'), 'mcp'], { env, input: rpc.map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
  assert.equal(proxy.status, 0, proxy.stderr);
  const replies = proxy.stdout.trim().split('\n').map(x => JSON.parse(x));
  assert(replies.find(x => x.id === 1)?.result?.protocolVersion);
  const briefReply = replies.find(x => x.id === 2);
  assert(briefReply?.result && !briefReply.result.isError);
  assert(!proxy.stdout.includes(issued.key) && !proxy.stderr.includes(issued.key));
  await account('DELETE', '/v1/me/api-keys/' + encodeURIComponent(keyId));
  keyId = undefined;
  const revoked = cli('doctor', repo);
  assert.notEqual(revoked.status, 0);
  assert(revoked.stdout.includes('E_AUTH'));
  await writeFile(reportPath, JSON.stringify({ passed: true, endpoint: state.server + '/mcp', document, configMode: '0600', checks: ['key-backed CLI connect without desktop', 'no key in CLI output', 'new project reaches explicit document-creation guidance', 'created document becomes visible in the same session', 'project-scoped brief and recall', 'durable-write reminder targets exact document', 'stdio MCP initialization and tool call', 'revoked credential refused'] }, null, 2) + '\n');
  console.log('PASS coding agent Cloud MCP E2E');
} finally {
  if (keyId) await account('DELETE', '/v1/me/api-keys/' + encodeURIComponent(keyId));
  await rm(config, { recursive: true, force: true });
}

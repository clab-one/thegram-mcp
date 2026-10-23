import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statePath = process.env.THEGRAM_E2E_STATE;
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert(['127.0.0.1', '[::1]'].includes(new URL(state.server).hostname));
const reportPath = process.env.THEGRAM_E2E_REPORT;
assert(reportPath, 'THEGRAM_E2E_REPORT is required');
const config = await mkdtemp(path.join(os.tmpdir(), 'thegram-memory-cloud-e2e-'));
const checks = [];
const keys = [];
const report = { passed: false, endpoint: state.server + '/mcp', checks };
let worktree;
let repo;
const env = { ...process.env, XDG_CONFIG_HOME: config };
for (const key of ['THEGRAM_API_KEY', 'THEGRAM_MCP_URL', 'THEGRAM_MCP_MOUNT']) {
  delete env[key];
  delete process.env[key];
}
Object.assign(process.env, env);

async function account(index, method, route, body) {
  const credentials = state.accounts?.[index] ?? state;
  const response = await fetch(state.server + route, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `vault_session=${credentials.cookie}`, 'X-CSRF-Token': credentials.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert(response.ok, `${method} ${route.split('/').slice(0, 4).join('/')}: HTTP ${response.status}`);
  return text ? JSON.parse(text) : {};
}

function cli(...args) {
  return spawnSync(process.execPath, [path.join(root, 'dist/thegram-memory.mjs'), ...args], { env, encoding: 'utf8', timeout: 30000 });
}

function git(directory, ...args) {
  const gitEnv = { ...env, HOME: state.git_home ?? os.homedir() };
  delete gitEnv.XDG_CONFIG_HOME;
  const result = spawnSync('git', ['-C', directory, ...args], { env: gitEnv, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function scenario(name, run) {
  const start = Date.now();
  await run();
  checks.push({ name, passed: true, milliseconds: Date.now() - start });
  console.log(`PASS ${name}`);
}

async function issue(index, vaults) {
  const issued = await account(index, 'POST', '/v1/me/api-keys', { name: 'Coding discovery E2E', vaults, drive: {} });
  assert(typeof issued.key === 'string' && issued.key.startsWith('tgk_'), 'Fixture key was not issued');
  keys.push({ account: index, ...issued });
  return issued;
}

function connect(issued) {
  const connected = spawnSync(process.execPath, [path.join(root, 'dist/thegram-memory.mjs'), 'connect', '--url', state.server + '/mcp'], { env, input: issued.key + '\n', encoding: 'utf8', timeout: 30000 });
  assert.equal(connected.status, 0, connected.stderr);
  assert(!connected.stdout.includes(issued.key) && !connected.stderr.includes(issued.key), 'CLI exposed a fixture secret');
}

function idleReminders(core, memory) {
  for (let index = 0; index < 3; index++) assert.equal(core.observeTool(memory, { name: 'edit', input: {} }), undefined);
  assert.equal(core.stopReminder(memory), undefined);
}

try {
  const vaults = [];
  for (let index = 0; index < 2; index++) {
    const me = await account(index, 'GET', '/v1/me');
    await account(index, 'POST', '/v1/me/consent', { birthdate: '1990-01-01', terms: true, privacy: true, disclaimer: true, versions: me.consent_versions });
    vaults.push(await account(index, 'POST', '/v1/vaults', { name: `Coding fixture ${index}` }));
  }
  const extra = await account(0, 'POST', '/v1/vaults', { name: 'Other authorized vault' });
  const primary = await issue(0, { [vaults[0].id]: 'delete', [extra.id]: 'delete' });
  const secondary = await issue(1, { [vaults[1].id]: 'delete' });
  const mount = `@mounts/${vaults[0].id}`;
  const secondaryMount = `@mounts/${vaults[1].id}`;
  const document = `${mount}/a-current.gram`;
  const moved = `${mount}/moved/a-current.gram`;
  const secondaryDocument = `${secondaryMount}/same-repository.gram`;
  const repository = `example.test/team/discovery-${randomUUID().slice(0, 8)}`;
  const tag = `repo:${repository}`;
  repo = path.join(config, 'repository');
  await mkdir(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', `git@${repository.split('/')[0]}:${repository.split('/').slice(1).join('/')}.git`);
  const credentialsPath = path.join(config, 'thegram-memory/connection.json');
  const mappingPath = path.join(config, 'thegram-memory/projects.json');
  await scenario('packaged connect accepts all authorized vaults without a fixed selection', async () => {
    connect(primary);
    assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  });
  const core = await import('../src/core.ts');
  const { callTool, resolveProject, newMemoryState, orient } = core;
  const content = (title, tags = [tag]) => ({
    text: '# Overview\n\n[[prj-main]]\n\n# Plan\n\n[[task-record]]\n\n# Log\n',
    records: [
      { type: 'project', id: 'prj-main', fields: { t: [title], x: ['active'], tag: tags } },
      { type: 'task', id: 'task-record', fields: { t: ['Record the discovery outcome'], x: ['open'] }, links: [['part-of', 'prj-main']] },
    ],
  });
  await callTool('gram_create', { path: document, title: 'Project memory', base_revision: null, content: content('Project memory') });
  const memory = newMemoryState();
  await scenario('stale local paths cannot override an exact authorized project match', async () => {
    const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
    await writeFile(credentialsPath, JSON.stringify({ ...saved, mount: '@mounts/obsolete-vault' }), { mode: 0o600 });
    await writeFile(mappingPath, JSON.stringify({ [repo]: '@mounts/obsolete-vault/obsolete.gram' }));
    assert.equal((await resolveProject(repo)).path, document);
    await writeFile(mappingPath, '{malformed old configuration');
    const orientation = await orient(memory, repo);
    assert.equal(orientation.project, document);
    assert.equal(memory.documentPath, document);
    assert.equal(memory.available, true);
    assert.equal(memory.writable, true);
  });
  await scenario('discovered project supports a real durable write and readback', async () => {
    const receipt = await callTool('gram_patch', { path: memory.documentPath, request_id: `discovery-${randomUUID()}`, operations: [{ op: 'set', entity: 'task-record', key: 'x', value: 'active', old: 'open' }] });
    assert.equal(receipt.sync?.state, 'synced');
    const context = await callTool('gram_context', { ids: [{ path: memory.documentPath, entity: 'task-record' }], fields: ['x'] });
    assert.deepEqual(context.items[0].fields.x, ['active']);
    await assert.rejects(callTool('gram_patch', { path: memory.documentPath, request_id: `stale-${randomUUID()}`, operations: [{ op: 'set', entity: 'task-record', key: 'x', value: 'completed', old: 'open' }] }), error => error.code === 'E_PRECONDITION');
  });
  await scenario('same-session move resolves the current path before the next write', async () => {
    await callTool('gram_folder', { path: `${mount}/moved` });
    await callTool('gram_move', { path: document, to: moved });
    await orient(memory, repo);
    assert.equal(memory.documentPath, moved);
    const receipt = await callTool('gram_patch', { path: memory.documentPath, request_id: `moved-${randomUUID()}`, operations: [{ op: 'set', entity: 'task-record', key: 'x', value: 'completed', old: 'active' }] });
    assert.equal(receipt.sync?.state, 'synced');
    const context = await callTool('gram_context', { ids: [{ path: moved, entity: 'task-record' }], fields: ['x'] });
    assert.deepEqual(context.items[0].fields.x, ['completed']);
    report.resolved_after_move = moved;
  });
  await scenario('SSH HTTPS and linked worktrees discover the same project', async () => {
    git(repo, 'remote', 'set-url', 'origin', `https://${repository}.git`);
    assert.equal((await resolveProject(repo)).path, moved);
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initialize E2E repository');
    report.fixture_author = git(repo, 'log', '-1', '--format=%an <%ae>');
    console.log(`Fixture commit author: ${report.fixture_author}`);
    worktree = path.join(config, 'linked-worktree');
    git(repo, 'worktree', 'add', '--detach', worktree);
    assert.equal((await resolveProject(worktree)).path, moved);
    report.fixture_commit = git(repo, 'rev-parse', 'HEAD');
  });
  await scenario('doctor and actual stdio MCP use the discovered document', async () => {
    const doctor = cli('doctor', repo);
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    assert(doctor.stdout.includes(moved));
    const rpc = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'coding-discovery-e2e', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gram_brief', arguments: { path: moved } } },
    ];
    const proxy = spawnSync(process.execPath, [path.join(root, 'dist/thegram-memory.mjs'), 'mcp'], { env, input: rpc.map(item => JSON.stringify(item)).join('\n') + '\n', encoding: 'utf8', timeout: 30000 });
    assert.equal(proxy.status, 0, proxy.stderr);
    const replies = proxy.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert(replies.find(item => item.id === 1)?.result?.protocolVersion);
    const reply = replies.find(item => item.id === 2)?.result;
    const brief = reply?.structuredContent ?? JSON.parse(reply.content.find(part => part.type === 'text').text);
    assert(brief.docs.some(doc => Array.isArray(doc) ? doc[0] === moved : doc.path === moved));
    assert(!proxy.stdout.includes(primary.key) && !proxy.stderr.includes(primary.key));
  });
  await scenario('duplicate documents and duplicate root associations both fail closed', async () => {
    const duplicate = `${mount}/z-duplicate.gram`;
    await callTool('gram_create', { path: duplicate, title: 'Duplicate identity', base_revision: null, content: content('Duplicate identity') });
    await assert.rejects(resolveProject(repo), error => error.code === 'E_PROJECT_AMBIGUOUS');
    const denied = await orient(memory, repo);
    assert(denied.sections.some(section => section.includes('E_PROJECT_AMBIGUOUS')));
    assert.equal(memory.available, false);
    assert.equal(memory.documentPath, undefined);
    idleReminders(core, memory);
    await callTool('gram_delete', { path: duplicate });
    await callTool('gram_patch', { path: moved, request_id: `second-root-${randomUUID()}`, operations: [{ op: 'add', record: { type: 'project', id: 'prj-another-root', fields: { t: ['Another root'], x: ['active'], tag: [tag] } }, place: { section: 'Overview' } }] });
    await assert.rejects(resolveProject(repo), error => error.code === 'E_PROJECT_AMBIGUOUS');
    await callTool('gram_patch', { path: moved, request_id: `unroot-${randomUUID()}`, operations: [{ op: 'unset', entity: 'prj-another-root', key: 'tag', old: [tag] }] });
  });
  await scenario('a deleted binding cannot invent or recreate a destination', async () => {
    await orient(memory, repo);
    const trashed = await callTool('gram_delete', { path: moved });
    await assert.rejects(resolveProject(repo), error => error.code === 'E_PROJECT_NOT_FOUND');
    await orient(memory, repo);
    assert.equal(memory.available, false);
    assert.equal(memory.documentPath, undefined);
    idleReminders(core, memory);
    const listed = await callTool('gram_list', { select: { type: 'project', tag } });
    assert.deepEqual(listed.records, []);
    await callTool('gram_restore', { path: mount, id: trashed.id });
  });
  await scenario('the same credential observes live grant narrowing and revocation', async () => {
    await orient(memory, repo);
    const metadata = (await account(0, 'GET', '/v1/me/api-keys')).keys.find(key => key.id === primary.id);
    const readOnly = await account(0, 'PATCH', '/v1/me/api-keys/' + primary.id, { revision: metadata.revision, vaults: { [vaults[0].id]: 'read', [extra.id]: 'delete' }, drive: {} });
    await orient(memory, repo);
    assert.equal(memory.documentPath, moved);
    assert.equal(memory.writable, false);
    idleReminders(core, memory);
    const bindDenied = cli('bind', repo, '--document', moved, '--project', 'prj-main');
    assert.notEqual(bindDenied.status, 0);
    assert(bindDenied.stderr.includes('E_READ_ONLY'));
    await assert.rejects(callTool('gram_patch', { path: moved, request_id: `denied-${randomUUID()}`, operations: [{ op: 'set', entity: 'task-record', key: 'x', value: 'active', old: 'completed' }] }), error => error.code === 'AGENT_SCOPE_DENIED');
    await account(0, 'PATCH', '/v1/me/api-keys/' + primary.id, { revision: readOnly.revision, vaults: { [extra.id]: 'delete' }, drive: {} });
    await orient(memory, repo);
    assert.equal(memory.available, false);
    assert.equal(memory.documentPath, undefined);
    idleReminders(core, memory);
    const current = (await account(0, 'GET', '/v1/me/api-keys')).keys.find(key => key.id === primary.id);
    await account(0, 'PATCH', '/v1/me/api-keys/' + primary.id, { revision: current.revision, vaults: { [vaults[0].id]: 'delete', [extra.id]: 'delete' }, drive: {} });
  });
  await scenario('OpenCode removes the previous account document from injected context', async () => {
    const adapter = (await import('../src/opencode.ts')).default;
    const host = await adapter.server({ directory: repo });
    const prompt = async () => {
      await host['chat.message']({ sessionID: 'discovery-session' }, { parts: [{ type: 'text', text: 'Inspect project discovery context' }] });
      const output = { system: [] };
      await host['experimental.chat.system.transform']({ sessionID: 'discovery-session' }, output);
      return output.system.join('\n');
    };
    assert((await prompt()).includes(moved));
    connect(secondary);
    const switched = await prompt();
    assert(!switched.includes(moved));
    assert(switched.includes('E_PROJECT_NOT_FOUND'));
    connect(primary);
    assert((await prompt()).includes(moved));
  });
  await scenario('account switches cannot carry another account project or writable state', async () => {
    await orient(memory, repo);
    assert.equal(memory.documentPath, moved);
    connect(secondary);
    await orient(memory, repo);
    assert.equal(memory.available, false);
    assert.equal(memory.documentPath, undefined);
    assert.equal(memory.writable, undefined);
    idleReminders(core, memory);
    await callTool('gram_create', { path: secondaryDocument, title: 'Other account memory', base_revision: null, content: content('Other account memory') });
    await orient(memory, repo);
    assert.equal(memory.documentPath, secondaryDocument);
    assert.equal(memory.writable, true);
    connect(primary);
    await orient(memory, repo);
    assert.equal(memory.documentPath, moved);
  });
  await scenario('explicit association preserves tags and supports positional repositories and rebinding', async () => {
    const workspace = path.join(config, 'workspace');
    await mkdir(workspace);
    await assert.rejects(resolveProject(workspace), error => error.code === 'E_PROJECT_IDENTITY');
    const untagged = `${mount}/explicit-association.gram`;
    await callTool('gram_create', { path: untagged, title: 'Explicit association', base_revision: null, content: content('Explicit association', ['preserve-existing']) });
    const wrongDestination = cli('bind', workspace, '--document', '@mounts/google-drive-unapproved/project.gram', '--repository', 'example.test/team/unapproved', '--project', 'prj-main');
    assert.notEqual(wrongDestination.status, 0);
    assert(wrongDestination.stderr.includes('E_PROJECT_DESTINATION'));
    const conflict = cli('bind', workspace, '--document', untagged, '--repository', repository, '--project', 'prj-main');
    assert.notEqual(conflict.status, 0);
    assert(conflict.stderr.includes('E_PROJECT_AMBIGUOUS'));
    const unchanged = await callTool('gram_context', { ids: [{ path: untagged, entity: 'prj-main' }], fields: ['tag'] });
    assert.deepEqual(unchanged.items[0].fields.tag, ['preserve-existing']);
    const explicitRepository = 'example.test/team/subgroup/explicit-association';
    git(workspace, 'init', '--quiet');
    await assert.rejects(resolveProject(workspace), error => error.code === 'E_PROJECT_IDENTITY');
    git(workspace, 'remote', 'add', 'origin', `https://${explicitRepository}.git`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const bound = cli('bind', workspace, '--document', untagged, '--project', 'prj-main');
      assert.equal(bound.status, 0, bound.stdout + bound.stderr);
      const context = await callTool('gram_context', { ids: [{ path: untagged, entity: 'prj-main' }], fields: ['tag'] });
      assert.deepEqual(new Set(context.items[0].fields.tag), new Set(['preserve-existing', `repo:${explicitRepository}`]));
      assert.equal((await resolveProject(workspace)).path, untagged);
      if (attempt === 0) await callTool('gram_patch', { path: untagged, request_id: `unbind-${randomUUID()}`, operations: [{ op: 'set', entity: 'prj-main', key: 'tag', values: ['preserve-existing'], old: context.items[0].fields.tag }] });
    }
    assert.equal(await readFile(mappingPath, 'utf8'), '{malformed old configuration');
  });
  await scenario('explicit association finds a project record on a later result page', async () => {
    const paged = `${mount}/paged-projects.gram`;
    const records = Array.from({ length: 24 }, (_, index) => ({ type: 'project', id: `prj-page-${index}`, fields: { t: [`Project ${index} ${'x'.repeat(900)}`], x: ['active'] } }));
    await callTool('gram_create', { path: paged, title: 'Paged projects', base_revision: null, content: { text: '# Overview\n\n' + records.map(record => `[[${record.id}]]`).join('\n\n') + '\n', records } });
    const first = await callTool('gram_list', { path: paged, select: { type: 'project' } });
    assert.equal(typeof first.more, 'string');
    assert(!first.records.some(row => row[0].endsWith('prj-page-23')));
    const pagedIdentity = 'example.test/team/paged-association';
    const bound = cli('bind', '--document', paged, '--repository', pagedIdentity, '--project', 'prj-page-23', config);
    assert.equal(bound.status, 0, bound.stdout + bound.stderr);
    const context = await callTool('gram_context', { ids: [{ path: paged, entity: 'prj-page-23' }], fields: ['tag'] });
    assert.deepEqual(context.items[0].fields.tag, [`repo:${pagedIdentity}`]);
  });
  await scenario('real terminal connection keeps secrets hidden without a fixed mount', async () => {
    await writeFile(statePath, JSON.stringify({ ...state, vault: vaults[0].id }), { mode: 0o600 });
    const tty = spawnSync('python3', [path.join(root, 'e2e/hidden_tty.py'), '--state', statePath, '--evidence', path.join(path.dirname(reportPath), 'tty.json')], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(tty.status, 0, tty.stdout + tty.stderr);
    assert.equal(JSON.parse(await readFile(path.join(path.dirname(reportPath), 'tty.json'), 'utf8')).secretNotEchoed, true);
  });
  await scenario('revoked credentials clear old state and cannot fall back to a local path', async () => {
    await account(0, 'DELETE', '/v1/me/api-keys/' + primary.id);
    primary.revoked = true;
    keys.find(key => key.id === primary.id).revoked = true;
    await orient(memory, repo);
    assert.equal(memory.available, false);
    assert.equal(memory.documentPath, undefined);
    idleReminders(core, memory);
    const revoked = cli('doctor', repo);
    assert.notEqual(revoked.status, 0);
    assert(revoked.stdout.includes('E_AUTH'));
  });
  report.passed = true;
  console.log('PASS complete coding-agent Cloud discovery E2E');
} catch (error) {
  let message = error instanceof Error ? error.stack : String(error);
  for (const key of keys) message = message.replaceAll(key.key, '[REDACTED]');
  report.error = message;
  throw error;
} finally {
  const cleanup = async (name, operation) => {
    try {
      await operation();
    } catch (error) {
      let message = String(error);
      for (const key of keys) message = message.replaceAll(key.key, '[REDACTED]');
      (report.cleanup_errors ??= []).push({ name, error: message });
      report.passed = false;
      process.exitCode = 1;
    }
  };
  for (const key of keys) {
    if (!key.revoked) await cleanup('revoke synthetic key', () => account(key.account, 'DELETE', '/v1/me/api-keys/' + key.id));
  }
  if (worktree) await cleanup('remove synthetic worktree', async () => {
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    git(repo, 'worktree', 'remove', worktree);
  });
  await cleanup('remove private temporary config', () => rm(config, { recursive: true, force: true }));
  report.temporary_config_removed = await stat(config).then(() => false, () => true);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

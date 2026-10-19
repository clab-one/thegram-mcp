// LLM authoring E2E: a real agent (Codex CLI) records scheduled-automation runs into Cloud documents through one skill
// version, then this reads the documents back and scores them against the contract the automation dashboards read.
// Usage: node e2e/authoring/run.mjs --skill <skills/thegram-memory dir> --variant <name> --doc-root <@mounts/<vault>/<folder>>
//          --out <dir> [--model gpt-6.1-sol] [--ui <thegram-ui checkout>] [--only <scenario>] [--score-only]
// Output: <out>/<variant>/report.json, plus each run's agent events and final message. Needs a connected thegram-memory CLI.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: arg } = parseArgs({ options: {
  skill: { type: 'string' }, variant: { type: 'string' }, 'doc-root': { type: 'string' }, out: { type: 'string' },
  model: { type: 'string', default: 'gpt-6.1-sol' }, ui: { type: 'string' }, only: { type: 'string' }, 'score-only': { type: 'boolean', default: false },
} });
for (const key of ['skill', 'variant', 'doc-root', 'out']) if (!arg[key]) throw new Error(`--${key} is required`);
const spec = JSON.parse(readFileSync(path.join(here, 'scenarios.json'), 'utf8'));
const cli = path.resolve(here, '../../dist/thegram-memory.mjs');
const out = path.resolve(arg.out, arg.variant);
mkdirSync(out, { recursive: true });

function mcp() {
  const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '', next = 0;
  const waiting = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const message = line.trim() ? JSON.parse(line) : null;
      if (message?.id !== undefined && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  const send = (method, params, notify = false) => new Promise(resolve => {
    const message = { jsonrpc: '2.0', method, params };
    if (!notify) { message.id = ++next; waiting.set(message.id, resolve); } else resolve(null);
    child.stdin.write(JSON.stringify(message) + '\n');
  });
  const call = async (name, args) => {
    const reply = await send('tools/call', { name, arguments: args });
    if (reply.error) throw new Error(`${name}: ${JSON.stringify(reply.error)}`);
    const text = reply.result.content.filter(item => item.type === 'text').map(item => item.text).join('');
    const parsed = (() => { try { return JSON.parse(text); } catch { return text; } })();
    if (reply.result.isError) throw Object.assign(new Error(`${name}: ${text.slice(0, 300)}`), { body: parsed });
    return parsed;
  };
  return { ready: send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'authoring-e2e', version: '1' } }).then(() => send('notifications/initialized', {}, true)), call, close: () => child.kill() };
}

async function ensureDocument(client, docPath, scenario) {
  try { await client.call('gram_brief', { path: docPath }); return; } catch { /* created below */ }
  const { title, project } = scenario.document;
  await client.call('gram_create', { path: docPath, base_revision: null, title: `E2E ${title} (${arg.variant})`, request_id: `e2e-${scenario.id}-${arg.variant}-${Date.now()}`,
    content: { text: `# ${title}\n\n## 개요\n\n[[${project.id}]]\n\n## Log\n`, records: [{ type: 'project', id: project.id, fields: { t: [project.t], x: ['active'], d: [project.d] } }] } });
}

/** The skill as a Codex project instruction file, with its references beside it. */
function workdir(name) {
  const dir = path.join(out, 'work', name);
  mkdirSync(dir, { recursive: true });
  const skill = readFileSync(path.join(arg.skill, 'SKILL.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  writeFileSync(path.join(dir, 'AGENTS.md'), skill);
  cpSync(path.join(arg.skill, 'references'), path.join(dir, 'references'), { recursive: true });
  cpSync(path.join(arg.skill, 'backfill.md'), path.join(dir, 'backfill.md'));
  return dir;
}

function runAgent(dir, prompt) {
  const started = Date.now();
  const result = spawnSync('codex', ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-m', arg.model, '-s', 'read-only', '-C', dir,
    '-c', 'approval_policy="never"', '-c', 'mcp_servers.thegram.command="node"', '-c', `mcp_servers.thegram.args=[${JSON.stringify(cli)},"mcp"]`,
    // The automation is authorized to write its document; only this server's tools skip the prompt, the shell stays read-only.
    '-c', 'mcp_servers.thegram.default_tools_approval_mode="approve"',
    '--json', '-o', path.join(dir, 'last.txt'), prompt], { encoding: 'utf8', input: '', timeout: 15 * 60_000, maxBuffer: 64 << 20 });
  writeFileSync(path.join(dir, 'events.jsonl'), result.stdout ?? '');
  const calls = (result.stdout ?? '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(event => event?.type === 'item.completed' && event.item?.type === 'mcp_tool_call')
    .map(event => ({ tool: event.item.tool, status: event.item.status, error: event.item.error ? String(event.item.error.message ?? event.item.error).slice(0, 200) : undefined }));
  let last = '';
  try { last = readFileSync(path.join(dir, 'last.txt'), 'utf8').trim(); } catch { /* no final message */ }
  return { exit: result.status, seconds: Math.round((Date.now() - started) / 1000), calls, last };
}

async function records(client, docPath) {
  const ids = [];
  let page = await client.call('gram_list', { path: docPath });
  for (;;) { ids.push(...page.entities.map(([id, type]) => ({ id, type }))); if (!page.more) break; page = await client.call('gram_list', { path: docPath, cursor: page.more }); }
  const fields = ['t', 'd', 'x', 'at', 'end', 'due', 'p', 'ref', 'tag', 'source'];
  const out = [];
  for (let i = 0; i < ids.length; i += 40) {
    const request = { ids: ids.slice(i, i + 40).map(({ id }) => ({ path: docPath, entity: id })), fields };
    let reply = await client.call('gram_context', request);
    for (;;) { for (const item of reply.items ?? []) out.push({ id: item.id.split('#').pop(), type: item.type, fields: item.fields ?? {}, links: (item.links ?? []).map(([predicate, target]) => ({ predicate, target: target.split('#').pop() })) }); if (!reply.more) break; reply = await client.call('gram_context', { ...request, cursor: reply.more }); }
  }
  const outline = await client.call('gram_read', { path: docPath });
  let body = '';
  for (const [, , node] of outline.outline ?? []) {
    let section = await client.call('gram_read', { path: docPath, section: node });
    for (;;) { body += section.md ?? ''; if (!section.more) break; section = await client.call('gram_read', { path: docPath, section: node, cursor: section.more }); }
  }
  return { records: out, body };
}

const first = (record, key) => record.fields[key]?.[0] ?? null;
const tags = record => record.fields.tag ?? [];
const time = value => (value ? Date.parse(value.length === 10 ? value + 'T00:00:00+09:00' : value) : NaN);
const mentions = (record, url) => (record.fields.ref ?? []).includes(url) || (record.fields.d ?? []).some(text => text.includes(url)) || (record.fields.t ?? []).some(text => text.includes(url));
const related = (a, b) => a.links.some(link => link.target === b.id) || b.links.some(link => link.target === a.id);

function score(scenario, { records: all, body }) {
  const expect = scenario.expect;
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  const runs = all.filter(record => record.type === 'event' && tags(record).includes('run'));
  check('run records', runs.length === expect.runs.length, runs.map(run => first(run, 'at')));
  const runFor = expect.runs.map(want => runs.find(run => time(first(run, 'at')) === time(want.at)) ?? null);
  expect.runs.forEach((want, index) => {
    const run = runFor[index];
    check(`run ${index + 1} at ${want.at}`, run);
    check(`run ${index + 1} failed sources`, run && JSON.stringify(tags(run).filter(tag => tag.startsWith('failed:')).map(tag => tag.slice(7)).sort()) === JSON.stringify([...want.failed].sort()), run && tags(run));
  });
  const byUrl = new Map(expect.items.map(item => [item.url, all.filter(record => !tags(record).includes('run') && record.type !== 'project' && mentions(record, item.url) && !['task', 'risk'].includes(record.type) && !tags(record).includes('target'))]));
  for (const item of expect.items) {
    const found = byUrl.get(item.url);
    const record = found.find(candidate => (candidate.fields.ref ?? []).includes(item.url)) ?? found[0];
    check(`item ${item.url} recorded once`, found.length === 1, found.map(candidate => candidate.id));
    check(`item ${item.url} ref`, record && (record.fields.ref ?? []).includes(item.url));
    check(`item ${item.url} at`, record && (item.at === false ? !first(record, 'at') : !!first(record, 'at')), record && first(record, 'at'));
    check(`item ${item.url} source tag`, record && tags(record).some(tag => tag.startsWith('source:')), record && tags(record));
    const run = runFor[item.run];
    check(`item ${item.url} derives from its run`, record && !!run && record.links.some(link => link.predicate === 'derives' && link.target === run.id), record?.links);
    check(`item ${item.url} derives from no later run`, record && !!run && record.links.every(link => link.predicate !== 'derives' || link.target === run.id), record?.links);
  }
  const itemOf = url => byUrl.get(url)?.find(candidate => (candidate.fields.ref ?? []).includes(url)) ?? byUrl.get(url)?.[0];
  for (const [a, b] of expect.same_topic) {
    const topic = record => tags(record ?? { fields: {} }).find(tag => tag.startsWith('topic:'));
    check(`same topic ${a} ~ ${b}`, topic(itemOf(a)) && topic(itemOf(a)) === topic(itemOf(b)), [topic(itemOf(a)), topic(itemOf(b))]);
  }
  for (const want of expect.tasks) {
    const item = itemOf(want.url);
    const task = all.find(record => record.type === 'task' && (item ? related(record, item) : false)) ?? all.find(record => record.type === 'task' && mentions(record, want.url));
    check(`task for ${want.url}`, task, task?.id);
    check(`task due ${want.due}`, task && first(task, 'due') === want.due, task && first(task, 'due'));
  }
  for (const want of expect.risks) {
    const item = itemOf(want.url);
    const target = expect.targets.find(t => t.url === want.url);
    const targetRecord = target ? all.find(record => tags(record).includes('target') && (first(record, 't') ?? '').toLowerCase().includes(target.name)) : null;
    check(`risk for ${want.url}`, all.some(record => record.type === 'risk' && ((item && related(record, item)) || (targetRecord && related(record, targetRecord)))));
  }
  for (const want of expect.targets) {
    const target = all.filter(record => tags(record).includes('target') && (first(record, 't') ?? '').toLowerCase().includes(want.name));
    check(`target ${want.name} once`, target.length === 1, target.map(record => record.id));
    const item = itemOf(want.url);
    check(`detection related to ${want.name}`, target[0] && item && related(item, target[0]));
  }
  for (const want of expect.ranges) {
    const item = itemOf(want.url);
    const event = item?.type === 'event' ? item : all.find(record => record.type === 'event' && !tags(record).includes('run') && item && related(record, item));
    check(`event at ${want.at}`, event && time(first(event, 'at')) === time(want.at), event && first(event, 'at'));
    if (want.end) check(`event end ${want.end}`, event && time(first(event, 'end')) === time(want.end), event && first(event, 'end'));
  }
  const firstDay = scenario.runs[0].now.slice(0, 10);
  const overdue = all.filter(record => record.type === 'task' && first(record, 'due') && first(record, 'due').slice(0, 10) < firstDay);
  check('no task created overdue', !overdue.length, overdue.map(record => `${record.id} due ${first(record, 'due')}`));
  const titled = all.filter(record => /\[(완료|과거|진행|예정|기준)\]|\((기준|완료)\)/.test(first(record, 't') ?? ''));
  check('no status in titles', !titled.length, titled.map(record => record.id));
  const unplaced = all.filter(record => record.type !== 'project' && !body.includes(record.id));
  check('every record placed', !unplaced.length, unplaced.map(record => record.id));
  return { passed: checks.filter(c => c.pass).length, total: checks.length, checks };
}

async function widgetView(all) {
  if (!arg.ui) return null;
  registerHooks({ load(url, context, nextLoad) { return nextLoad(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context); } });
  const model = await import(pathToFileURL(path.join(arg.ui, 'src/features/dashboard/model/automation.ts')));
  const owners = all.map(record => ({ ...record, args: [], blocks: [], rich: null }));
  const runs = model.runsOf(owners);
  const usual = model.cadence(runs);
  return {
    cadence: usual ? model.cadenceText(usual) : null,
    runs: runs.map(run => ({ id: run.record.id, at: new Date(run.at).toISOString(), found: run.found.length, failed: run.failed })),
    latestTopics: model.byTopic(runs[0]?.found ?? []).map(group => ({ label: group.label, records: group.records.length })),
    sources: model.bySource(model.foundRecords(runs)).map(group => [group.source, group.records.length]),
    watches: model.watches(owners, new Date('2026-10-19T16:30:00+09:00')).map(watch => ({ target: watch.target.id, hits: watch.hits.length, next: watch.next?.phase ?? null })),
  };
}

const client = mcp();
await client.ready;
const report = { variant: arg.variant, model: arg.model, skill: path.resolve(arg.skill), startedAt: new Date().toISOString(), scenarios: [] };
for (const scenario of spec.scenarios.filter(item => !arg.only || item.id === arg.only)) {
  const docPath = `${arg['doc-root']}/${scenario.id}-${arg.variant}.gram`;
  const runs = [];
  if (!arg['score-only']) {
    await ensureDocument(client, docPath, scenario);
    for (const [index, run] of scenario.runs.entries()) {
      const prompt = spec.prompt.replace('{automation}', scenario.automation).replace('{path}', docPath).replace('{now}', run.now).replace('{inputs}', run.inputs.join('\n'));
      const result = runAgent(workdir(`${scenario.id}-run${index + 1}`), prompt);
      runs.push({ now: run.now, ...result });
      console.log(`${arg.variant} ${scenario.id} run ${index + 1}: exit ${result.exit}, ${result.seconds}s, ${result.calls.length} tool calls`);
    }
  }
  const read = await records(client, docPath);
  const result = score(scenario, read);
  report.scenarios.push({ id: scenario.id, document: docPath, runs, score: { passed: result.passed, total: result.total }, checks: result.checks, widgets: await widgetView(read.records), records: read.records });
  console.log(`${arg.variant} ${scenario.id}: ${result.passed}/${result.total}`);
}
client.close();
report.finishedAt = new Date().toISOString();
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');

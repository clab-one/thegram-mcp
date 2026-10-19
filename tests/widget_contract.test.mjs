/** Offline tests of authoring fixtures against the actual UI data selectors and Core's record vocabulary.
 * THEGRAM_UI_SOURCE=/path/to/thegram-ui GRAM_CORE_BINARY=/path/to/gram node --test tests/widget_contract.test.mjs
 * Reads UI sources and asks the local Core binary for its vocabulary. No browser, live server, document or credentials.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

registerHooks({ load(url, context, nextLoad) {
  return nextLoad(url, url.endsWith('.json') ? { ...context, importAttributes: { type: 'json' } } : context);
} });
const root = process.env.THEGRAM_UI_SOURCE;
if (!root) throw new Error('Set THEGRAM_UI_SOURCE to the read-only UI source checkout under test');
if (!process.env.GRAM_CORE_BINARY) throw new Error('Set GRAM_CORE_BINARY to the native Core whose vocabulary the UI reads');
const data = await import(pathToFileURL(path.join(root, 'src/features/dashboard/model/data.ts')));
const registry = await import(pathToFileURL(path.join(root, 'src/features/dashboard/model/registry.ts')));
const vocabulary = JSON.parse(execFileSync(process.env.GRAM_CORE_BINARY, { input: JSON.stringify({ op: 'templates' }) }).toString()).templates[0];
const { cases } = JSON.parse(await readFile(new URL('../skills/thegram-memory/references/classification.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(cases.map(c => [c.id, c]));
const asOwner = record => ({ ...structuredClone(record), args: [], blocks: [], links: record.links.map(([predicate, target]) => ({ predicate, target })) });
function replay(id) {
  const c = byId[id];
  const records = new Map(c.initial.map(r => [r.id, asOwner(r)]));
  const changes = new Map();
  for (const op of c.plan.operations) {
    if (op.op === 'add') {
      records.set(op.record.id, asOwner(op.record));
      changes.set(op.record.id, { id: op.record.id, change: 'added', fields: [] });
    } else if (op.op === 'set') {
      const r = records.get(op.entity);
      const before = r.fields[op.key] ?? [];
      const after = op.values ?? [op.value];
      const change = changes.get(op.entity) ?? { id: op.entity, change: 'changed', fields: [] };
      change.fields.push({ key: op.key, before, after });
      changes.set(op.entity, change);
      r.fields[op.key] = after;
    } else if (op.op === 'link') records.get(op.entity).links.push({ predicate: op.predicate, target: op.target });
  }
  const history = c.plan.operations.length ? [{ revision: 1, recordedAt: '2026-10-19T12:00:00Z', changes: [...changes.values()] },
    { revision: 0, recordedAt: '2026-10-19T11:00:00Z', changes: c.initial.map(r => ({ id: r.id, change: 'added', fields: [] })) }] : [];
  return { records: [...records.values()], history };
}
const context = { template: vocabulary, now: new Date('2026-10-19T12:00:00Z') };
const ids = rows => rows.map(r => r.id);
const select = (kind, records, options) => data.selection(registry.widgetSpec(kind), records, options);

test('runtime widgets do not need fake events', t => {
  for (const kind of ['activity-feed','activity-heatmap','agent-live','my-inbox','handoff','team-pulse'])
    assert.equal(registry.widgetSpec(kind).needs, 'history');
  for (const kind of ['presence','org-portfolio','team-roster'])
    assert.ok(['presence.read','workspace.read','people.read'].includes(registry.widgetSpec(kind).capability));
  t.diagnostic(`Actual UI selectors imported from ${root}`);
});

test('mixed commit feeds distinct decision/knowledge/evidence selectors, no task/calendar event', () => {
  const { records } = replay('mixed-commit');
  assert.deepEqual(ids(select('decision-log', records)), ['dec-retry-cache']);
  assert.deepEqual(ids(select('knowledge-card', records)), ['src-mixed','know-token-expiry','evd-expiry']);
  assert.deepEqual(ids(select('evidence-count', records)), ['evd-expiry']);
  assert.equal(select('task-board', records).length, 0);
  assert.equal(select('day-agenda', records).length, 0);
});

test('proposed ADR stays pending and partial task stays active despite merged stage-1 code', () => {
  const { records } = replay('open-adr-partial-implementation');
  const pending = select('decision-pending', records).filter(r => data.recordClass(context, r) === 'open');
  assert.deepEqual(ids(pending), ['dec-adr-0047']);
  assert.deepEqual(ids(select('task-board', records, { status: 'active' })), ['task-ethereum']);
  assert.equal(data.share(context, select('task-board', records)).value, 0);
});

test('unmerged failed-verification PR feeds review task and blocker attention, not completion/event', () => {
  const { records } = replay('unmerged-pr-failed-verification');
  assert.deepEqual(ids(select('task-board', records, { status: 'review' })), ['task-review']);
  assert.deepEqual(data.attention(context, records).map(r => [r.record.id, r.reason]), [['blk-grant','blocker']]);
  assert.equal(data.share(context, select('task-board', records)).done, 0);
  assert.equal(select('day-agenda', records).length, 0);
});

test('recurring fixes preserve one work item and do not inflate task denominator', () => {
  const { records } = replay('recurring-fixes');
  assert.deepEqual(ids(select('task-checklist', records)), ['task-retry']);
  assert.deepEqual(data.share(context, select('task-checklist', records)), { done: 0, total: 1, value: 0, closed: 0 });
});

test('actual deployment report contributes occurrence date, artifact edge and completion of existing scoped task', () => {
  const { records } = replay('deployment-report');
  const event = select('day-agenda', records)[0];
  assert.equal(data.whenOf(event).raw, '2026-10-13T10:15:00Z');
  assert.equal(data.dateField(event), 'at');
  const goal = records.find(r => r.id === 'goal-rollout');
  assert.equal(data.share(context, data.goalTasks(goal, records)).value, 1);
  assert.equal(data.status(goal), 'active');  // child check is not completion of entire goal
  assert.ok(data.edges(records).some(e => e.from === 'art-r7' && e.predicate === 'derives' && e.to === event.id));
});

test('saved widget selection intersects type, exact status and IDs, with no duplicate records', () => {
  const { records } = replay('open-adr-partial-implementation');
  const repeated = [...records, records.find(r => r.id === 'task-ethereum')];
  assert.deepEqual(ids(select('task-board', repeated, { recordIds: ['task-ethereum','dec-adr-0047'], recordType: 'task', status: 'active' })), ['task-ethereum']);
  assert.deepEqual(select('task-board', repeated, { status: 'review' }), []);
  assert.deepEqual(select('task-board', repeated, { recordIds: ['missing-task'] }), []);
});

test('current share excludes closed/unknown status and keeps no-denominator null; a type\'s own status list wins', () => {
  const base = asOwner(byId['deployment-report'].initial.find(r => r.id === 'task-verify'));
  const rows = ['completed','active','cancelled',null].map((x,i) => ({ ...base, id: `test-${i}`, fields: { ...base.fields, x: x ? [x] : [] } }));
  assert.deepEqual(data.share(context, rows), { done: 1, total: 2, value: 0.5, closed: 1 });
  assert.equal(data.share(context, rows.slice(2)).value, null);
  assert.equal(data.classOf({ template: { records: { task: { statuses: [{ value: 'review', class: 'closed' }] } } } }, 'task', 'review'), 'closed');
});

test('goal requires outgoing task part-of; related does not affect its ratio', () => {
  const { records } = replay('deployment-report');
  const goal = records.find(r => r.id === 'goal-rollout');
  const wrong = records.map(r => r.type === 'task' ? { ...r, links: r.links.map(l => ({ ...l, predicate: 'related' })) } : r);
  assert.equal(data.goalTasks(goal, wrong).length, 0);
  assert.equal(data.share(context, data.goalTasks(goal, wrong)).value, null);
});

test('metric selector keeps one series and reconstructs two actual observations from field changes', () => {
  const { records, history } = replay('stable-metric-series');
  const metrics = select('metric-trend', records);
  assert.equal(metrics.length, 1);
  assert.equal(data.dateField(metrics[0]), 'observed');
  const series = data.series(metrics[0], history, 1);
  assert.deepEqual(series.points.map(p => [p.value,p.observed]), [[99.7,'2026-10-10T09:00:00Z'],[99.9,'2026-10-11T09:00:00Z']]);
  assert.equal(series.unit, 'percent');
  assert.ok(Math.abs(series.delta - 0.2) < 1e-10);
  assert.equal(data.series(metrics[0], [], 1).points.length, 1); // readiness does not prove useful trend history
  const changedUnit = structuredClone(history);
  changedUnit[0].changes.find(c => c.id === metrics[0].id).fields.push({ key: 'unit', before: ['requests'], after: ['percent'] });
  assert.equal(data.series(metrics[0], changedUnit, 1).points.length, 1);
});

test('source dates do not create calendar entries or old activity revisions', () => {
  const { records, history } = replay('image-pins-coverage');
  assert.equal(select('day-agenda', records).length, 0);
  assert.equal(select('task-board', records).length, 0);
  assert.equal(select('evidence-count', records).length, 0);
  assert.deepEqual([...data.revisionsByDay(history)], [['2026-10-19', 2]]);
  assert.equal(replay('covered-source-rerun').history.length, 0);
});

test('dependency remains directed; partial replacement graph does not show whole-decision replacement', () => {
  const dependency = data.edges(replay('open-adr-partial-implementation').records);
  assert.ok(dependency.some(e => e.from === 'dec-adr-0047' && e.predicate === 'depends' && e.to === 'dec-adr-0042'));
  assert.ok(!dependency.some(e => e.from === 'dec-adr-0042' && e.predicate === 'supports'));
  const partial = data.edges(replay('partial-replacement').records);
  assert.ok(partial.some(e => e.predicate === 'related' && e.to === 'dec-retention'));
  assert.ok(!partial.some(e => e.predicate === 'replaces'));
});

test('past deployment is in calendar history but absent from upcoming schedule', async () => {
  const time = await import(pathToFileURL(path.join(root, 'src/features/dashboard/model/time.ts')));
  const { records } = replay('deployment-report');
  const events = select('day-agenda', records);
  assert.equal(data.onDay(events, '2026-10-13').length, 1);
  assert.equal(time.upcoming(events, r => ({ at: data.first(r, 'at'), end: data.first(r, 'end'), status: data.status(r) }), context.now).length, 0);
});

test('goal ratio counts completed/open tasks, excludes cancelled, ignores related-only task', () => {
  const { records } = replay('deployment-report');
  const task = records.find(r => r.id === 'task-verify');
  const goal = records.find(r => r.id === 'goal-rollout');
  const extra = [['open','open','part-of'],['cancelled','cancelled','part-of'],['unrelated','open','related']].map(([id,x,predicate]) => ({ ...structuredClone(task), id, fields: { ...task.fields, x: [x] }, links: [{ predicate, target: goal.id }] }));
  const children = data.goalTasks(goal, [...records, ...extra]);
  assert.deepEqual(ids(children), ['task-verify','open','cancelled']);
  assert.deepEqual(data.share(context, children), { done: 1, total: 2, value: 0.5, closed: 1 });
});

test('graph excludes absent endpoints instead of inventing linked entities', () => {
  const { records } = replay('partial-replacement');
  records[0].links.push({ predicate: 'related', target: 'nonexistent-record' });
  assert.ok(!data.edges(records).some(e => e.to === 'nonexistent-record'));
});

test('presentation readiness distinguishes data, history, unsupported size and actual capability', async () => {
  const packages = await import(pathToFileURL(path.join(root, 'src/services/ui-packages.ts')));
  const layout = { widgets: [
    { id: 'trend', kind: 'metric-trend', size: 'L', x: 0, y: 0 },
    { id: 'feed', kind: 'activity-feed', size: 'L', x: 2, y: 0 },
    { id: 'board', kind: 'task-board', size: 'S', x: 4, y: 0 },
  ] };
  const profile = await packages.createRequirementsProfile(layout);
  const { records } = replay('stable-metric-series');
  const readiness = packages.evaluateUiRequirements(profile, { records, historyState: 'partial' });
  assert.equal(readiness.get('trend').status, 'ready');
  assert.equal(data.series(select('metric-trend', records)[0], [], 1).points.length, 1);
  assert.equal(readiness.get('feed').status, 'partial');
  assert.equal(readiness.get('board').status, 'unsupported');
  const pkg = await packages.sealUiPackage({ schema: packages.UI_PACKAGE_SCHEMA, packageId: 'fixture-people', license: 'Synthetic test data', coreTemplateRef: 'project@1', minUiCapabilities: ['people.read'], manifest: { schema: 'thegram-layout/2', widgets: [{ id: 'team', kind: 'team-roster', size: 'S', x: 0, y: 0 }] } });
  await assert.rejects(packages.compileUiPackage(pkg, 'project@1', { 'records.read': true }), /UNSUPPORTED_CAPABILITY/);
});


test('sourced risk feeds risk widgets and high-priority attention without inventing incident event or blocker', () => {
  const { records } = replay('risk-versus-blocker');
  assert.deepEqual(ids(select('risk-register', records)), ['risk-saturation']);
  assert.deepEqual(data.attention(context, records).map(a => [a.record.id,a.reason]), [['risk-saturation','risk']]);
  assert.equal(select('day-agenda', records).length, 0);
  assert.ok(!records.some(r => r.type === 'blocker'));
});

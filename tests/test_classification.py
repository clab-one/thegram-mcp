"""Offline semantic authoring oracle; no model, network, account or real document.

Run: python3 -m unittest discover -s tests -p 'test_*.py' -v
A model evaluation can supply alternate {case-id: {operations:[...]}} plans to
this module's evaluate(case, plan); this suite itself checks curated plans and
rejects plausible semantic regressions. It does not claim to test LLM inference.
"""
from copy import deepcopy
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'skills/thegram-memory/references/classification.json'
CASES = json.loads(FIXTURE.read_text())['cases']
BY_ID = {case['id']: case for case in CASES}
TYPES = set('project goal requirement assumption decision task blocker risk event artifact evidence metric component system service source history knowledge context person agent run asset'.split())
PREDICATES = set('related supports contradicts depends implements replaces derives blocks enables part-of'.split())
FIELDS = set('t d x p owner tag source ref s at due start done end value unit observed'.split())
STATUSES = {
    'task': set('backlog open active review blocked waiting completed cancelled archived'.split()),
    'decision': set('proposed accepted rejected superseded'.split()),
    'risk': set('open mitigated resolved accepted closed'.split()),
    'project': set('planning active at-risk on-hold completed cancelled archived'.split()),
    'goal': set('open active completed cancelled archived'.split()),
    'blocker': {'open', 'completed'},
}


def apply_plan(initial, plan):
    """Apply only fixture head-patch forms; validate actual types/old/targets."""
    state = {r['id']: deepcopy(r) for r in initial}
    for op in plan['operations']:
        if op['op'] == 'add':
            r = deepcopy(op['record'])
            assert r['id'] not in state, 'duplicate identity'
            assert op.get('place', {}).get('section'), 'record lacks placement'
            state[r['id']] = r
        elif op['op'] == 'set':
            r = state[op['entity']]
            before = r['fields'].get(op['key'])
            old = op['old']
            assert old == before or ([old] if isinstance(old, str) else old) == before, 'stale old'
            r['fields'][op['key']] = deepcopy(op.get('values', [op['value']] if 'value' in op else []))
        elif op['op'] == 'link':
            state[op['entity']]['links'].append([op['predicate'], op['target']])
        else:
            raise AssertionError('unexpected fixture operation')
    for r in state.values():
        assert r['type'] in TYPES, 'unsupported type'
        f = r['fields']
        assert f.get('t') and len(f['t']) == 1, 'missing title'
        assert set(f) <= FIELDS, 'unsupported fixture field'
        assert all(isinstance(v, list) and all(isinstance(s, str) for s in v) for v in f.values()), 'field arrays'
        if f.get('x') and r['type'] in STATUSES:
            assert len(f['x']) == 1 and f['x'][0] in STATUSES[r['type']], 'invalid status'
        for pred, target in r['links']:
            assert pred in PREDICATES and target in state, 'unsupported/dangling link'
        for source in f.get('source', []):
            assert source in state and state[source]['type'] == 'source', 'source is not source ID'
    return state


def evaluate(case, plan):
    """Validate typed outcomes against independent, source-specific expectations."""
    state = apply_plan(case['initial'], plan)
    before = {r['id']: r for r in case['initial']}
    expect = case['expect']
    additions = {id: r['type'] for id, r in state.items() if id not in before}
    assert additions == expect['additions'], f"unexpected domain records: {additions}"
    for id, fields in expect['fields'].items():
        for key, value in fields.items():
            assert state[id]['fields'].get(key) == value, f'{id}.{key} violates source state'
    edges = {(id, p, target) for id, r in state.items() for p, target in r['links']}
    for edge in expect['links']:
        assert tuple(edge) in edges, 'missing sourced relation'
    for edge in expect['absent_links']:
        assert tuple(edge) not in edges, 'invented/inappropriately scoped relation'
    for targets in expect['coverage'].values():
        assert all(id in state for id in targets), 'coverage points at absent fact'
    assert set(plan) == {'operations'}, 'no synthetic effective/recorded revision metadata'
    return state


class ClassificationTests(unittest.TestCase):
    def test_all_curated_plans_satisfy_semantic_oracle(self):
        for case in CASES:
            with self.subTest(case=case['id']):
                evaluate(case, case['plan'])

    def mutate(self, id):
        return BY_ID[id], deepcopy(BY_ID[id]['plan'])

    def test_commit_event_default_is_rejected(self):
        for id in ['mixed-commit', 'image-pins-coverage', 'recurring-fixes']:
            case, plan = self.mutate(id)
            plan['operations'].append({'op':'add','place':{'section':'Log'},'record':{
                'type':'event','id':'ev-commit','fields':{'t':['Commit shipped'],'at':['2026-10-10']},'links':[['part-of','prj-atlas']]}})
            with self.subTest(case=id), self.assertRaises(AssertionError): evaluate(case, plan)

    def test_open_adr_cannot_be_accepted_from_merged_code(self):
        case, plan = self.mutate('open-adr-partial-implementation')
        plan['operations'].append({'op':'set','entity':'dec-adr-0047','key':'x','value':'accepted','old':'proposed'})
        with self.assertRaises(AssertionError): evaluate(case, plan)

    def test_partial_and_review_work_cannot_complete(self):
        for id, task, old in [('open-adr-partial-implementation','task-ethereum','active'), ('unmerged-pr-failed-verification','task-review','review'), ('recurring-fixes','task-retry','active')]:
            case, plan = self.mutate(id)
            plan['operations'].append({'op':'set','entity':task,'key':'x','value':'completed','old':old})
            with self.subTest(case=id), self.assertRaises(AssertionError): evaluate(case, plan)

    def test_dependency_is_not_inverse_evidential_support(self):
        case, plan = self.mutate('open-adr-partial-implementation')
        plan['operations'].append({'op':'link','entity':'dec-adr-0042','predicate':'supports','target':'dec-adr-0047'})
        with self.assertRaises(AssertionError): evaluate(case, plan)

    def test_partial_replacement_keeps_still_valid_old_decision(self):
        for op in [{'op':'set','entity':'dec-retention','key':'x','value':'superseded','old':'accepted'}, {'op':'link','entity':'dec-batch-retention','predicate':'replaces','target':'dec-retention'}]:
            case, plan = self.mutate('partial-replacement')
            plan['operations'].append(op)
            with self.subTest(op=op), self.assertRaises(AssertionError): evaluate(case, plan)

    def test_unsupported_predicates_are_rejected(self):
        for pred in ['amends','replaces_in_part','related_to']:
            case, plan = self.mutate('partial-replacement')
            plan['operations'].append({'op':'link','entity':'dec-batch-retention','predicate':pred,'target':'dec-retention'})
            with self.subTest(predicate=pred), self.assertRaises(AssertionError): evaluate(case, plan)

    def test_deployment_time_is_not_commit_author_time(self):
        case, plan = self.mutate('deployment-report')
        event = next(op['record'] for op in plan['operations'] if op['op']=='add' and op['record']['type']=='event')
        event['fields']['at']=['2026-10-12T09:00:00Z']
        with self.assertRaises(AssertionError): evaluate(case, plan)

    def test_metric_uses_existing_id_and_sourced_observation(self):
        case, plan = self.mutate('stable-metric-series')
        op = next(op for op in plan['operations'] if op.get('key')=='observed')
        op['value']='2026-10-19T00:00:00Z'
        with self.assertRaises(AssertionError): evaluate(case, plan)
        case, plan = self.mutate('stable-metric-series')
        plan['operations'].append({'op':'set','entity':'met-availability','key':'unit','value':'requests','old':'percent'})
        with self.assertRaises(AssertionError): evaluate(case, plan)

    def test_no_fabricated_history_fields_or_revisions(self):
        case, plan = self.mutate('mixed-commit')
        plan['operations'][0]['record']['fields']['replayed_at']=['2026-10-10']
        with self.assertRaises(AssertionError): evaluate(case, plan)
        case, plan = self.mutate('mixed-commit')
        plan['effective_at']='2026-10-10T00:00:00Z'
        with self.assertRaises(AssertionError): evaluate(case, plan)

    def test_retry_same_identity_needs_no_delta(self):
        case = BY_ID['covered-source-rerun']
        self.assertEqual(evaluate(case, case['plan']), {r['id']:r for r in case['initial']})
        self.assertEqual(case['plan']['operations'], [])  # caller skips patch entirely

    def test_head_patch_requires_the_observed_old_value(self):
        case, plan = self.mutate('stable-metric-series')
        next(op for op in plan['operations'] if op.get('key')=='value')['old']='99.8'
        with self.assertRaises(AssertionError): evaluate(case, plan)

    def test_lifecycle_creates_without_a_template_and_keeps_the_done_time(self):
        f=json.loads((FIXTURE.parent/'lifecycle.json').read_text())
        self.assertNotIn('template',f['create']['arguments'])
        self.assertTrue(f['create']['arguments']['request_id'])
        state = f['create']['arguments']['content']['records']
        # Head-style old checks are exercised even though the example also supplies CAS.
        for patch in f['patches']:
            structured=[op for op in patch['arguments']['operations'] if op['op']!='edit-text' and op.get('entity')!='doc']
            state=list(apply_plan(state, {'operations':structured}).values())
        task=next(r for r in state if r['id']=='task-verify')
        self.assertEqual(task['fields']['x'],['completed'])
        self.assertEqual(task['fields']['done'],['2026-10-11T09:00:00Z'])

if __name__=='__main__': unittest.main()

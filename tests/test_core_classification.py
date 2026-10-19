"""Optional native Core validation of typed authoring plans in scratch files only."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_classification import CASES, evaluate

BINARY=os.environ.get('GRAM_CORE_BINARY')

def native_record(record):
    # MCP accepts tuple links and normalizes them before calling native Core.
    r=deepcopy(record)
    r['links']=[{'predicate':p,'target':t} for p,t in record['links']]
    return r

def native_operations(operations):
    ops=deepcopy(operations)
    for op in ops:
        if op['op']=='add': op['record']=native_record(op['record'])
    return ops

@unittest.skipUnless(BINARY, 'Set GRAM_CORE_BINARY to the compatible local native Core executable')
class NativeClassificationTests(unittest.TestCase):
    def call(self, **request):
        run=subprocess.run([BINARY],input=json.dumps(request),capture_output=True,text=True,check=False)
        self.assertEqual(run.returncode,0,run.stderr)
        result=json.loads(run.stdout)
        self.assertTrue(result.get('ok'), result)
        return result

    def test_classification_plans_commit_and_read_back_in_scratch_storage(self):
        with tempfile.TemporaryDirectory(prefix='thegram-classification-') as temp:
            for c in CASES:
                with self.subTest(case=c['id']):
                    path=str(Path(temp)/(c['id']+'.gram'))
                    create=self.call(op='create',path=path,document_id='fixture-'+c['id'],title='Synthetic semantic fixture',base_revision=None,content={'text':'# Overview\n\n# Architecture\n\n# Plan\n\n# Decisions\n\n# Log\n','records':[native_record(r) for r in c['initial']]})
                    operations=c['plan']['operations']
                    if operations:
                        changed=self.call(op='patch',path=path,base_revision=create['revision'],expected_hash=create['file_hash'],request_id='classify-'+c['id'],operations=native_operations(operations))
                        self.assertEqual(changed['revision'],1)
                    opened=self.call(op='open',path=path)
                    actual={r['id']:r for r in opened['ir']['records']}
                    expected=evaluate(c,c['plan'])
                    self.assertEqual(set(actual),set(expected))
                    for id,r in expected.items():
                        self.assertEqual(actual[id]['type'],r['type'])
                        self.assertEqual(actual[id]['fields'],r['fields'])
                        links={(l['predicate'],l['target']) for l in actual[id]['links']}
                        self.assertEqual(links,{tuple(l) for l in r['links']})
                    self.assertEqual(opened['revision'],1 if operations else 0)

if __name__=='__main__': unittest.main()

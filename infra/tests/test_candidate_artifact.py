"""No caller-supplied digest pair can replace the successful build artifact."""
import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from candidate_artifact import download
from pooler import SafeFailure


class ArtifactTests(unittest.TestCase):
    def fixture(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as target: target.writestr('candidate.json', json.dumps({'proof':'built'}))
        archive = stream.getvalue()
        run = {'path':'.github/workflows/candidate.yml', 'head_sha':'a'*40, 'head_branch':'main',
               'event':'workflow_dispatch', 'head_repository':{'full_name':'owner/repo'},
               'status':'completed', 'conclusion':'success'}
        artifact = {'expired':False, 'name':'staging-candidate-'+'a'*40, 'id':123,
                    'size_in_bytes':len(archive), 'digest':'sha256:'+hashlib.sha256(archive).hexdigest()}
        return run, artifact, archive

    def test_success_and_every_run_or_artifact_trust_boundary(self):
        good_run, good_artifact, archive = self.fixture()
        cases = [('none',None,None)]
        cases += [('run',field,value) for field,value in [('path','.github/workflows/ci.yml'),('head_sha','b'*40),
                  ('head_branch','feature'),('event','pull_request'),('head_repository',{'full_name':'foreign/repo'}),
                  ('status','in_progress'),('conclusion','failure')]]
        cases += [('artifact',field,value) for field,value in [('expired',True),('name','foreign'),('id','123'),
                  ('size_in_bytes',2_000_000),('digest','sha256:'+'0'*64)]]
        for kind, field, value in cases:
            run, artifact = copy.deepcopy(good_run), copy.deepcopy(good_artifact)
            if kind == 'run': run[field] = value
            if kind == 'artifact': artifact[field] = value
            def read(path, binary=False):
                if binary: return archive
                if '/artifacts?' in path: return {'total_count':1, 'artifacts':[artifact]}
                return run
            with self.subTest(kind=kind,field=field):
                if kind == 'none': self.assertEqual(download('owner/repo','a'*40,'1',read),{'proof':'built'})
                else:
                    with self.assertRaises(SafeFailure): download('owner/repo','a'*40,'1',read)

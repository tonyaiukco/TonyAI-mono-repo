"""Execute the build shell with fake build/registry commands and the real asset scanner."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
SCRIPT=ROOT/'infra/scripts/build-images.sh'


class BuildTests(unittest.TestCase):
    def test_only_scanned_build_digests_are_recorded_and_no_foundation_mutation(self):
        for mode in ('ok','dirty','bad-digest','privileged-assets','build-failure'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
                directory=Path(d); log=directory/'calls.jsonl'; output=directory/'candidate.json'
                def executable(name,source):
                    path=directory/name;path.write_text('#!'+sys.executable+'\n'+source);path.chmod(0o755)
                executable('git', '''import os,sys
if sys.argv[1]=='rev-parse': print('a'*40)
elif os.environ['BUILD_TEST_MODE']=='dirty': print('dirty')
''')
                executable('az', '''import json,os,sys
with open(os.environ['CALL_LOG'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
if sys.argv[1:3]!=['acr','login']: sys.exit(99)
''')
                executable('python3', '''import os,sys
# Browser input/Auth HTTP validation has its own real request-path unit tests.
if sys.argv[1].endswith('check_browser_key.py'): sys.exit(0)
os.execv('''+repr(sys.executable)+''', ['''+repr(sys.executable)+''',*sys.argv[1:]])
''')
                executable('docker', '''import json,os,pathlib,sys
args=sys.argv[1:]; mode=os.environ['BUILD_TEST_MODE']
with open(os.environ['CALL_LOG'],'a') as f: f.write(json.dumps(args)+'\\n')
if args[:2]==['buildx','build']:
    if mode=='build-failure': sys.exit(1)
    target=pathlib.Path(args[args.index('--metadata-file')+1])
    target.write_text(json.dumps({'containerimage.digest':'invalid' if mode=='bad-digest' else 'sha256:'+('a' if target.name=='api.json' else 'b')*64}))
elif args[0]=='create': print('synthetic-container')
elif args[0]=='cp':
    target=pathlib.Path(args[-1]); target.mkdir(); (target/'app.js').write_text('sb_secret_synthetic' if mode=='privileged-assets' else 'public bundle')
''')
                env={**os.environ,'PATH':d+os.pathsep+os.environ['PATH'],'BUILD_TEST_MODE':mode,'CALL_LOG':str(log),
                     'SUPABASE_PROJECT_REF':'abcdefghijklmnopqrst','SUPABASE_URL':'https://abcdefghijklmnopqrst.supabase.co',
                     'ACR_HOST':'registry.azurecr.io','ACR_NAME':'registry','API_ORIGIN':'https://api.example',
                     'WEB_ORIGIN':'https://web.example','RESOURCE_GROUP':'staging'}
                result=subprocess.run(['bash',str(SCRIPT),'a'*40,str(output)],cwd=ROOT,env=env,input='sb_publishable_synthetic\n',capture_output=True,text=True)
                self.assertEqual(result.returncode==0,mode=='ok',result.stderr)
                self.assertEqual(output.exists(),mode=='ok')
                calls=[json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
                self.assertFalse(any(call[:2]==['group','update'] for call in calls))
                if mode=='ok':
                    actual=json.loads(output.read_text())
                    self.assertEqual(actual['api_digest'],'sha256:'+'a'*64)
                    self.assertEqual(actual['web_digest'],'sha256:'+'b'*64)
                    self.assertTrue(any('registry.azurecr.io/tonyai/web@sha256:'+'b'*64 in call for call in calls))

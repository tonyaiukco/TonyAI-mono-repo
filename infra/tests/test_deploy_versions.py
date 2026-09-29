"""Execute the real owner deploy helper with fake CLIs; stale references must stop it."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'deploy-apps.sh'


class DeploymentVersionTests(unittest.TestCase):
    def test_only_matching_versioned_references_are_recorded(self):
        for stale in ('0','1'):
            with self.subTest(stale=stale), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                git = folder / 'git'
                git.write_text('#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%s\\n" "$RELEASE_SHA"; fi\n')
                git.chmod(0o755)
                az = folder / 'az'
                az.write_text('#!' + sys.executable + '\n' + '''
import json,os,sys
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
base='https://vault.vault.azure.net/secrets/'
if args[:3]==['keyvault','secret','show']:
    name=args[args.index('--name')+1]
    print(base+name+'/'+('a' if name=='database-url' else 'b')*32)
elif args[:3]==['containerapp','secret','list']:
    query=args[args.index('--query')+1]
    if '[0]' in query:
        name='database-url' if 'database-url' in query else 'supabase-service-role-key'
        version=('a' if name=='database-url' else 'b')*32
        print(base+name+'/'+('c'*32 if os.environ['STALE']=='1' else version))
    else: print('[]')
else: print('Succeeded')
''')
                az.chmod(0o755)
                log = folder / 'calls.jsonl'
                env = {**os.environ,'PATH':directory+os.pathsep+os.environ['PATH'],
                       'RELEASE_SHA':'a'*40,'RESOURCE_GROUP':'staging','PREFIX':'tonyai',
                       'SUPABASE_PROJECT_REF':'abcdefghijklmnopqrst','VAULT_NAME':'vault',
                       'API_DIGEST':'sha256:'+'a'*64,'WEB_DIGEST':'sha256:'+'b'*64,
                       'CALL_LOG':str(log),'STALE':stale}
                result = subprocess.run(['bash',str(SCRIPT)],env=env,capture_output=True,text=True)
                calls = [json.loads(line) for line in log.read_text().splitlines()]
                updated = any(call[:2]==['group','update'] for call in calls)
                self.assertEqual(result.returncode==0, stale=='0',result.stderr)
                self.assertEqual(updated,stale=='0')
                deployment = next(call for call in calls if call[:3]==['deployment','group','create'])
                self.assertIn('databaseSecretVersion='+'a'*32,deployment)
                self.assertIn('backendSecretVersion='+'b'*32,deployment)
                self.assertTrue(all('--query' in call and call[call.index('--query')+1]=='id'
                                    for call in calls if call[:3]==['keyvault','secret','show']))

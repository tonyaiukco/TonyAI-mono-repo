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
        for stale in ('0','1','bad-url','dirty','wrong-image'):
            with self.subTest(stale=stale), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory)
                git = folder / 'git'
                git.write_text('#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%s\\n" "$RELEASE_SHA"; elif [ "$STALE" = dirty ]; then echo dirty; fi\n')
                git.chmod(0o755)
                az = folder / 'az'
                az.write_text('#!' + sys.executable + '\n' + '''
import json,os,sys
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as log: log.write(json.dumps(args)+'\\n')
base='https://vault.vault.azure.net/secrets/'
if args[:3]==['keyvault','secret','show']:
    name=args[args.index('--name')+1]
    id=base+name+'/'+('a' if name=='database-url' else 'b')*32
    if name=='database-url':
        value='postgresql://postgres.abcdefghijklmnopqrst:synthetic@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt&pgbouncer=true'
        if os.environ['STALE']=='bad-url': value+='&host=evil.example.com'
        print(json.dumps({'id':id,'value':value,'attributes':{'enabled':True}}))
    else: print(id)
elif args[:3]==['containerapp','secret','list']:
    query=args[args.index('--query')+1]
    if '[0]' in query:
        name='database-url' if 'database-url' in query else 'supabase-service-role-key'
        version=('a' if name=='database-url' else 'b')*32
        print(base+name+'/'+('c'*32 if os.environ['STALE']=='1' else version))
    else: print('[]')
elif args[:2]==['containerapp','show']:
    app='api' if args[args.index('-n')+1].endswith('-api') else 'web'
    print('wrong-image' if os.environ['STALE']=='wrong-image' else 'registry.azurecr.io/tonyai/'+app+'@'+os.environ[app.upper()+'_DIGEST'])
else: print('Succeeded')
''')
                az.chmod(0o755)
                log = folder / 'calls.jsonl'
                env = {**os.environ,'PATH':directory+os.pathsep+os.environ['PATH'],
                       'RELEASE_SHA':'a'*40,'RESOURCE_GROUP':'staging','PREFIX':'tonyai',
                       'SUPABASE_PROJECT_REF':'abcdefghijklmnopqrst','VAULT_NAME':'vault','ACR_HOST':'registry.azurecr.io',
                       'API_DIGEST':'sha256:'+'a'*64,'WEB_DIGEST':'sha256:'+'b'*64,
                       'CALL_LOG':str(log),'STALE':stale}
                result = subprocess.run(['bash',str(SCRIPT)],env=env,capture_output=True,text=True)
                calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
                updated = any(call[:2]==['group','update'] for call in calls)
                self.assertEqual(result.returncode==0, stale=='0',result.stderr)
                self.assertEqual(updated,stale=='0')
                if stale in ('bad-url','dirty'):
                    self.assertFalse(any(call[:2]==['deployment','group'] for call in calls))
                    continue
                deployment = next(call for call in calls if call[:3]==['deployment','group','create'])
                self.assertIn('databaseSecretVersion='+'a'*32,deployment)
                self.assertIn('backendSecretVersion='+'b'*32,deployment)
                if stale == '0':
                    update = next(call for call in calls if call[:2]==['group','update'])
                    self.assertIn('tags.apiDigest='+env['API_DIGEST'], update)
                    self.assertIn('tags.webDigest='+env['WEB_DIGEST'], update)

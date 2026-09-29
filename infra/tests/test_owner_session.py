"""Cloud-free fresh-terminal and repeat-invocation checks with a fake Azure CLI."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import configure_oidc as oidc
from pooler import SafeFailure


class SessionTests(unittest.TestCase):
    def test_restore_rederives_variables_and_function_without_changing_shell_options(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'az'
            path.write_text('#!' + sys.executable + '\n' + '''
import json,sys
args=sys.argv[1:]
if args[:2]==['group','show']:
    print(json.dumps({'id':'/subscriptions/sub/resourceGroups/staging', 'tags':{
      'environment':'staging','tonyaiPrefix':'tonyai','releaseSha':'a'*40,'githubRepository':'owner/repo',
      'supabaseProjectRef':'abcdefghijklmnopqrst','githubClientId':'client','githubPrincipalId':'principal',
      'apiDigest':'sha256:'+'a'*64,'webDigest':'sha256:'+'b'*64}}))
elif args[:3]==['deployment','group','show']:
    if args[args.index('--query')+1]=='properties.outputs':
      print(json.dumps({key:{'value':value} for key,value in {
        'registryName':'registry','registryHost':'registry.azurecr.io','vaultName':'vault',
        'webOrigin':'https://web','apiOrigin':'https://api'}.items()}))
    else: print('vault-id')
elif args[:2]==['account','show']: print('tenant')
elif args[:2]!=['account','set']: sys.exit(99)
''')
            path.chmod(0o755)
            script = '''before="$SHELLOPTS"
source "$1" sub staging || exit 1
test "$SHELLOPTS" = "$before" || exit 2
printf '%s\\n' "$AZURE_TENANT_ID|$VAULT_NAME|$ACR_HOST|$RELEASE_SHA|$SUPABASE_PROJECT_REF|$AZURE_CLIENT_ID|$DEPLOYER_OBJECT_ID|$API_DIGEST|$WEB_DIGEST"
foundation_output vaultId
'''
            result = subprocess.run(['bash','--noprofile','--norc','-c',script,'test',str(SCRIPTS/'restore-session.sh')],
                                    env={**os.environ,'PATH':directory + os.pathsep + os.environ['PATH']},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('tenant|vault|registry.azurecr.io|' + 'a'*40, result.stdout)
            self.assertIn('abcdefghijklmnopqrst|client|principal|sha256:', result.stdout)
            self.assertIn('vault-id', result.stdout)

    def test_restore_failure_returns_without_exiting_interactive_caller(self):
        result = subprocess.run(['bash','--noprofile','--norc','-c',
                                 'source "$1"; rc=$?; printf "ALIVE:%s" "$rc"',
                                 'test',str(SCRIPTS/'restore-session.sh')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0)
        self.assertIn('ALIVE:1',result.stdout)


class FederationTests(unittest.TestCase):
    def test_second_run_reuses_app_principal_and_exact_federation(self):
        state = {'tags':{'environment':'staging'},'apps':[],'principals':[],'credentials':[]}
        calls = []
        def az(*args):
            calls.append(args)
            if args[:2] == ('group','show'):
                return {'id':'/subscriptions/sub/resourceGroups/staging','tags':state['tags']}
            if args[:3] == ('ad','app','list'): return state['apps']
            if args[:3] == ('ad','app','show'): return state['apps'][0]
            if args[:3] == ('ad','app','create'):
                app={'appId':'client','displayName':args[args.index('--display-name')+1]}
                state['apps'].append(app)
                return app
            if args[:3] == ('ad','sp','list'): return state['principals']
            if args[:3] == ('ad','sp','create'):
                state['principals'].append({'id':'principal'})
                return state['principals'][0]
            if args[:2] == ('group','update'):
                state['tags'].update(githubClientId='client',githubPrincipalId='principal')
                return {}
            if args[:4] == ('ad','app','federated-credential','list'): return state['credentials']
            if args[:4] == ('ad','app','federated-credential','create'):
                value=json.loads(args[args.index('--parameters')+1])
                state['credentials'].append(value)
                return value
            raise AssertionError(args)
        with patch.object(oidc,'az',side_effect=az),contextlib.redirect_stdout(io.StringIO()):
            oidc.configure('sub','staging','owner/repo')
            oidc.configure('sub','staging','owner/repo')
            with self.assertRaises(SafeFailure): oidc.configure('sub','staging','foreign/repo')
        self.assertEqual(sum(call[:3]==('ad','app','create') for call in calls),1)
        self.assertEqual(sum(call[:3]==('ad','sp','create') for call in calls),1)
        self.assertEqual(sum(call[:4]==('ad','app','federated-credential','create') for call in calls),1)
        self.assertEqual(state['credentials'][0]['subject'],'repo:owner/repo:environment:staging')

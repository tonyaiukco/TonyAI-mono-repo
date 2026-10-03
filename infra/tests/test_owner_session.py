"""Cloud-free fresh-terminal and repeat-invocation checks with a fake Azure CLI."""
import contextlib
import io
import json
import os
import shutil
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
elif args[:2]==['resource','list']:
    print(json.dumps([{'type':kind,'name':name,'id':'/subscriptions/sub/resourceGroups/staging/providers/'+kind+'/'+name,
      'location':'germanywestcentral','tags':{'application':'TonyAI','environment':'staging','task':'LP2-01'}}
      for kind,name in [('Microsoft.ContainerRegistry/registries','registry'),('Microsoft.KeyVault/vaults','vault'),
        ('Microsoft.App/managedEnvironments','tonyai-staging-env'),
        ('Microsoft.ManagedIdentity/userAssignedIdentities','tonyai-staging-api'),
        ('Microsoft.OperationalInsights/workspaces','tonyai-staging-logs')]]))
elif args[:2]==['acr','show']: print(json.dumps({'loginServer':'registry.azurecr.io'}))
elif args[:3]==['containerapp','env','show']: print(json.dumps({'properties':{'defaultDomain':'example.germanywestcentral.azurecontainerapps.io'}}))
elif args[:2]==['account','show']: print(json.dumps({'tenantId':'tenant'}))
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
                                    env={**os.environ,'PATH':directory + os.pathsep + os.environ['PATH'], 'TONYAI_INFRA_SCRIPTS':str(SCRIPTS)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('tenant|vault|registry.azurecr.io|' + 'a'*40, result.stdout)
            self.assertIn('abcdefghijklmnopqrst|client|principal|sha256:', result.stdout)
            self.assertIn('/providers/Microsoft.KeyVault/vaults/vault', result.stdout)

    def test_restore_failure_returns_without_exiting_interactive_caller(self):
        result = subprocess.run(['bash','--noprofile','--norc','-c',
                                 'export VAULT_NAME=stale API_DIGEST=stale; source "$1"; rc=$?; printf "ALIVE:%s|%s|%s" "$rc" "${VAULT_NAME-unset}" "${API_DIGEST-unset}"',
                                 'test',str(SCRIPTS/'restore-session.sh')],capture_output=True,text=True)
        self.assertEqual(result.returncode,0)
        self.assertIn('ALIVE:1|unset|unset',result.stdout)

    def test_every_restored_variable_is_invalidated_before_failed_restore(self):
        names = 'AZURE_SUBSCRIPTION_ID RESOURCE_GROUP GROUP_ID PREFIX RELEASE_SHA GITHUB_REPOSITORY ACR_NAME ACR_HOST VAULT_NAME VAULT_ID API_IDENTITY_ID LOGS_NAME ACA_DEFAULT_DOMAIN WEB_ORIGIN API_ORIGIN AZURE_TENANT_ID SUPABASE_PROJECT_REF SUPABASE_URL AZURE_CLIENT_ID DEPLOYER_OBJECT_ID API_DIGEST WEB_DIGEST CANDIDATE_API_DIGEST CANDIDATE_WEB_DIGEST DATABASE_SECRET_VERSION BACKEND_SECRET_VERSION'.split()
        env = {**os.environ, **dict.fromkeys(names, 'stale')}
        script = 'source "$1"; for name in '+ ' '.join(names) + '; do if [ "${!name+x}" = x ]; then echo "STALE:$name"; fi; done; echo ALIVE'
        result = subprocess.run(['bash','--noprofile','--norc','-c',script,'test',str(SCRIPTS/'restore-session.sh')],env=env,capture_output=True,text=True)
        self.assertIn('ALIVE', result.stdout)
        self.assertNotIn('STALE:', result.stdout)

    def test_failed_resource_read_clears_session_and_never_reports_pass(self):
        shells = [['bash','--noprofile','--norc']]
        if shutil.which('zsh'): shells.append(['zsh','-f'])
        with tempfile.TemporaryDirectory() as directory:
            az = Path(directory) / 'az'
            az.write_text('#!/bin/sh\nexit 1\n')
            az.chmod(0o755)
            for shell in shells:
                script = 'export VAULT_NAME=stale API_DIGEST=stale; source "$1" sub staging; rc=$?; printf "ALIVE:%s|%s|%s" "$rc" "${VAULT_NAME-unset}" "${API_DIGEST-unset}"'
                result = subprocess.run([*shell,'-c',script,'test',str(SCRIPTS/'restore-session.sh')],
                                        env={**os.environ,'PATH':directory+os.pathsep+os.environ['PATH'], 'TONYAI_INFRA_SCRIPTS':str(SCRIPTS)},capture_output=True,text=True)
                with self.subTest(shell=shell):
                    self.assertEqual(result.returncode,0)
                    self.assertIn('ALIVE:1|unset|unset',result.stdout)
                    self.assertNotIn('PASS:',result.stdout)



class FederationTests(unittest.TestCase):
    def test_second_run_reuses_app_principal_and_exact_federation(self):
        state = {'tags':{'environment':'staging'},'apps':[],'principals':[],'credentials':[]}
        calls = []
        def az(*args):
            calls.append(args)
            if args[:3] == ('ad','signed-in-user','show'): return {'id':'operator'}
            if args[:4] in (('ad','app','owner','list'), ('ad','sp','owner','list')): return [{'id':'operator'}]
            if args[:3] == ('ad','sp','show'): return state['principals'][0]
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
                state['principals'].append({'id':'principal','appId':'client','passwordCredentials':[],'keyCredentials':[]})
                return state['principals'][0]
            if args[:2] == ('group','update'):

                for assignment in args[args.index('--set')+1:]:
                    key,value=assignment.split('=',1)
                    state['tags'][key.removeprefix('tags.')]=value
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

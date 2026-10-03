"""A single release contract must survive independent per-field ARM readback."""
import copy
import contextlib
import io
import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from deploy_apps import verify
from terraform_run import validate_release
from pooler import SafeFailure


def inputs():
    return {'foundation': {'subscription_id':'00000000-0000-0000-0000-000000000001',
            'tenant_id':'00000000-0000-0000-0000-000000000002', 'environment':'staging',
            'resource_group':'staging', 'prefix':'tonyai', 'registry_name':'registry',
            'vault_name':'vault', 'default_domain':'real.germanywestcentral.azurecontainerapps.io'},
            'release': {'source_sha':'a'*40,'release_id':'r001','supabase_project_ref':'abcdefghijklmnopqrst',
            'api_digest':'sha256:'+'a'*64,'web_digest':'sha256:'+'b'*64,
            'database_secret_version':'a'*32,'backend_secret_version':'b'*32}}


def app(kind, contract):
    f, r = contract['foundation'], contract['release']
    identity = '/subscriptions/'+f['subscription_id']+'/resourceGroups/staging/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-api'
    secrets = [{'name':name,'identity':identity,'keyVaultUrl':'https://vault.vault.azure.net/secrets/'+name+'/'+r[field]}
               for name,field in [('database-url','database_secret_version'),('supabase-service-role-key','backend_secret_version')]] if kind=='api' else []
    return {'properties': {
        'template': {'containers':[{'image':'registry.azurecr.io/tonyai/'+kind+'@'+r[kind+'_digest']}]},
        'configuration': {'ingress': {'allowInsecure':False,'fqdn':'tonyai-staging-'+kind+'.'+f['default_domain']},'secrets':secrets},
        'latestReadyRevisionName':'tonyai-staging-'+kind+'--'+r['release_id']}}


class DeploymentVersionTests(unittest.TestCase):
    def test_every_individual_reference_image_identity_origin_and_ready_revision(self):
        contract = inputs()
        for defect in ('none','api-image','web-image','database-version','backend-version','identity','origin','http','not-ready','web-secret'):
            state = {kind:app(kind,contract) for kind in ('api','web')}
            api = state['api']['properties']; web = state['web']['properties']
            if defect == 'api-image': api['template']['containers'][0]['image'] = 'old'
            if defect == 'web-image': web['template']['containers'][0]['image'] = 'old'
            if defect == 'database-version': api['configuration']['secrets'][0]['keyVaultUrl'] += 'stale'
            if defect == 'backend-version': api['configuration']['secrets'][1]['keyVaultUrl'] += 'stale'
            if defect == 'identity': api['configuration']['secrets'][0]['identity'] = 'foreign'
            if defect == 'origin': web['configuration']['ingress']['fqdn'] = 'foreign.invalid'
            if defect == 'http': api['configuration']['ingress']['allowInsecure'] = True
            if defect == 'not-ready': api['latestReadyRevisionName'] = 'old'
            if defect == 'web-secret': web['configuration']['secrets'] = [{'name':'unexpected'}]
            def read(*args): return state['api' if args[-1].endswith('-api') else 'web']
            with self.subTest(defect=defect), contextlib.redirect_stdout(io.StringIO()):
                if defect == 'none': verify(contract, read)
                else:
                    with self.assertRaises(SafeFailure): verify(contract, read)

    def test_release_cannot_select_latest_cross_origin_or_include_secret_value(self):
        for section,field,value in [('release','api_digest','latest'),('release','database_secret_version','latest'),
                                   ('foundation','default_domain','evil.invalid'),('release','database_url','secret')]:
            contract = inputs(); contract[section][field] = value
            with self.subTest(field=field), self.assertRaises(SafeFailure): validate_release(contract)

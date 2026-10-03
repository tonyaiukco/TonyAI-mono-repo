"""Backend firewall, RBAC isolation, recovery and runner environment boundaries."""
import copy
import os
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from bootstrap_backend import bootstrap, validate
from pooler import SafeFailure
from terraform_run import clean_environment, invoke
from test_deploy_versions import inputs
import json


def config():
    return {'subscription_id':'00000000-0000-0000-0000-000000000001',
            'tenant_id':'00000000-0000-0000-0000-000000000002','environment':'staging',
            'resource_group':'tonyai-staging-state','storage_account':'tonyaistagingstate',
            'owner_object_id':'00000000-0000-0000-0000-000000000003',
            'application_object_id':'00000000-0000-0000-0000-000000000004','allowed_ipv4':['8.8.8.8/32']}


class BackendTests(unittest.TestCase):
    def test_only_application_container_granted_to_deployer_and_recovery_enabled(self):
        calls=[]; state={}
        def arm(path,version,method='GET',body=None,missing_ok=False):
            calls.append((path,method,body))
            if method == 'PUT': state[path]=copy.deepcopy(body)
            if path not in state: return None
            result=copy.deepcopy(state[path]); result.setdefault('properties',{})['provisioningState']='Succeeded'
            return result
        bootstrap(config(),arm)
        grants=[(p,b['properties']) for p,m,b in calls if m=='PUT' and '/roleAssignments/' in p]
        app_grants=[p for p,g in grants if g['principalId']==config()['application_object_id']]
        self.assertEqual(len(app_grants),1)
        self.assertIn('/containers/application/',app_grants[0])
        account=next(b for p,m,b in calls if m=='PUT' and p.endswith('/storageAccounts/tonyaistagingstate'))
        self.assertIs(account['properties']['allowSharedKeyAccess'],False)
        self.assertEqual(account['properties']['networkAcls']['defaultAction'],'Deny')
        self.assertEqual(account['properties']['networkAcls']['bypass'],'None')
        self.assertEqual(account['properties']['networkAcls']['ipRules'], [{'value':'8.8.8.8','action':'Allow'}])
        recovery=next(b for p,m,b in calls if m=='PUT' and p.endswith('/blobServices/default'))
        self.assertTrue(recovery['properties']['isVersioningEnabled'])
        self.assertTrue(any('/locks/state-recovery' in p for p,m,b in calls))
        self.assertFalse(any('listKeys' in p for p,m,b in calls))

    def test_backend_validation_fails_before_any_cloud_operation(self):
        for field,value in [('environment','dev'),('allowed_ipv4',[]),('allowed_ipv4',['0.0.0.0/0']),
                            ('allowed_ipv4',['10.0.0.1/32']),('allowed_ipv4',['8.8.8.8/31']),('resource_group','shared'),
                            ('application_object_id',config()['owner_object_id'])]:
            c=config();c[field]=value
            with self.subTest(field=field), self.assertRaises(SafeFailure): validate(c)

    def test_ambient_credentials_and_tf_arguments_refused(self):
        for name in ('TF_LOG','TF_CLI_ARGS_apply','TF_VAR_password','ARM_ACCESS_KEY','ARM_SAS_TOKEN','ARM_CLIENT_SECRET'):
            with self.subTest(name=name),patch.dict(os.environ,{name:'synthetic'}):
                with self.assertRaises(SafeFailure): clean_environment()

    def test_wrong_environment_never_initializes_backend(self):
        with tempfile.TemporaryDirectory() as d:
            backend=Path(d)/'backend.json'; data=Path(d)/'inputs.json'
            backend.write_text(json.dumps(config()))
            contract=inputs();contract['foundation']['environment']='production';data.write_text(json.dumps(contract))
            with patch('terraform_run.subprocess.run') as run:
                with self.assertRaises(SafeFailure): invoke('application',backend,data,'apply')
                run.assert_not_called()

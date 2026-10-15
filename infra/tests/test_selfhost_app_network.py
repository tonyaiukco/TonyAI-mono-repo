"""Network creation boundary tests; no Azure, SSH, database or secret access."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from selfhost_app_network import validate_network

ROOT = Path(__file__).resolve().parents[2]
SUB = '00000000-0000-0000-0000-000000000001'
VNET = f'/subscriptions/{SUB}/resourceGroups/tonyai-staging-data/providers/Microsoft.Network/virtualNetworks/tonyai-staging-data-vnet'


def fixture():
    host = dict(subscription_id=SUB, tenant_id='00000000-0000-0000-0000-000000000002',
                environment='staging', resource_group='tonyai-staging-data', vm_name='tonyai-staging-data',
                private_ip='10.80.0.4', public_ip='192.0.2.1', public_hostname='fixture.example.invalid',
                apps_subnet_id=VNET + '/subnets/container-apps',
                principal_id='00000000-0000-0000-0000-000000000003',
                recovery_vault_url='https://fixture.vault.azure.net')
    network = dict(id=VNET, location='swedencentral', prefixes=['10.80.0.0/16'], subnets=[
        dict(id=VNET+'/subnets/supabase', prefix='10.80.0.0/24', delegations=[],
             ip_configuration_count=1, association_count=0),
        dict(id=VNET+'/subnets/container-apps', prefix='10.80.2.0/23',
             delegations=['Microsoft.App/environments'], ip_configuration_count=0, association_count=0),
    ])
    return host, network, []


class NetworkCreationTests(unittest.TestCase):
    def test_first_request_fragment_contains_subnet_and_consumption_profile(self):
        host, network, environments = fixture()
        original = copy.deepcopy((host, network, environments))
        result = validate_network(host, network, environments)
        self.assertEqual(result, {'location':'swedencentral', 'properties': {
            'vnetConfiguration': {'infrastructureSubnetId': host['apps_subnet_id'], 'internal': False},
            'workloadProfiles': [{'name':'Consumption','workloadProfileType':'Consumption'}]}})
        self.assertEqual((host, network, environments), original)

    def test_contract_target_failures(self):
        for key, value in [('environment','production'), ('subscription_id','bad'),
                           ('tenant_id',None), ('principal_id',False),
                           ('apps_subnet_id',VNET+'/subnets/supabase'),
                           ('resource_group','another-group'), ('vm_name','another-vm'),
                           ('private_ip','10.81.0.4'), ('password','synthetic-canary')]:
            with self.subTest(key=key):
                h,n,e=fixture(); h[key]=value
                with self.assertRaises(SafeFailure): validate_network(h,n,e)

    def test_network_missing_foreign_and_wrong_region_fail(self):
        for key,value in [('id',VNET.replace(SUB,'00000000-0000-0000-0000-000000000004')),
                          ('location','germanywestcentral'), ('location','swedensouth'),
                          ('prefixes',['10.81.0.0/16']), ('prefixes',None), ('subnets',[]),
                          ('subnets',{}), ('token','synthetic-canary')]:
            with self.subTest(key=key,value=value):
                h,n,e=fixture(); n[key]=value
                with self.assertRaises(SafeFailure): validate_network(h,n,e)

    def test_subnet_wrong_cidr_delegation_and_occupancy_fail(self):
        for key,value in [('prefix','10.80.0.0/23'), ('prefix','10.81.2.0/23'),
                          ('delegations',[]), ('delegations',['Microsoft.Web/serverFarms']),
                          ('ip_configuration_count',1), ('association_count',1),
                          ('ip_configuration_count',True), ('association_count',-1),
                          ('id',VNET+'/subnets/foreign'), ('unknown','synthetic-canary')]:
            with self.subTest(key=key,value=value):
                h,n,e=fixture(); n['subnets'][1][key]=value
                with self.assertRaises(SafeFailure): validate_network(h,n,e)

    def test_duplicate_missing_and_extra_subnets_fail(self):
        for mode in ('duplicate','missing','extra','bad-host-range','bad-host-delegation'):
            h,n,e=fixture()
            if mode=='duplicate': n['subnets'][0]=copy.deepcopy(n['subnets'][1])
            elif mode=='missing': n['subnets'].pop()
            elif mode=='extra': n['subnets'].append(copy.deepcopy(n['subnets'][0]))
            elif mode=='bad-host-range': n['subnets'][0]['prefix']='10.80.2.0/24'
            else: n['subnets'][0]['delegations']=['Microsoft.App/environments']
            with self.subTest(mode=mode), self.assertRaises(SafeFailure): validate_network(h,n,e)

    def test_existing_environment_cannot_be_adopted_or_retrofitted(self):
        for group,subnet,location in [
            ('elsewhere',VNET+'/subnets/container-apps','swedencentral'),
            ('elsewhere',(VNET+'/subnets/container-apps').upper(),'swedencentral'),
            ('tonyai-staging-apps','','swedencentral'),
            ('tonyai-staging-apps','/foreign','germanywestcentral'),
        ]:
            h,n,_=fixture()
            e=[dict(id=f'/subscriptions/{SUB}/resourceGroups/{group}/providers/Microsoft.App/managedEnvironments/existing',
                    location=location,infrastructure_subnet_id=subnet)]
            with self.subTest(group=group,subnet=subnet), self.assertRaises(SafeFailure): validate_network(h,n,e)

    def test_inventory_is_required_and_foreign_subscription_refused(self):
        h,n,_=fixture()
        for e in (None,{},[{}],[dict(id='/subscriptions/foreign/resourceGroups/other/providers/Microsoft.App/managedEnvironments/env',
                                  location='swedencentral',infrastructure_subnet_id='')]):
            with self.subTest(e=e), self.assertRaises(SafeFailure): validate_network(h,n,e)

    def test_each_required_field_missing_fails(self):
        for target in ('host','network','subnet'):
            h,n,e=fixture(); source={'host':h,'network':n,'subnet':n['subnets'][1]}[target]
            for key in list(source):
                value=source.pop(key)
                with self.subTest(target=target,key=key), self.assertRaises(SafeFailure): validate_network(h,n,e)
                source[key]=value

    def test_cli_redacts_malformed_input_and_reports_only_offline_result(self):
        with tempfile.TemporaryDirectory() as directory:
            paths=[Path(directory)/name for name in ('host.json','network.json','environments.json')]
            for path,value in zip(paths,fixture()): path.write_text(json.dumps(value))
            command=[sys.executable,str(ROOT/'infra/scripts/selfhost_app_network.py')]
            for flag,path in zip(('--contract','--network','--environments'),paths): command += [flag,str(path)]
            p=subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(p.returncode,0); self.assertIn('offline',p.stdout)
            self.assertNotIn(SUB,p.stdout+p.stderr)
            paths[0].write_text('{"synthetic-canary": invalid}')
            p=subprocess.run(command,capture_output=True,text=True)
            self.assertNotEqual(p.returncode,0)
            self.assertNotIn('synthetic-canary',p.stdout+p.stderr)
            self.assertNotIn(directory,p.stdout+p.stderr)

    def test_reviewed_cidr_constants_still_match_selfhost_source(self):
        source=(ROOT/'infra/terraform/selfhost/variables.tf').read_text()
        for expression in ('"10.${local.octet}.2.0/23"','"10.${local.octet}.0.0/24"','"10.${local.octet}.0.4"'):
            self.assertIn(expression,source)
        self.assertRegex(source,r'octet\s*=\s*var.config.environment == "staging" \? 80 : 81')


if __name__ == '__main__':
    unittest.main()

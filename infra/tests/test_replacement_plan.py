"""Exact request, state, private packet and no-replan refusal tests; no Azure access."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from replacement_contract import validate_inputs, identities, state_projection
from replacement_plan import CREATE, expected_create, validate_create, validate_plan, rules
from replacement_bundle import private_read, write_new, encoded, digest, clean_environment
from test_selfhost_foundation import inputs as legacy_inputs, public_key
import replacement_run


def inputs(phase='R2'):
    return {**legacy_inputs(), 'containment': True, 'replacement': None if phase == 'R1' else {
        'generation': 'r02', 'recovery_vault_name': 'tonyai-qa-r02-12345678', 'ssh_public_key': public_key(b'\x01\x00\x03')}}


def plan(phase='R2'):
    data = inputs(phase); changes = []
    for address in identities(data['config']):
        value = {'id': identities(data['config'])[address], 'body': {'properties': {}}}
        if address == 'azapi_resource.firewall':
            value['body']['properties']['securityRules'] = rules(data['config']['operator_ipv4'], '10.80.0.4') if phase == 'R2' else []
        if address == 'azapi_resource.network':
            value['body']['properties']['subnets'] = [{'name': 'supabase'}, {'name': 'container-apps'}]
        changes.append(dict(address=address, change=dict(actions=['no-op'], before=copy.deepcopy(value), after=value, after_unknown={})))
    update = next(c for c in changes if c['address'] == ('azapi_resource.firewall' if phase == 'R1' else 'azapi_resource.network'))['change']
    update['actions'] = ['update']
    if phase == 'R1':
        update['after']['body']['properties']['securityRules'] = rules(data['config']['operator_ipv4'], '10.80.0.4')
    else:
        group = identities(data['config'])['azapi_resource.group']
        update['after']['body']['properties']['subnets'].append({'name': 'supabase-r02', 'properties': {
            'addressPrefix': '10.80.1.0/24', 'defaultOutboundAccess': False,
            'networkSecurityGroup': {'id': group + '/providers/Microsoft.Network/networkSecurityGroups/tonyai-staging-data-r02-nsg'}}})
        for address in CREATE:
            changes.append(dict(address=address, change=dict(actions=['create'], before=None, after=expected_create(address, data), after_unknown={'id': True, 'output': True})))
    outputs={'selfhost_contract':dict(actions=['no-op'],before={'generation':'old'},after={'generation':'old'},after_unknown=False)}
    if phase=='R2':
        group=identities(data['config'])['azapi_resource.group']
        outputs['replacement_contract']=dict(actions=['create'],before=None,after=dict(generation='r02',
            vm_id=group+'/providers/Microsoft.Compute/virtualMachines/tonyai-staging-data-r02',private_ip='10.80.1.4',
            recovery_vault_url='https://'+data['replacement']['recovery_vault_name']+'.vault.azure.net',
            apps_subnet_id=identities(data['config'])['azapi_resource.network']+'/subnets/container-apps'),
            after_unknown=dict(public_ip=True,public_hostname=True))
    return dict(complete=True, terraform_version='1.13.3', resource_changes=changes,output_changes=outputs)


class ReplacementPlanTests(unittest.TestCase):
    def test_valid_phase_contracts_and_exact_plans(self):
        for phase in ('R1', 'R2'):
            validate_inputs(inputs(phase), phase)
            self.assertEqual(len(validate_plan(plan(phase), inputs(phase), phase)), 1 if phase == 'R1' else 11)

    def test_unknown_fields_reused_ssh_and_wrong_phase_refused(self):
        for mutate in [lambda x: x.update(secret='sentinel'), lambda x: x.update(containment=False),
                       lambda x: x['replacement'].update(ssh_public_key=x['config']['ssh_public_key']),
                       lambda x: x['replacement'].update(generation='r03'), lambda x: x['replacement'].update(recovery_vault_name='legacy')]:
            data = inputs(); mutate(data)
            with self.assertRaises(Exception): validate_inputs(data, 'R2')
        with self.assertRaises(Exception): validate_inputs(inputs(), 'R1')

    def test_every_resource_request_field_is_bound(self):
        # Real request policy, not a second set of hand-built expected values.
        for address in CREATE:
            expected = expected_create(address, inputs())
            for field in expected:
                altered = copy.deepcopy(expected); altered[field] = 'unreviewed'
                with self.subTest(address=address, field=field), self.assertRaises(Exception):
                    validate_create(address, dict(after=altered, after_unknown={}), inputs())
            for mutate in (lambda x: x.update(unreviewed=True), lambda x: x['body']['properties'].update(customData='sentinel')):
                altered = copy.deepcopy(expected); mutate(altered)
                with self.assertRaises(Exception): validate_create(address, dict(after=altered), inputs())

    def test_computed_identity_allowed_but_unknown_requests_rejected(self):
        address = 'azapi_resource.replacement_host["r02"]'; after = expected_create(address, inputs())
        unknown = {'identity': [{'principal_id': True, 'tenant_id': True}], 'id': True, 'output': True}
        validate_create(address, dict(after=after, after_unknown=unknown), inputs())
        for field in ('type', 'identity_ids'):
            wrong = copy.deepcopy(unknown); wrong['identity'][0][field] = True
            with self.assertRaises(Exception): validate_create(address, dict(after=after, after_unknown=wrong), inputs())
        with self.assertRaises(Exception): validate_create(address, dict(after=after, after_unknown={'body': True}), inputs())

    def test_destructive_import_move_drift_and_foreign_subnet_refused(self):
        for mutate in [lambda x: x.update(resource_drift=[{}]), lambda x: x.update(complete=False),
                       lambda x: x['resource_changes'][0]['change'].update(actions=['delete','create']),
                       lambda x: x['resource_changes'][0]['change'].update(importing={'id': 'foreign'}),
                       lambda x: x['resource_changes'][0].update(previous_address='foreign'),
                       lambda x: x['resource_changes'].pop()]:
            data=plan(); mutate(data)
            with self.assertRaises(Exception): validate_plan(data, inputs(), 'R2')
        data=plan(); update=next(c for c in data['resource_changes'] if c['address']=='azapi_resource.network')
        update['change']['after']['body']['properties']['subnets'][1]['name']='other'
        with self.assertRaises(Exception): validate_plan(data, inputs(), 'R2')

    def test_private_file_refusals_and_exclusive_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'private'; write_new(path,b'fixture')
            self.assertEqual(private_read(path),b'fixture')
            with self.assertRaises(FileExistsError): write_new(path,b'overwrite')
            path.chmod(0o644)
            with self.assertRaises(ValueError): private_read(path)
            path.chmod(0o600); link=Path(directory)/'link'; link.symlink_to(path)
            with self.assertRaises(ValueError): private_read(link)
            os.link(path,Path(directory)/'hardlink')
            with self.assertRaises(ValueError): private_read(path)

    def test_active_contract_switch_and_foreign_replacement_output_refused(self):
        for phase in ('R1','R2'):
            data=plan(phase);data['output_changes']['selfhost_contract']['actions']=['update']
            with self.assertRaises(ValueError):validate_plan(data,inputs(phase),phase)
        data=plan();data['output_changes']['replacement_contract']['after']['private_ip']='10.80.0.4'
        with self.assertRaises(ValueError):validate_plan(data,inputs(),'R2')
        data=plan();data['output_changes']['unexpected']={'actions':['create']}
        with self.assertRaises(ValueError):validate_plan(data,inputs(),'R2')

    def test_environment_overrides_refused(self):
        for key in ('TF_DATA_DIR','TF_WORKSPACE','TF_CLI_ARGS','TF_LOG','TF_VAR_config','ARM_ENDPOINT','AZAPI_LOG'):
            with self.subTest(key=key), self.assertRaises(ValueError): clean_environment({key:'synthetic'})

    def test_state_projection_refuses_foreign_missing_or_tainted_ownership_without_values(self):
        resources=[]
        for address,resource_id in identities(inputs()['config']).items():
            kind,name=address.split('.',1);instance={'attributes':{'id':resource_id,'private_sentinel':'never-return'}}
            if '[' in name:
                name,index=name.split('[',1);instance['index_key']=json.loads(index[:-1])
            resources.append(dict(mode='managed',type=kind,name=name,instances=[instance]))
        state=dict(resources=resources,lineage='00000000-0000-0000-0000-000000000001',serial=1)
        self.assertNotIn('never-return',json.dumps(state_projection(state,inputs()['config'])))
        for mutate in (lambda x:x['resources'].pop(),lambda x:x['resources'][0]['instances'][0].update(status='tainted'),lambda x:x['resources'][0]['instances'][0]['attributes'].update(id='foreign')):
            altered=copy.deepcopy(state);mutate(altered)
            with self.assertRaises(ValueError):state_projection(altered,inputs()['config'])

    def test_prepare_saves_reviewable_binary_and_state_change_never_creates_binding(self):
        for changed in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                packet=Path(directory)/'packet';calls=[]
                def capture(command,env):
                    calls.append(command)
                    if 'plan' in command:
                        target=next(arg[5:] for arg in command if arg.startswith('-out='))
                        write_new(target,b'synthetic-saved-binary');return b'private-diagnostics-not-returned'
                    return encoded(plan('R1'))
                before={'serial':1};after={'serial':2 if changed else 1}
                with patch.object(replacement_run,'context',return_value=(['terraform'],{}, {'phase':'R1'}, inputs('R1'))),patch.object(replacement_run,'state',side_effect=[before,after]),patch.object(replacement_run,'capture',side_effect=capture),patch.object(replacement_run,'terraform_capture',side_effect=lambda command,env,*_:capture(command,env)),patch('sys.stdout'):
                    if changed:
                        with self.assertRaises(ValueError):replacement_run.prepare('backend','inputs','R1',packet)
                        self.assertFalse((packet/'binding.json').exists())
                    else:
                        replacement_run.prepare('backend','inputs','R1',packet)
                        binding=json.loads(private_read(packet/'binding.json'))
                        self.assertEqual(binding['plan_sha256'],digest(b'synthetic-saved-binary'))
                        self.assertEqual(binding['state'],before)
                self.assertFalse(any('apply' in command or 'init' in command for command in calls))

    def test_apply_uses_saved_binary_and_never_replans_or_initializes(self):
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory); raw=encoded({'phase':'R1','created_at':1000,'state':{'serial':1},'plan_sha256':digest(b'plan'),'projection_sha256':digest(encoded(plan('R1')))})
            write_new(folder/'binding.json',raw);write_new(folder/'saved.tfplan',b'plan')
            calls=[]
            def capture(cmd,env):
                calls.append(cmd)
                return encoded(plan('R1')) if 'show' in cmd else b''
            with patch.object(replacement_run,'context',return_value=(['terraform'],{}, {'phase':'R1'}, inputs('R1'))), patch.object(replacement_run,'state',return_value={'serial':1}), patch.object(replacement_run,'capture',side_effect=capture), patch.object(replacement_run,'terraform_capture',side_effect=lambda command,env,*_:capture(command,env)), patch.object(replacement_run.time,'time',return_value=1001):
                replacement_run.apply('backend','inputs','R1',folder,digest(raw))
            self.assertEqual(calls[-1],['terraform','apply','-input=false','-lock-timeout=60s',str(folder/'saved.tfplan')])
            self.assertFalse(any('plan' in c or 'init' in c or '-auto-approve' in c for c in calls))

    def test_apply_binding_tamper_and_expiry_never_invoke_apply(self):
        for mutation in ('approval','plan','state','source','expired'):
            with tempfile.TemporaryDirectory() as directory:
                folder=Path(directory); raw=encoded({'phase':'R1','created_at':1000,'state':{'serial':1},'plan_sha256':digest(b'plan'),'projection_sha256':digest(encoded(plan('R1')))})
                write_new(folder/'binding.json',raw);write_new(folder/'saved.tfplan',b'tampered' if mutation=='plan' else b'plan')
                with patch.object(replacement_run,'context',return_value=(['terraform'],{}, {'phase':'R2' if mutation=='source' else 'R1'}, inputs('R1'))), patch.object(replacement_run,'state',return_value={'serial':2 if mutation=='state' else 1}), patch.object(replacement_run,'capture') as capture, patch.object(replacement_run.time,'time',return_value=9999 if mutation=='expired' else 1001):
                    with self.assertRaises(ValueError): replacement_run.apply('backend','inputs','R1',folder,'bad' if mutation=='approval' else digest(raw))
                    capture.assert_not_called()

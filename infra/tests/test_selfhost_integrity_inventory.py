"""Synthetic boundary tests; no database, Docker, SSH or secret access."""
import json
from pathlib import Path
import sys
import re
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import selfhost_integrity_inventory as probe


def payload():
    return {'format':2,'event_triggers_disabled':True,'read_only':True,'database_matches':True,'server_version_num':170006,
            'counts':dict.fromkeys(probe.COUNTS,0),'relations':dict.fromkeys(probe.RELATIONS,False)}


def container():
    return {'id':'a'*64,'name':'/supabase-db','image':probe.DB_IMAGE,'project':'supabase',
            'service':'db','running':True,'ports':{}}


class InventoryTests(unittest.TestCase):
    def test_empty_counts_never_mean_clean_or_disposable(self):
        report=probe.validate_report(json.dumps(payload()).encode())
        self.assertEqual(report['integrity_verdict'],'NOT_ASSESSED')
        self.assertEqual(report['pd3'],'OPEN')
        self.assertFalse(report['safe_to_discard_data'])
        self.assertFalse(report['baseline_compared'])
        self.assertEqual(report['scope'],'postgres_catalog_metadata_only')

    def test_unknown_secret_fields_are_refused_not_forwarded(self):
        for kind in ('root','counts','relations'):
            value=payload();target=value if kind=='root' else value[kind]
            target['password']='synthetic-secret-canary'
            with self.subTest(kind=kind),self.assertRaises(ValueError) as caught:
                probe.validate_report(json.dumps(value).encode())
            self.assertNotIn('synthetic-secret-canary',str(caught.exception))

    def test_partial_duplicate_and_oversize_outputs_refused(self):
        for data in (b'{}',b'{"format":1,"format":1}',b'{}\n{}',b'x'*16385,b'[]'):
            with self.subTest(data=data[:30]),self.assertRaises((ValueError,TypeError)):
                probe.validate_report(data)

    def test_otherwise_valid_duplicate_root_and_nested_fields_refused(self):
        raw=json.dumps(payload())
        for original,replacement in [('"format": 2','"format": 2, "format": 2'),
                                     ('"roles": 0','"roles": 0, "roles": 0'),
                                     ('"auth_users": false','"auth_users": false, "auth_users": false')]:
            candidate=raw.replace(original,replacement,1)
            self.assertNotEqual(candidate,raw)
            with self.subTest(original=original),self.assertRaisesRegex(ValueError,'Duplicate'):
                probe.validate_report(candidate.encode())

    def test_scope_and_scalar_type_refusals(self):
        for key,value in [('format',True),('format',1),('format',3),('event_triggers_disabled',False),('event_triggers_disabled',1),('read_only',False),('read_only',1),
                          ('database_matches',False),('server_version_num',160006),('server_version_num',180000)]:
            data=payload();data[key]=value
            with self.subTest(key=key,value=value),self.assertRaises(ValueError):probe.validate_report(json.dumps(data).encode())
        for value in (-1,True,1.5,'synthetic-secret',2**63):
            data=payload();data['counts']['roles']=value
            with self.subTest(value=value),self.assertRaises(ValueError):probe.validate_report(json.dumps(data).encode())
        data=payload();data['relations']['auth_users']=1
        with self.assertRaises(ValueError):probe.validate_report(json.dumps(data).encode())

    def test_missing_categories_refused(self):
        for key in ('counts','relations'):
            data=payload();data[key].pop(next(iter(data[key])))
            with self.subTest(key=key),self.assertRaises(ValueError):probe.validate_report(json.dumps(data).encode())

    def test_inventory_remains_bound_to_retained_generation(self):
        self.assertEqual(probe.DB_IMAGE,
                         'supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00')
        # A future replacement image must never retarget this forensic helper.
        lock=json.loads((Path(__file__).resolve().parents[1]/'selfhost/images.qa.lock.json').read_text())
        item=container();item['image']=lock['services']['db']['image']
        with patch.object(probe,'call',return_value=json.dumps(item).encode()) as call,self.assertRaises(ValueError):
            probe.collect()
        self.assertEqual(call.call_count,1)

    def test_foreign_stopped_or_exposed_container_never_executes_query(self):
        changes=[('name','/other'),('image','supabase/postgres:latest'),('project','other'),
                 ('service','api-gw'),('running',False),('ports',{'5432/tcp':[]}),('id','bad')]
        for key,value in changes:
            item=container();item[key]=value
            with self.subTest(key=key),patch.object(probe,'call',return_value=json.dumps(item).encode()) as call,self.assertRaises(ValueError):probe.collect()
            self.assertEqual(call.call_count,1)

    def test_query_is_stdin_bound_to_exact_id_with_clean_client_and_no_password(self):
        with patch.object(probe,'call',side_effect=[json.dumps(container()).encode(),json.dumps(payload()).encode()]) as call:
            result=probe.collect()
        command=call.call_args_list[1].args[0]
        self.assertEqual(command[:7],probe.DOCKER+['exec','--user','postgres','-i'])
        self.assertEqual(command[7],'a'*64)
        self.assertEqual(command[8:10],['/usr/bin/env','-i'])
        for flag in ('-X','-w','--set=ON_ERROR_STOP=1','-qAt'):self.assertIn(flag,command)
        self.assertEqual(command[-6:],['-h','/var/run/postgresql','-U','postgres','-d','postgres'])
        options=next(x for x in command if x.startswith('PGOPTIONS='))
        for expected in ('event_triggers=off','default_transaction_read_only=on','search_path=pg_catalog','statement_timeout=5000','lock_timeout=1000','idle_in_transaction_session_timeout=10000','row_security=off'):
            self.assertIn(expected,options)
        self.assertEqual(call.call_args_list[1].args[1],probe.SQL.encode())
        self.assertNotIn('PGPASSWORD',str(command))
        self.assertIn('PGPASSFILE=/dev/null',command)
        self.assertEqual(result['pd3'],'OPEN')

    def test_static_queries_exclude_business_rows_and_sensitive_definitions(self):
        self.assertTrue(probe.SQL.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'))
        self.assertTrue(probe.SQL.endswith('ROLLBACK;\n'))
        for forbidden in ('SELECT *','rolpassword','encrypted_password','prosrc','probin','subconninfo',
                          'FROM auth.','FROM storage.','pg_get_functiondef','COPY ','CREATE ','ALTER ','pg_dump'):
            self.assertNotIn(forbidden,probe.SQL)
        for catalog in ('pg_auth_members','pg_default_acl','pg_event_trigger','pg_policy','pg_subscription'):
            self.assertIn('pg_catalog.'+catalog,probe.SQL)
        references=re.findall(r'\b(?:FROM|JOIN)\s+([a-z_.]+)',probe.SQL)
        self.assertTrue(references)
        for relation in references:
            self.assertRegex(relation,r'^pg_catalog\.pg_[a-z_]+$')

    def test_foreign_host_contract_is_rejected_before_docker_access(self):
        host={'environment':'staging','resource_group':'tonyai-staging-data','vm_name':'tonyai-staging-data',
              'public_hostname':'qa.swedencentral.cloudapp.azure.com'}
        for key,value in [('environment','production'),('resource_group','foreign'),('vm_name','foreign'),
                          ('public_hostname','foreign.example.com'),('unexpected','value')]:
            changed=dict(host);changed[key]=value
            with self.subTest(key=key),patch.object(probe.os,'geteuid',return_value=0), \
                 patch.object(probe.sys,'flags',SimpleNamespace(isolated=1)),patch.object(probe,'trusted_file'), \
                 patch.object(probe.Path,'read_bytes',side_effect=[json.dumps({'public_hostname':host['public_hostname']}).encode(),json.dumps(changed).encode()]), \
                 patch.object(probe,'collect') as collect,self.assertRaises(ValueError):probe.main()
            collect.assert_not_called()

    def test_minimal_installed_host_contract_matches_private_target_without_extra_fields(self):
        hostname='qa.swedencentral.cloudapp.azure.com'
        target={'environment':'staging','resource_group':'tonyai-staging-data',
                'vm_name':'tonyai-staging-data','public_hostname':hostname}
        with patch.object(probe.os,'geteuid',return_value=0), \
             patch.object(probe.sys,'flags',SimpleNamespace(isolated=1)),patch.object(probe,'trusted_file'), \
             patch.object(probe.Path,'read_bytes',side_effect=[json.dumps({'public_hostname':hostname}).encode(),json.dumps(target).encode()]), \
             patch.object(probe,'collect',return_value={'pd3':'OPEN'}) as collect,patch('builtins.print'):
            probe.main()
        collect.assert_called_once_with()

    def test_different_valid_hostname_is_refused_before_query(self):
        target={'environment':'staging','resource_group':'tonyai-staging-data',
                'vm_name':'tonyai-staging-data','public_hostname':'qa.swedencentral.cloudapp.azure.com'}
        with patch.object(probe.os,'geteuid',return_value=0), \
             patch.object(probe.sys,'flags',SimpleNamespace(isolated=1)),patch.object(probe,'trusted_file'), \
             patch.object(probe.Path,'read_bytes',side_effect=[b'{"public_hostname":"other.sysgen.cloudapp.azure.com"}',json.dumps(target).encode()]), \
             patch.object(probe,'collect') as collect,self.assertRaises(ValueError):probe.main()
        collect.assert_not_called()

    def test_login_trigger_count_and_startup_guard_are_required(self):
        self.assertEqual(probe.COUNTS['login_event_triggers'],
                         "SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtevent='login'")
        self.assertIn("pg_catalog.current_setting('event_triggers')='off'",probe.SQL)
        data=payload();del data['event_triggers_disabled']
        with self.assertRaises(ValueError):probe.validate_report(json.dumps(data).encode())
        data=payload();del data['counts']['login_event_triggers']
        with self.assertRaises(ValueError):probe.validate_report(json.dumps(data).encode())

    def test_connection_startup_failure_is_not_retried_with_weaker_options(self):
        with patch.object(probe,'call',side_effect=[json.dumps(container()).encode(),ValueError('Startup refused')]) as call:
            with self.assertRaises(ValueError):probe.collect()
        self.assertEqual(call.call_count,2)
        self.assertIn('event_triggers=off',str(call.call_args_list[-1]))

    def test_subprocess_errors_do_not_echo_private_output(self):
        with patch.object(probe.subprocess,'run',return_value=SimpleNamespace(returncode=1,stdout=b'secret',stderr=b'secret')) as run:
            with self.assertRaises(ValueError) as caught:probe.call(['synthetic'])
        self.assertNotIn('secret',str(caught.exception))
        self.assertEqual(run.call_args.kwargs['timeout'],25)
        self.assertEqual(run.call_args.kwargs['env'],{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})


if __name__=='__main__':unittest.main()

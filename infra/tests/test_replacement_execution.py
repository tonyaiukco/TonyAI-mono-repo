"""Execute owner-report, same-host recovery and guarded-start flows with private synthetic IO."""
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from test_replacement_custody import contract
from replacement_bundle import encoded, write_new
from replacement_custody import ENV, SODIUM, envelope, marker
from replacement_probe import HTTP_CASES, DB_ROLES
from replacement_host import check_source_tree
import replacement_probe_owner as owner
import replacement_restore as restore
import replacement_start as start


def report(data, status='PASS'):
    names=set(HTTP_CASES)|{'db-'+role for role in DB_ROLES}|{'storage-s3'}|{
        consumer+'-'+algorithm+'-'+role for consumer in ('rest-service','storage-service','realtime-admin')
        for algorithm in ('HS256','ES256') for role in ('anon','service_role')}
    return dict(format=1,generation='r02',pd3='OPEN',results={name:status for name in names},
        binding={key:data[key] for key in ('vm_id','vm_uuid','source_sha256')},remaining=['remote-secret-sentinel'])


class ReplacementExecutionTests(unittest.TestCase):
    def test_partial_and_failed_owner_reports_survive_without_remote_text(self):
        for status in ('PASS','INCONCLUSIVE','FAIL_OLD_ACCEPTED'):
            with self.subTest(status=status),tempfile.TemporaryDirectory() as folder:
                destination=Path(folder)/'report'; data=contract()
                result=subprocess.CompletedProcess([],int(status!='PASS'),encoded(report(data,status)),b'secret-stderr-sentinel')
                incomplete=owner.save_probe_report(result,destination,data,'a'*32)
                self.assertEqual(incomplete,status!='PASS')
                saved=json.loads(destination.read_bytes())
                self.assertEqual(saved['old_version'],'a'*32)
                self.assertEqual(saved['binding']['vm_uuid'],data['vm_uuid'])
                self.assertNotIn('sentinel',destination.read_text())
                self.assertEqual(destination.stat().st_mode&0o777,0o600)

    def test_transport_raw_error_status_disagreement_and_foreign_binding_never_saved(self):
        data=contract();foreign=report(data);foreign['binding']['source_sha256']='b'*64
        for code,raw in [(255,encoded(report(data))), (1,b'secret-sentinel'),(0,encoded(report(data,'INCONCLUSIVE'))),(1,encoded(report(data))),(0,encoded(foreign))]:
            with tempfile.TemporaryDirectory() as folder:
                target=Path(folder)/'report'
                with self.assertRaises(Exception):owner.save_probe_report(subprocess.CompletedProcess([],code,raw),target,data,'a'*32)
                self.assertFalse(target.exists())

    def test_owner_cli_preserves_incomplete_report_and_nonzero_status(self):
        data=contract();old={key:data[key] for key in ('subscription_id','tenant_id')}
        response=MagicMock();response.__enter__.return_value=io.BytesIO(encoded(dict(
            id='https://old.vault.azure.net/secrets/supabase-runtime-env/'+'a'*32,attributes={'enabled':True},value='synthetic-old-secret')))
        with tempfile.TemporaryDirectory() as folder:
            old_path=Path(folder)/'old';new_path=Path(folder)/'new';target=Path(folder)/'report'
            write_new(old_path,encoded(old));write_new(new_path,encoded(data))
            argv=['probe','--old-contract',str(old_path),'--new-contract',str(new_path),'--old-version','a'*32,'--key','key','--known-hosts','known','--report',str(target)]
            account={'id':data['subscription_id'],'tenantId':data['tenant_id']}
            with patch.object(sys,'argv',argv),patch.object(owner,'legacy_contract',return_value='https://old.vault.azure.net'),patch.object(owner,'capture',side_effect=[encoded(account),encoded({'accessToken':'synthetic-token'})]),patch.object(owner,'build_opener') as opener,patch.object(owner.subprocess,'run',return_value=subprocess.CompletedProcess([],1,encoded(report(data,'INCONCLUSIVE')),b'secret-sentinel')) as remote,patch('sys.stdout',new_callable=io.StringIO) as output:
                opener.return_value.open.return_value=response
                self.assertEqual(owner.main(),1)
                self.assertTrue(target.exists());self.assertNotIn('sentinel',output.getvalue())
                command=remote.call_args.args[0]
                self.assertIn('StrictHostKeyChecking=yes',command)
                self.assertNotIn('synthetic-old-secret',str(command))
                self.assertEqual(remote.call_args.kwargs['input'],b'synthetic-old-secret')

    def test_env_loss_recovery_keeps_matching_marker_and_refuses_mismatch(self):
        data=contract();files={ENV:b"POSTGRES_PASSWORD='synthetic'\n",SODIUM:b'synthetic-intrinsic'}
        record=marker(data,'intrinsic','a'*32,files)
        for retained in ('matching','mismatching','absent'):
            with self.subTest(retained=retained),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);key=root/'db-config'/'pgsodium_root.key';key.parent.mkdir();key.parent.chmod(0o700);write_new(key,files[SODIUM])
                target=root/'.env';receipt=root/'receipt';environment_receipt=root/'environment-receipt'
                write_new(environment_receipt,encoded(marker(data,'environment','b'*32,{ENV:files[ENV]})))
                if retained!='absent':write_new(receipt,encoded(record) if retained=='matching' else b'foreign-evidence')
                before=receipt.read_bytes() if receipt.exists() else None
                mapping={ENV:target,SODIUM:key,'/etc/tonyai/escrow-r02-intrinsic.json':receipt,'/etc/tonyai/escrow-r02-environment.json':environment_receipt}
                stream=MagicMock();stream.buffer=io.BytesIO(encoded({'envelope':envelope(data,'intrinsic',files),'record':record}))
                with patch.object(sys,'argv',['restore']),patch.object(sys,'stdin',stream),patch.object(restore,'check',return_value=data),patch.object(restore.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'')),patch.object(restore,'Path',side_effect=lambda path:mapping.get(str(path),Path(path))),patch.object(restore,'safe_path',side_effect=lambda path,**_:mapping.get(str(path),Path(path))),patch('replacement_custody_host.collect',return_value=files),patch('sys.stdout',new_callable=io.StringIO):
                    if retained=='mismatching':
                        with self.assertRaises(ValueError):restore.main()
                        self.assertFalse(target.exists());self.assertEqual(receipt.read_bytes(),before)
                    else:
                        restore.main();self.assertEqual(target.read_bytes(),files[ENV]);self.assertEqual(receipt.read_bytes(),encoded(record))

    def test_recovery_refuses_running_containers_before_reading_payload(self):
        with patch.object(sys,'argv',['restore']),patch.object(restore,'check',return_value=contract()),patch.object(restore.subprocess,'run',return_value=subprocess.CompletedProcess([],0,b'container-id')),patch.object(sys,'stdin') as stream:
            with self.assertRaises(ValueError):restore.main()
            stream.buffer.read.assert_not_called()

    def test_directory_mounts_reject_extra_sql_files_directories_and_links(self):
        for extra in ('init.sql','extra','link'):
            with tempfile.TemporaryDirectory() as folder:
                runtime=Path(folder);source=runtime/'volumes/functions/main/index.ts';source.parent.mkdir(parents=True);source.write_text('synthetic')
                files={str(source):'a'*64}
                with patch('replacement_host.safe_path',side_effect=lambda p,directory=False:Path(p)):
                    check_source_tree(files,runtime)
                    target=source.parent/extra
                    if extra=='extra':target.mkdir()
                    elif extra=='link':target.symlink_to(source)
                    else:target.write_text('unreviewed')
                    with self.assertRaises(ValueError):check_source_tree(files,runtime)

    def test_runtime_start_includes_all_profiles_only_for_validation(self):
        data=contract();image='example/db@sha256:'+'a'*64
        locked={'db':{'image':image,'platform':'linux/amd64'},'realtime':{'image':image,'platform':'linux/amd64'}}
        config={'services':{name:{**value,'restart':'no'} for name,value in locked.items()}}
        config['services']['realtime']['environment']={'DB_ENC_WRITE_GCM':'true','DB_ENC_KEY_GCM':'a'*32}
        def safe(path):
            fake=MagicMock()
            value={'services':locked} if str(path).endswith('compose.images.json') else dict(generation='r02',vm_id=data['vm_id'],source_sha256=data['source_sha256'],state='started') if 'initialization' in str(path) else {}
            fake.read_bytes.return_value=encoded(value);return fake
        calls=[]
        def run(command,**kwargs):
            calls.append(command);return subprocess.CompletedProcess(command,0,encoded(config) if 'config' in command else b'')
        with patch.object(sys,'argv',['start','runtime-start']),patch.object(start,'check',return_value=data),patch.object(start.os,'chdir'),patch.object(start,'safe_path',side_effect=safe),patch.object(start,'verify_marker'),patch.object(start,'collect'),patch.object(start,'redact_gateway'),patch.object(start,'validate'),patch.object(start.subprocess,'run',side_effect=run),patch('sys.stdout',new_callable=io.StringIO):
            start.main()
        self.assertIn('--profile',calls[1]);self.assertIn('*',calls[1])
        self.assertNotIn('--profile',calls[-1]);self.assertIn('up',calls[-1])
        config['services']['db']['restart']='unless-stopped'
        calls.clear()
        with patch.object(sys,'argv',['start','runtime-start']),patch.object(start,'check',return_value=data),patch.object(start.os,'chdir'),patch.object(start,'safe_path',side_effect=safe),patch.object(start,'verify_marker'),patch.object(start,'collect'),patch.object(start,'redact_gateway'),patch.object(start,'validate'),patch.object(start.subprocess,'run',side_effect=run):
            with self.assertRaises(ValueError):start.main()
        self.assertFalse(any('up' in command for command in calls))

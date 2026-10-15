"""Generation identity, whole-disk freshness, custody and probe failure controls."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from replacement_bundle import digest, encoded
from replacement_host import validate_contract, validate_identity, check, PATHS
from replacement_custody import envelope, unpack, marker, verify_marker, ENV, SODIUM
from replacement_probe import classify_pair, probe_pair, parse_environment, SECRET_FIELDS, evaluate, HTTP_CASES, DB_ROLES
from replacement_s3 import headers as s3_headers


def contract():
    layout=json.loads((Path(__file__).resolve().parents[1]/'scripts/replacement-source-layout.json').read_text())
    files={path: value or 'a'*64 for path,value in layout.items()}
    for name in ('docker-compose.yml','compose.qa.yml','compose.https.yml','compose.r02.yml','compose.images.json','.env.example','Caddyfile','credential-template.json'):
        files.setdefault('/opt/tonyai/supabase/'+name,'a'*64)
    for name in ('replacement_host.py','replacement_bundle.py','replacement_custody.py','replacement_custody_host.py','replacement_start.py','selfhost_pin.py','selfhost_init.mjs','selfhost_db_config.py','selfhost_disks.py','selfhost_docker.sh','selfhost_host_guard.sh'):
        files['/usr/local/lib/tonyai/'+name]='a'*64
    files['/usr/local/sbin/tonyai-runtime-guard']='a'*64
    group='/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/tonyai-staging-data'
    return dict(format=2,generation='r02',vm_id=group+'/providers/Microsoft.Compute/virtualMachines/tonyai-staging-data-r02',
        vm_uuid='00000000-0000-0000-0000-000000000004',os_disk_id=group+'/providers/Microsoft.Compute/disks/tonyai-staging-data-r02-os',
        subscription_id='00000000-0000-0000-0000-000000000001',tenant_id='00000000-0000-0000-0000-000000000002',
        location='swedencentral', public_hostname='tonyai-staging-test-r02.swedencentral.sysgen.cloudapp.azure.com',
        operator_email='operator@example.com',recovery_vault_url='https://tonyai-qa-r02-12345678.vault.azure.net',
        source_sha256=digest(encoded(files)), files=files, disks={name:dict(id=group+'/providers/Microsoft.Compute/disks/tonyai-staging-data-r02-'+name,
        uuid='00000000-0000-0000-0000-00000000000'+str(index+5),lun=index,size_gib=64 if name=='database' else 32) for index,name in enumerate(PATHS)})


class ReplacementCustodyTests(unittest.TestCase):
    def test_exact_host_identity_and_complete_source_layout(self):
        data=contract();validate_contract(data)
        compute=dict(resourceId=data['vm_id'],vmId=data['vm_uuid'],location='swedencentral',storageProfile={
            'osDisk':{'managedDisk':{'id':data['os_disk_id']}},'dataDisks':[{'lun':str(v['lun']),'managedDisk':{'id':v['id']}} for v in data['disks'].values()]})
        validate_identity(data,compute)
        for path in data['files']:
            wrong=copy.deepcopy(data);wrong['files'].pop(path);wrong['source_sha256']=digest(encoded(wrong['files']))
            with self.subTest(path=path),self.assertRaises(ValueError):validate_contract(wrong)
        for field in ('resourceId','vmId','location'):
            wrong=copy.deepcopy(compute);wrong[field]='foreign'
            with self.assertRaises(ValueError):validate_identity(data,wrong)
        compute['storageProfile']['dataDisks'][0]['managedDisk']['id']=data['os_disk_id']
        with self.assertRaises(ValueError):validate_identity(data,compute)

    def test_recovery_never_accepts_other_generation_source_disk_version_or_stage(self):
        data=contract();files={ENV:b"POSTGRES_PASSWORD='synthetic'\n",SODIUM:b'synthetic-intrinsic'}
        value=envelope(data,'intrinsic',files);self.assertEqual(unpack(value,data,'intrinsic'),files)
        record=marker(data,'intrinsic','a'*32,files);verify_marker(record,data,'intrinsic',files)
        for field in ('generation','vm_id','vm_uuid','source_sha256','recovery_vault_url','disks'):
            wrong=copy.deepcopy(record);wrong['binding'][field]='foreign'
            with self.subTest(field=field),self.assertRaises(Exception):verify_marker(wrong,data,'intrinsic',files)
        for version in ('','latest','a'*31,'../escape'):
            with self.assertRaises(ValueError):marker(data,'intrinsic',version,files)
        with self.assertRaises(ValueError):unpack(value,data,'environment')
        with self.assertRaises(ValueError):envelope(data,'intrinsic',{ENV:b'synthetic'})
        changed={**files,SODIUM:b'new'}
        with self.assertRaises(ValueError):verify_marker(record,data,'intrinsic',changed)

    def test_whole_disk_freshness_rejects_every_persistent_path_before_writes(self):
        for name,paths in PATHS.items():
            for child in (*paths,'unexpected','lost+found'):
                with tempfile.TemporaryDirectory() as directory:
                    root=Path(directory);mounts={key:root/key for key in PATHS}
                    for path in mounts.values():path.mkdir()
                    dirty=mounts[name]/child;dirty.mkdir();(dirty/'retained').write_text('synthetic')
                    data=contract();file=root/'contract';file.write_text(json.dumps(data))
                    def safe(path,directory=False):
                        if str(path).startswith(str(root)):return Path(path)
                        if str(path).endswith('replacement.json'):return file
                        if str(path).startswith('/srv/tonyai/'):
                            return root/str(path).removeprefix('/srv/tonyai/')
                        raise AssertionError('Source read reached before dirty disk refusal')
                    response=MagicMock();response.__enter__.return_value=response
                    with patch('replacement_host.os.geteuid',return_value=0),patch('replacement_host.safe_path',side_effect=safe),patch('replacement_host.os.path.ismount',return_value=True),patch('replacement_host.build_opener') as opener,patch('replacement_host.json.load',return_value={'compute':{}}),patch('replacement_host.validate_identity'),patch('replacement_host.capture',side_effect=lambda *args: data['disks'][args[-1].split('/')[-1]]['uuid']+' ext4 /'):
                        opener.return_value.open.return_value=response
                        with self.subTest(name=name,child=child),self.assertRaises(ValueError):check(fresh=True)

    def test_timeout_transport_denial_policy_refusal_and_bad_new_control_are_inconclusive(self):
        self.assertEqual(classify_pair(200,401),'PASS')
        for new,old in [(200,403),(500,401),(0,0),(200,302),(200,500),(401,401)]:self.assertEqual(classify_pair(new,old),'INCONCLUSIVE')
        self.assertEqual(classify_pair(200,200),'FAIL_OLD_ACCEPTED')
        self.assertEqual(probe_pair(lambda _: (_ for _ in ()).throw(ValueError('sentinel')),{},{}),'INCONCLUSIVE')
        values=iter([200,401,503]);self.assertEqual(probe_pair(lambda _: next(values),{},{}),'INCONCLUSIVE')

    def test_no_secret_returned_from_pair_matrix_and_reuse_refused(self):
        old={k:'old-sentinel-'+k for k in SECRET_FIELDS};new={k:'new-sentinel-'+k for k in SECRET_FIELDS}
        old['DASHBOARD_USERNAME']=new['DASHBOARD_USERNAME']='operator'
        responses={name:iter([200,401,200]) for name in HTTP_CASES}
        db={name:iter([200,401,200]) for name in DB_ROLES}
        result=evaluate(old,new,lambda name:lambda _:next(responses[name]),lambda role,_:next(db[role]))
        self.assertEqual(set(result.values()),{'PASS'});self.assertNotIn('sentinel',json.dumps(result))
        new['JWT_SECRET']=old['JWT_SECRET']
        with self.assertRaises(ValueError):evaluate(old,new,None,None)

    def test_private_parser_never_executes_expansion_and_rejects_duplicates(self):
        raw='\n'.join(k+"='$(sentinel)'" for k in SECRET_FIELDS).encode()
        self.assertEqual(parse_environment(raw)['JWT_SECRET'],'$(sentinel)')
        with self.assertRaises(ValueError):parse_environment(raw+b"\nJWT_SECRET='duplicate'")
        with self.assertRaises(ValueError):parse_environment(b'POSTGRES_PASSWORD=only')

    def test_s3_signatures_bind_secret_and_fixed_read_only_path(self):
        from datetime import datetime,timezone
        env={'S3_PROTOCOL_ACCESS_KEY_ID':'synthetic','S3_PROTOCOL_ACCESS_KEY_SECRET':'old'}
        url='http://172.20.0.2:5000/s3/';now=datetime(2026,10,15,tzinfo=timezone.utc)
        first=s3_headers(url,env,now);other=s3_headers(url,{**env,'S3_PROTOCOL_ACCESS_KEY_SECRET':'new'},now)
        self.assertNotEqual(first['Authorization'],other['Authorization'])
        with self.assertRaises(ValueError):s3_headers(url+'object',env,now)

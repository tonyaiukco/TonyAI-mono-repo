"""Real local Git objects prove historical fingerprints never use today's checkout."""
from copy import deepcopy
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from candidate import fingerprint
from qa_contract import ROOT, release
from qa_discovery import digest
from qa_foundation import CONFIG_FILES
from qa_application import CONFIG_FILES as APP_FILES
from qa_deployment_source import historical_source, bind_report
from qa_deployment_contract import predecessor
from qa_deployment_fixtures import evidence, request, NOW, accepted


def substitute(value, replacements):
    if isinstance(value,dict):return {k:substitute(v,replacements) for k,v in value.items()}
    if isinstance(value,list):return [substitute(v,replacements) for v in value]
    return replacements.get(value,value) if isinstance(value,str) else value


def receipt_binding(receipt,spec):
    for key in receipt:
        if key in spec:receipt[key]=deepcopy(spec[key])
    receipt['manifest_sha256']=digest(spec)
    for record in receipt['records']:
        record['pages'][0]['argv_sha256']=digest(spec['commands'][record['key']]['argv'])
        record['pages'][0]['result_sha256']=digest(record['pages'][0]['result'])


def real_chain(shas, app_fingerprint):
    ev=substitute(evidence(),{c*40:s for c,s in zip('abce',shas)})
    u5,u7=ev['unit5'],ev['unit7'];rt=u5['runtime_predecessor'];initial=rt['initial_predecessor']
    from qa_foundation_inputs import initial_inputs
    from qa_foundation_readback import manifest as initial_manifest
    from qa_runtime_contract import transition as runtime_transition
    from qa_runtime_receipt import manifest as runtime_manifest
    from qa_oidc_contract import transition as oidc_transition
    from qa_oidc_receipt import manifest as oidc_manifest
    from qa_application_receipt import manifest as app_manifest,expected_names
    from qa_expected import body
    initial['initial_plan']['normalized_inputs_sha256']=digest(initial_inputs(rt['runtime_request']['before_inputs']))
    receipt_binding(initial['readback'],initial_manifest(rt['runtime_request']['before_inputs']))
    rt['runtime_request']['predecessor_sha256']=digest(initial)
    old,new=runtime_transition(rt['runtime_request'])
    rp=rt['saved_plan'];rp.update(request_sha256=digest(rt['runtime_request']),predecessor_sha256=digest(initial),
        before_inputs_sha256=digest(old),after_inputs_sha256=digest(new),previous_readback_sha256=digest(initial['readback']))
    for phase in ('before','after'):receipt_binding(rt[phase+'_receipt'],runtime_manifest(rt['runtime_request'],initial,rp['plan_sha256'],phase))
    u5['oidc_request']['predecessor_sha256']=digest(rt)
    old,new=oidc_transition(u5['oidc_request'])
    op=u5['saved_plan'];op.update(request_sha256=digest(u5['oidc_request']),predecessor_sha256=digest(rt),
        before_inputs_sha256=digest(old),after_inputs_sha256=digest(new),previous_readback_sha256=digest(rt['after_receipt']))
    for phase in ('before','after'):receipt_binding(u5[phase+'_receipt'],oidc_manifest(u5['oidc_request'],rt,op['plan_sha256'],phase))
    u5['owner_acceptance']=accepted(5,op,u5['after_receipt'])
    u7['candidate'].update(app_fingerprint)
    ap=u7['saved_plan'];ap.update(normalized_inputs_sha256=digest(u7['inputs']),candidate_sha256=digest(u7['candidate']),
        input_file_sha256=digest(u7['inputs']),candidate_file_sha256=digest(u7['candidate']))
    u7['candidate_provenance']['candidate_file_sha256']=ap['candidate_file_sha256']
    for kind,row in zip(('api','web'),ap['resources']):row['expected_body_sha256']=digest(body(u7['inputs'],kind))
    for phase in ('before','after'):
        names=expected_names(u7['inputs'],u7['outgoing_revisions'],phase)
        receipt_binding(u7[phase+'_receipt'],app_manifest(u7['inputs'],ap['plan_sha256'],names,phase))
    u7['owner_acceptance']=accepted(7,ap,u7['after_receipt'])
    return ev


class HistoricalSource(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory(prefix='qa-unit8-git-test-');self.addCleanup(directory.cleanup)
        self.root=Path(directory.name)
        for kind,names in (('foundation',CONFIG_FILES),('application',APP_FILES)):
            folder=Path('infra/terraform')/kind/'qa'
            (self.root/folder).mkdir(parents=True)
            for name in names|{'.terraform.lock.hcl'}:shutil.copyfile(ROOT/folder/name,self.root/folder/name)
        (self.root/'infra/config').mkdir()
        shutil.copyfile(ROOT/'infra/config/deployment-policy.json',self.root/'infra/config/deployment-policy.json')
        shutil.copyfile(ROOT/'pnpm-lock.yaml',self.root/'pnpm-lock.yaml')
        for path in (ROOT/'packages/db/prisma/migrations').glob('*/migration.sql'):
            target=self.root/path.relative_to(ROOT);target.parent.mkdir(parents=True);shutil.copyfile(path,target)
        self.git('init','-q');self.git('config','user.name','Synthetic Test');self.git('config','user.email','synthetic@example.invalid')
        self.shas=[]
        for i in range(4):
            (self.root/'public-marker.txt').write_text(str(i))
            if i==3:
                with (self.root/'pnpm-lock.yaml').open('a') as target:target.write('\n# Historical candidate fixture\n')
                migration=self.root/'packages/db/prisma/migrations/20990101000000_synthetic/migration.sql'
                migration.parent.mkdir();migration.write_text('-- Historical synthetic migration; never executed.\n')
            self.shas.append(self.commit())
        self.source_patch=patch('qa_deployment_source.ROOT',self.root);self.source_patch.start();self.addCleanup(self.source_patch.stop)

    def git(self,*args):
        return subprocess.check_output(['git',*args],cwd=self.root,stderr=subprocess.DEVNULL).decode().strip()

    def commit(self):
        self.git('add','.');self.git('commit','-qm','test: synthetic public source');return self.git('rev-parse','HEAD')

    def test_full_two_chains_with_four_real_historical_commits_and_changed_candidate_fingerprint(self):
        ev=real_chain(self.shas,fingerprint(self.root))
        result=predecessor(request(ev),ev,now=NOW)
        self.assertEqual(result['before']['release_sha'],self.shas[2])
        self.assertEqual(result['inputs']['release']['source_sha'],self.shas[3])
        self.assertNotEqual(fingerprint(ROOT),fingerprint(self.root))
        with self.assertRaises(Exception):release(ev['unit7']['inputs'],ev['unit7']['candidate'])
        # Today's fingerprint cannot be substituted into an otherwise rebound historical candidate.
        ev=real_chain(self.shas,fingerprint(ROOT))
        with self.assertRaises(Exception):predecessor(request(ev),ev,now=NOW)

    def test_unknown_source_and_extra_hcl_json_or_symlink_refuse(self):
        with self.assertRaises(Exception):
            with historical_source('f'*40):pass
        folder=self.root/'infra/terraform/foundation/qa'
        for name in ('extra.tf','extra.tf.json'):
            path=folder/name;path.write_text('{}');sha=self.commit()
            with self.subTest(name=name),self.assertRaises(Exception):
                with historical_source(sha):pass
            path.unlink();self.commit()
        original=(folder/'main.tf').read_bytes();(folder/'main.tf').unlink();(folder/'main.tf').symlink_to('access.tf')
        with self.assertRaises(Exception):
            with historical_source(self.commit()):pass
        (folder/'main.tf').unlink();(folder/'main.tf').write_bytes(original)

    def test_historical_configuration_and_lock_cannot_be_current_substitutes(self):
        report=evidence()['unit5']['saved_plan']
        with historical_source(self.shas[2]) as root:bind_report(report,root)
        for name in ('access.tf','.terraform.lock.hcl'):
            path=self.root/'infra/terraform/foundation/qa'/name
            with path.open('a') as output:output.write('\n# Different historical content\n')
            with historical_source(self.commit()) as root:
                with self.subTest(name=name),self.assertRaises(Exception):bind_report(report,root)

    def test_migration_directory_symlink_cannot_disappear_from_historical_fingerprint(self):
        folder=self.root/'packages/db/prisma/migrations'
        (folder/'20990102000000_alias').symlink_to(next(p for p in folder.iterdir() if p.is_dir()).name)
        with self.assertRaises(Exception):
            with historical_source(self.commit()):pass

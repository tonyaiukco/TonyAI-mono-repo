"""Binary provenance, private show and secret-free CLI rejection for Unit 5."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from qa_contract import sha256
from qa_foundation import QA_ROOT
from qa_oidc import inspect_plan
from qa_oidc_fixtures import request,evidence,plan,NOW


def binary(mutation=None):
    files={'tfconfig/m-/'+p.name:p.read_bytes() for p in QA_ROOT.glob('*.tf')}
    files.update({'.terraform.lock.hcl':(QA_ROOT/'.terraform.lock.hcl').read_bytes(),
                  'tfconfig/modules.json':json.dumps([{'Key':'','Dir':'.'}]),'tfplan':b'synthetic-not-a-real-plan'})
    if mutation=='config':files['tfconfig/m-/access.tf']=b'foreign'
    if mutation=='lock':files['.terraform.lock.hcl']=b'foreign'
    if mutation=='module':files['tfconfig/m-child/main.tf']=b'foreign'
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as archive:
        for name,value in files.items():archive.writestr(name,value)
    return stream.getvalue()


class SavedBinary(unittest.TestCase):
    def test_private_copy_sterile_show_and_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            saved=Path(directory)/'oidc.tfplan';saved.write_bytes(binary())
            def run(argv,**kw):
                self.assertEqual(argv[:3],[str(Path(sys.executable).resolve()),'show','-json'])
                self.assertNotEqual(Path(argv[3]),saved)
                self.assertEqual(Path(argv[3]).read_bytes(),binary())
                self.assertEqual(Path(argv[3]).stat().st_mode & 0o777,0o600)
                self.assertEqual(kw['env'],{'PATH':os.defpath,'HOME':str(Path(argv[3]).parent),'CHECKPOINT_DISABLE':'1'})
                self.assertTrue(kw['capture_output']);self.assertEqual(kw['cwd'],QA_ROOT)
                return SimpleNamespace(returncode=0,stdout=json.dumps(plan()))
            with patch('qa_oidc.clean_source') as clean:
                report=inspect_plan(request(),evidence(),saved,sys.executable,runner=run,now=NOW)
            self.assertEqual(clean.call_count,2)
            self.assertEqual(report['plan_sha256'],sha256(saved.read_bytes()))
            self.assertEqual(report['terraform_binary_sha256'],sha256(Path(sys.executable).read_bytes()))
            self.assertEqual(len(report['resources']),24)
            self.assertNotIn('prior_state',str(report))

    def test_config_lock_module_source_binary_tool_input_predecessor_tamper(self):
        for attack in ('config','lock','module','binary-swap','tool-swap','source-before','source-after','input','predecessor','nonzero','timeout','invalid-json'):
            with self.subTest(attack=attack),tempfile.TemporaryDirectory() as directory:
                saved=Path(directory)/'oidc.tfplan';saved.write_bytes(binary(attack))
                tool=Path(directory)/'terraform';tool.write_bytes(b'synthetic-tool')
                req,ev=request(),evidence()
                if attack=='input':req['after_inputs']['config']['release_sha']='d'*40
                if attack=='predecessor':ev['saved_plan']['plan_sha256']='f'*64
                def run(argv,**kw):
                    if attack=='binary-swap':saved.write_bytes(b'changed')
                    if attack=='tool-swap':tool.write_bytes(b'changed')
                    if attack=='timeout':raise subprocess.TimeoutExpired(argv,120)
                    return SimpleNamespace(returncode=1 if attack=='nonzero' else 0,
                                           stdout='SECRET_CANARY' if attack=='invalid-json' else json.dumps(plan()))
                side=[ValueError('dirty')] if attack=='source-before' else [None,ValueError('dirty')] if attack=='source-after' else None
                with patch('qa_oidc.clean_source',side_effect=side),self.assertRaises(Exception):
                    inspect_plan(req,ev,saved,str(tool),runner=run,now=NOW)

    def test_dirty_checkout_rejected_without_cloud_or_show(self):
        with tempfile.TemporaryDirectory() as directory:
            saved=Path(directory)/'oidc.tfplan';saved.write_bytes(binary())
            run = Mock()
            with self.assertRaises(Exception):
                inspect_plan(request(),evidence(),saved,sys.executable,runner=run,now=NOW)
            run.assert_not_called()

    def test_cli_refuses_caller_json_and_redacts_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'request.json';path.write_text(json.dumps({'secret':'SECRET_CANARY'}))
            result=subprocess.run([sys.executable,'infra/scripts/qa_oidc.py','--request',str(path),
                '--predecessor',str(path),'--ruleset-id','42','--saved-plan','/nonexistent','--terraform',sys.executable],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn('SECRET_CANARY',result.stdout+result.stderr)
            self.assertNotIn('Traceback',result.stderr)
            result=subprocess.run([sys.executable,'infra/scripts/qa_oidc.py','--plan-json',str(path)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)

    def test_saved_plan_symlink_swap_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            first,other,link=(Path(directory)/name for name in ('first.tfplan','other.tfplan','saved.tfplan'))
            first.write_bytes(binary());other.write_bytes(b'uninspected');link.symlink_to(first)
            def run(argv,**kwargs):
                link.unlink();link.symlink_to(other)
                return SimpleNamespace(returncode=0,stdout=json.dumps(plan()))
            with patch('qa_oidc.clean_source'),self.assertRaises(Exception):
                inspect_plan(request(),evidence(),link,sys.executable,runner=run,now=NOW)

    def test_tool_symlink_resolution_swap_refused_even_if_same_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);saved=root/'saved';saved.write_bytes(binary())
            first,second,link=(root/k for k in ('tool-a','tool-b','tool'))
            first.write_bytes(b'tool');second.write_bytes(b'tool');link.symlink_to(first)
            def run(argv,**kw):
                self.assertEqual(argv[0],str(first))
                link.unlink();link.symlink_to(second)
                return SimpleNamespace(returncode=0,stdout=json.dumps(plan()))
            with patch('qa_oidc.clean_source'),self.assertRaises(Exception):
                inspect_plan(request(),evidence(),saved,str(link),runner=run,now=NOW)

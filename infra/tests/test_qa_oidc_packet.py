"""Even complete synthetic material produces only a blocked owner-review draft."""
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import json
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from qa_oidc import inspect_plan
from qa_oidc_packet import prepare
from qa_oidc_fixtures import request,evidence,plan,receipt,github_receipt,NOW,PLAN
from test_qa_oidc_saved import binary


class Packet(unittest.TestCase):
    def test_complete_packet_paths_hashes_and_permanent_block(self):
        with tempfile.TemporaryDirectory() as directory:
            saved=Path(directory)/'saved.tfplan';saved.write_bytes(binary())
            alias=Path(directory)/'alias.tfplan';alias.symlink_to(saved)
            args=SimpleNamespace(request=directory+'/request.json',predecessor=directory+'/predecessor.json',
                                 saved_plan=str(alias),terraform=sys.executable,ruleset_id=42)
            with patch('qa_oidc.clean_source'):
                report=inspect_plan(request(),evidence(),alias,sys.executable,
                    runner=lambda *a,**kw:SimpleNamespace(returncode=0,stdout=json.dumps(plan())),now=NOW)
            observations=dict(plan_completed_at=PLAN,receipt=receipt(plan_hash=report['plan_sha256']),
                              github_receipt=github_receipt(plan_hash=report['plan_sha256']))
            packet=prepare(request(),evidence(),report,args,observations,now=NOW)
            self.assertEqual(packet['status'],'BLOCKED_DRAFT')
            for key in ('authorization','live_acceptance','authenticated_azure_provenance','authenticated_github_provenance','effective_permissions_proven'):
                self.assertFalse(packet[key])
            command=packet['command_templates']['saved_plan_apply']
            self.assertIn(str(saved),command);self.assertNotIn(str(alias),command)
            self.assertIn(str(Path(sys.executable).resolve()),command)
            self.assertEqual(len(packet['binding']['resources']),24)
            self.assertEqual(len(packet['binding']['additions']),7)
            text=json.dumps(packet)
            self.assertNotIn('prior_state',text);self.assertNotIn('tfconfig',text)
            self.assertIn('consumes approval',text);self.assertIn('independent human',text)
            self.assertIn('GITHUB_TOKEN',text);self.assertIn('destruction',text)
            for key in ('request_sha256','predecessor_sha256','source_sha','before_inputs_sha256','after_inputs_sha256'):
                bad={**report,key:'wrong'}
                with self.subTest(key=key),self.assertRaises(Exception):prepare(request(),evidence(),bad,args,now=NOW)

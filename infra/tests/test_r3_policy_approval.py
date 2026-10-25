"""Independent authorization negatives with coherent synthetic packet bindings."""
import copy
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from test_r3_policy_target import HOST_LINE, IMDS
import r3_policy_packet as packet
import r3_policy_receive as receiver
from r3_noble_common import digest, encoded


class ApprovalGuards(unittest.TestCase):
    def check(self, proposal_change=None, fresh_change=None, approval_change=None,
              head='a' * 40, expected_hash=None, agent_socket=True, accepted=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            bundle = root / 'packet'
            bundle.mkdir()
            files = packet.sources()
            imds = {**IMDS, 'location': 'SwedenCentral'}
            target = {'imds': imds, 'connection': {'host': '192.0.2.1', 'user': 'ubuntu'},
                'control_plane': {'tenant': 'synthetic', 'subscription': imds['subscriptionId'],
                    'vm_id': imds['resourceId'], 'vm_uuid': imds['vmId'], 'location': 'swedencentral',
                    'image': {**{k: imds[k] for k in ('publisher', 'offer', 'sku', 'version')},
                              'exactVersion': imds['version']}, 'disks': ['synthetic'],
                    'public_ip': '192.0.2.1', 'private_ip': '10.0.0.1', 'network': 'synthetic'}}
            public = b'ssh-ed25519 YWJj\n'
            custody = {'recipient': public.decode(), 'recipient_sha256': digest(public)}
            for key, value in [('known_hosts', HOST_LINE), ('age', b'never executed'), ('ssh_public_key', public)]:
                path = root / key
                path.write_bytes(value)
                custody.update({key: str(path), key + '_sha256': digest(value)})
            proposal = {'format': 1, 'purpose': receiver.B_PURPOSE,
                'source': {'base_sha': 'a' * 40, 'published_sha': 'a' * 40,
                           'files': files, 'sha256': digest(encoded(files))},
                'target': target, 'custody': custody, 'execution_authorized': False, 'historical_B_rebound': False}
            if proposal_change:
                proposal_change(proposal)
            # Rebind every outer digest and the fresh target to the altered
            # proposal. An unrelated stale payload/hash must not hide the guard.
            fresh = {'observed_at': datetime.now(timezone.utc).isoformat(),
                     'target': copy.deepcopy(proposal['target']),
                     'host_key_fingerprint': receiver.known_host(HOST_LINE, '192.0.2.1')}
            if fresh_change:
                fresh_change(fresh)
            fresh_path = root / 'fresh.json'
            fresh_path.write_bytes(encoded(fresh))
            proposal_bytes = encoded(proposal)
            guest = packet.payload(proposal)
            (bundle / 'proposal.json').write_bytes(proposal_bytes)
            (bundle / 'guest.py').write_bytes(guest)
            (bundle / 'packet.json').write_bytes(encoded({'proposal_sha256': digest(proposal_bytes),
                'guest_sha256': digest(guest), 'state': 'PREPARED_UNAPPROVED_UNEXECUTED'}))
            approval = {'action': 'ONE_POLICY_EVIDENCE_COLLECTION', 'attempts': 1,
                'proposal_sha256': digest(proposal_bytes), 'packet_path': str(bundle),
                'owner_authorization_reference': 'synthetic only',
                'fresh_control_plane_readback': str(fresh_path), 'fresh_control_plane_readback_sha256': digest(encoded(fresh))}
            if approval_change:
                approval_change(approval)
            data = encoded(approval)
            real_stat = os.stat
            def agent_stat(path, *args, **kwargs):
                return SimpleNamespace(st_mode=stat.S_IFSOCK if agent_socket else stat.S_IFREG) if path == '/synthetic-agent' else real_stat(path, *args, **kwargs)
            with patch.object(receiver, 'verified_head', return_value=head), \
                 patch.dict(os.environ, {'SSH_AUTH_SOCK': '/synthetic-agent'}), \
                 patch.object(receiver.os, 'stat', side_effect=agent_stat), \
                 patch.object(receiver.subprocess, 'Popen', side_effect=AssertionError('execution forbidden')):
                if accepted:
                    self.assertEqual(receiver.approved(bundle, data, expected_hash or digest(data)), (proposal, guest))
                else:
                    with self.assertRaises(ValueError):
                        receiver.approved(bundle, data, expected_hash or digest(data))

    def test_coherent_positive_fixture(self):
        self.check(accepted=True)

    def test_exact_published_head_and_approval_digest(self):
        self.check(head='b' * 40)
        self.check(expected_hash='0' * 64)

    def test_attempt_count_owner_reference_bound_and_agent_socket(self):
        self.check(approval_change=lambda a: a.update(attempts=2))
        self.check(approval_change=lambda a: a.update(owner_authorization_reference='x' * 2001))
        self.check(agent_socket=False)

    def test_source_files_and_map_digest_are_independent(self):
        def wrong_file(p):
            p['source']['files'][next(iter(p['source']['files']))] = '0' * 64
            p['source']['sha256'] = digest(encoded(p['source']['files']))
        self.check(proposal_change=wrong_file)
        self.check(proposal_change=lambda p: p['source'].update(sha256='0' * 64))

    def test_each_custody_file_digest_and_recipient_digest(self):
        for key in ('known_hosts', 'age', 'ssh_public_key', 'recipient'):
            with self.subTest(key=key):
                self.check(proposal_change=lambda p: p['custody'].update({key + '_sha256': '0' * 64}))

    def test_readback_digest_schema_and_target(self):
        self.check(approval_change=lambda a: a.update(fresh_control_plane_readback_sha256='0' * 64))
        self.check(fresh_change=lambda f: f.update(extra='unreviewed'))
        self.check(fresh_change=lambda f: f['target']['control_plane'].update(tenant='foreign'))

    def test_both_readback_age_bounds(self):
        for seconds in (-1200, 1200):
            with self.subTest(seconds=seconds):
                self.check(fresh_change=lambda f: f.update(
                    observed_at=(datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()))

    def test_control_plane_schema_presence_and_each_identity(self):
        self.check(proposal_change=lambda p: p['target']['control_plane'].update(extra='unreviewed'))
        self.check(proposal_change=lambda p: p['target']['control_plane'].update(tenant=''))
        for key in ('vm_id', 'vm_uuid', 'subscription', 'location', 'public_ip'):
            with self.subTest(key=key):
                self.check(proposal_change=lambda p: p['target']['control_plane'].update({key: 'foreign'}))

    def test_each_location_spelling_is_pinned_exactly(self):
        # IMDS reports 'SwedenCentral', ARM 'swedencentral'; neither side
        # accepts the other spelling, another casing, padding or a lookalike.
        for value in ('swedencentral', 'SWEDENCENTRAL', 'SwedenCentral ', '\u017fwedenCentral', '\uff33wedenCentral', 'westeurope'):
            with self.subTest(imds=value):
                self.check(proposal_change=lambda p: p['target']['imds'].update(location=value))
        for value in ('SwedenCentral', 'SWEDENCENTRAL', 'swedencentral ', '\u017fwedencentral', '\uff53wedencentral', 'westeurope'):
            with self.subTest(control=value):
                self.check(proposal_change=lambda p: p['target']['control_plane'].update(location=value))

    def test_image_schema_and_each_imds_correspondence(self):
        self.check(proposal_change=lambda p: p['target']['control_plane']['image'].update(extra='unreviewed'))
        for key in ('publisher', 'offer', 'sku', 'exactVersion'):
            with self.subTest(key=key):
                self.check(proposal_change=lambda p: p['target']['control_plane']['image'].update({key: 'foreign'}))


if __name__ == '__main__':
    unittest.main()

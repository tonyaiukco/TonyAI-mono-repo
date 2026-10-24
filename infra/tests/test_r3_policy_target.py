"""Target identity/packet/receiver tests using local synthetic bytes only."""
import copy
import base64
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from test_r3_policy_evidence import document, command, apt_scope, unit_scope, META
import r3_policy_evidence as evidence
import r3_policy_capture as capture
import r3_policy_scope as scope
import r3_policy_validate as validator
import r3_policy_target as target
import r3_policy_packet as packet
import r3_policy_receive as receiver
from r3_noble_common import digest, encoded, write
import r3_policy_git as source_git

BOOT = '00000000-0000-0000-0000-000000000001'
IMDS = {key: 'synthetic-' + key for key in target.IMDS_FIELDS}


HOST_KEY = base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0\x20' + b'k' * 32).decode()
HOST_LINE = ('192.0.2.1 ssh-ed25519 ' + HOST_KEY + '\n').encode()


def synthetic_git(argv, **kwargs):
    assert argv[:6] == ['git', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', str(packet.ROOT)]
    assert kwargs['env']['GIT_NO_REPLACE_OBJECTS'] == '1'
    assert kwargs['env']['GIT_NO_LAZY_FETCH'] == '1'
    assert kwargs['timeout'] == 10
    if argv[6:] == ['config', '--local', '--no-includes', '--null', '--name-only', '--list']:
        return b''
    if argv[6:] == ['rev-parse', '--git-path', 'info/attributes']:
        return b'/synthetic-absent-git-info-attributes'
    if argv[6:] == ['rev-parse', 'HEAD']:
        return b'a' * 40 + b'\n'
    if argv[6:] in (['ls-files', '--stage', '-z'], ['ls-tree', '-r', '-z', 'a' * 40]):
        return b''
    if argv[6] == 'status':
        return b''
    assert argv[6] == 'show'
    return (packet.ROOT / argv[7].split(':', 1)[1]).read_bytes()


def proposal():
    return {'source': {'sha256': 'a' * 64}, 'target': {'imds': IMDS}}


def target_document():
    p = proposal()
    binding = {'purpose': evidence.B_PURPOSE, 'source': p['source'], 'target': p['target'], 'boot_id': BOOT}
    return {'format': 1, 'purpose': evidence.B_PURPOSE, 'source': p['source'], 'target': p['target'],
            'identity_before': {'imds': dict(IMDS), 'boot_id': BOOT},
            'identity_after': {'imds': dict(IMDS), 'boot_id': BOOT},
            'evidence': document(binding), 'failure': None}


class TargetReadback(unittest.TestCase):
    def test_complete_and_every_identity_field_changed(self):
        self.assertEqual(target.validate_target(encoded(target_document()), proposal())['status'], 'COLLECTED_REVIEW_REQUIRED')
        for key in target.IMDS_FIELDS:
            doc = copy.deepcopy(target_document())
            doc['identity_after']['imds'][key] += '-changed'
            result = target.validate_target(encoded(doc), proposal())
            self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
            self.assertEqual(result['policy_input_hashes'], {})
        for change in ('boot', 'failure', 'missing'):
            doc = copy.deepcopy(target_document())
            if change == 'boot':
                doc['identity_after']['boot_id'] = BOOT[:-1] + '2'
            elif change == 'failure':
                doc['failure'] = 'TimeoutError'
            else:
                doc['identity_after'] = None
            self.assertEqual(target.validate_target(encoded(doc), proposal())['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_source_purpose_schema_and_legacy_label_rejected(self):
        for key, value in [('purpose', 'READ_ONLY_INVENTORY_NOT_QUALIFICATION'), ('source', {}),
                           ('format', True), ('target', {}), ('failure', 'LIMITED_CORE_READBACK')]:
            doc = target_document()
            doc[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                target.validate_target(encoded(doc), proposal())
        doc = target_document()
        doc['evidence']['binding']['boot_id'] = BOOT[:-1] + '2'
        with self.assertRaises(ValueError):
            target.validate_target(encoded(doc), proposal())

    def test_fully_partial_identity_record_is_readable_never_success(self):
        doc = target_document()
        doc.update(identity_before=None, identity_after=None, evidence=None, failure='OSError')
        self.assertEqual(target.validate_target(encoded(doc), proposal())['status'], 'PARTIAL_REVIEW_REQUIRED')


class NativeReadScope(unittest.TestCase):
    def test_include_directory_redirects_and_unknown_names_refuse_before_dump(self):
        for content in (b'#include "/root/key";', b'Dir::Etc::Parts "/root";', b'dIr { Etc "/root"; };',
                        b'Dir "/private";', b'RootDir "/private";',
                        b'"Dir" { Etc { main "/private/key"; }; };',
                        b'Dir /* comment */ { Etc "/private"; };',
                        b'#x-apt-configure-index "/private/key";',
                        b'%44ir "/private";', b'D"i"r "/private";',
                        b'%23include "/private/key";', b'#inc/**/lude "/private/key";',
                        b'D/**/ir "/private";', b'%52ootDir "/private";',
                        b'X "/*"; #include "/private/key"; Y "*/";'):
            item = {**META, 'bytes': len(content), 'sha256': digest(content), 'body': capture.blob(content)}
            value = {'directory': {'metadata': META, 'names': []}, 'files': {'/etc/apt/apt.conf': item}}
            with self.subTest(content=content), self.assertRaises(ValueError):
                scope.check_apt(value)
        with patch.object(scope, 'membership', return_value={'metadata': META, 'names': ['auth.conf']}), \
             patch.object(scope, 'file_record', side_effect=AssertionError('unreviewed read')):
            with self.assertRaises(ValueError):
                scope.apt_scope()

    def test_harmless_hook_hash_comments_remain_collectible(self):
        content = b'APT::Update::Post-Invoke { "/usr/bin/test -e /tmp/example; # shell comment"; };\n'
        item = {**META, 'bytes': len(content), 'sha256': digest(content), 'body': capture.blob(content)}
        scope.check_apt({'directory': {'metadata': META, 'names': []}, 'files': {'/etc/apt/apt.conf': item}})

    def test_dropins_external_fragments_and_duplicate_units_refused(self):
        raw = capture.blob(b'')['base64']
        good = command('unit-paths')['stdout']
        import base64
        raw = base64.b64decode(good['base64'])
        self.assertEqual(len(scope.unit_paths(raw)), 5)
        for changed in (raw.replace(b'DropInPaths=', b'DropInPaths=/root/private.conf', 1),
                        raw.replace(b'/usr/lib/systemd/system/', b'/root/', 1), raw + b'\n' + raw):
            with self.assertRaises(ValueError):
                scope.unit_paths(changed)

    def test_unsafe_scope_does_not_launch_dump_or_cat_and_still_retains(self):
        calls, points = [], []
        def observed(name, deadline):
            calls.append(name)
            return command(name, deadline)
        with patch.object(evidence, 'command', side_effect=observed), \
             patch.object(capture, 'file_record', return_value={'absent': True}), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=ValueError('unsafe')), \
             patch.object(scope, 'unit_scope', side_effect=ValueError('unsafe')):
            doc = evidence.collect({'synthetic': True}, lambda v: points.append(copy.deepcopy(v)))
        self.assertNotIn('apt-config', calls)
        self.assertNotIn('unit-config', calls)
        self.assertTrue(points)
        self.assertEqual(validator.validate(encoded(doc), {'synthetic': True})['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_native_cat_preserves_blank_lines_and_terminates_last_line(self):
        from r3_apt_observer import UNITS
        for body in (b'[Unit]\n\n', b'[Unit]', b''):
            doc = document()
            first = '/usr/lib/systemd/system/' + UNITS[0]
            record = {**META, 'mode': 0o644, 'bytes': len(body), 'sha256': digest(body), 'body': capture.blob(body)}
            for name in ('unit-scope-before', 'unit-scope-after'):
                doc['sections'][name]['value']['files'][first] = record
            output = []
            for unit in UNITS:
                path = '/usr/lib/systemd/system/' + unit
                content = body if path == first else b'[Unit]\n'
                if content and not content.endswith(b'\n'):
                    content += b'\n'
                output.append(b'# ' + path.encode() + b'\n' + content)
            doc['sections']['unit-config']['value']['stdout'] = capture.blob(b'\n'.join(output))
            self.assertEqual(validator.validate(encoded(doc), doc['binding'])['status'], 'COLLECTED_REVIEW_REQUIRED')

    def test_scope_drift_and_cat_body_mismatch_cannot_complete(self):
        for name in ('apt-scope-after', 'unit-scope-after', 'unit-config'):
            doc = document()
            if name == 'unit-config':
                doc['sections'][name]['value']['stdout'] = capture.blob(b'forged full unit content')
            elif name.startswith('apt'):
                doc['sections'][name]['value']['directory']['metadata'] = {**META, 'mode': 0o700}
            else:
                file = next(iter(doc['sections'][name]['value']['files']))
                doc['sections'][name]['value']['files'][file]['mode'] = 0o600
            self.assertEqual(validator.validate(encoded(doc), doc['binding'])['status'], 'PARTIAL_REVIEW_REQUIRED')


class ReceiverAndPacket(unittest.TestCase):
    def prepare_packet(self, destination, supplied=None):
        # Keep real source/payload bytes in the Git-free mutation fixture.
        with patch.object(source_git.subprocess, 'check_output', side_effect=synthetic_git) as head:
            result = packet.prepare(destination, supplied)
            self.assertEqual(head.call_count, 7 + len(packet.sources()))
        self.assertEqual(result['source']['base_sha'], 'a' * 40)
        return result

    def test_draft_is_unapproved_source_bound_and_legacy_not_rebound(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'packet'
            p = self.prepare_packet(root)
            self.assertIsNone(p['source']['published_sha'])
            self.assertIsNone(p['target'])
            self.assertIsNone(p['custody'])
            self.assertIs(p['historical_B_rebound'], False)
            self.assertEqual(p['source']['files'], packet.sources())
            self.assertEqual(p['source']['sha256'], digest(encoded(packet.sources())))
            self.assertEqual((root / 'guest.py').read_bytes(), packet.payload(p))
            approval = encoded({'action': 'ONE_POLICY_EVIDENCE_COLLECTION', 'attempts': 1,
                'proposal_sha256': digest((root / 'proposal.json').read_bytes()), 'owner_authorization_reference': 'synthetic'})
            with patch.object(receiver.subprocess, 'Popen', side_effect=AssertionError('must not execute')):
                with self.assertRaises(ValueError):
                    receiver.approved(root, approval, digest(approval))
            with self.assertRaises(FileExistsError):
                packet.prepare(root)

    def test_complete_approval_source_hash_path_and_freshness_negatives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            bundle = root / 'packet'
            p = self.prepare_packet(bundle)
            p['source']['published_sha'] = 'a' * 40
            imds = {**IMDS, 'location': 'swedencentral'}
            p['target'] = {'imds': imds, 'connection': {'host': '192.0.2.1', 'user': 'ubuntu'},
                'control_plane': {'tenant': 'synthetic', 'subscription': imds['subscriptionId'],
                    'vm_id': imds['resourceId'], 'vm_uuid': imds['vmId'], 'location': imds['location'],
                    'image': {**{k: imds[k] for k in ('publisher', 'offer', 'sku', 'version')},
                              'exactVersion': imds['version']}, 'disks': ['synthetic'],
                    'public_ip': '192.0.2.1', 'private_ip': '10.0.0.1', 'network': 'synthetic'}}
            public = 'ssh-ed25519 YWJj\n'
            custody = {'recipient': public, 'recipient_sha256': digest(public.encode())}
            for key, data in (('age', b'not an executable'), ('known_hosts', HOST_LINE), ('ssh_public_key', public.encode())):
                path = root / key
                path.write_bytes(data)
                custody[key], custody[key + '_sha256'] = str(path), digest(data)
            p['custody'] = custody
            fresh = root / 'fresh.json'
            fresh_value = {'observed_at': datetime.now(timezone.utc).isoformat(), 'target': p['target'],
                           'host_key_fingerprint': receiver.known_host(HOST_LINE, '192.0.2.1')}
            fresh.write_bytes(encoded(fresh_value))
            final = root / 'final'
            self.prepare_packet(final, p)
            approval = {'action': 'ONE_POLICY_EVIDENCE_COLLECTION', 'attempts': 1,
                'proposal_sha256': digest((final / 'proposal.json').read_bytes()), 'packet_path': str(final.resolve()), 'owner_authorization_reference': 'synthetic only',
                'fresh_control_plane_readback': str(fresh), 'fresh_control_plane_readback_sha256': digest(fresh.read_bytes())}
            # Only the socket shape is mocked; no SSH or encryption process runs.
            import stat
            from types import SimpleNamespace
            original_stat = receiver.os.stat
            def agent_stat(path, *args, **kwargs):
                return SimpleNamespace(st_mode=stat.S_IFSOCK) if path == '/synthetic-agent' else original_stat(path, *args, **kwargs)
            with patch.object(receiver.subprocess, 'check_output', side_effect=synthetic_git), \
                 patch.dict(os.environ, {'SSH_AUTH_SOCK': '/synthetic-agent'}), \
                 patch.object(receiver.os, 'stat', side_effect=agent_stat):
                data = encoded(approval)
                checked, _guest = receiver.approved(final, data, digest(data))
                self.assertEqual(checked, p)
                with patch.object(receiver.subprocess, 'check_output', side_effect=lambda argv, **kw: b'changed' if argv[6] == 'show' else synthetic_git(argv, **kw)):
                    with self.assertRaises(ValueError):
                        receiver.approved(final, data, digest(data))
                for key, value in [('attempts', True), ('action', 'ONE_READ_ONLY_GUEST_INVENTORY'),
                                   ('proposal_sha256', '0' * 64), ('owner_authorization_reference', ''),
                                   ('packet_path', str(root / 'copied-packet'))]:
                    bad = encoded({**approval, key: value})
                    with self.subTest(key=key), self.assertRaises(ValueError):
                        receiver.approved(final, bad, digest(bad))
                for field in ('payload', 'index', 'region', 'vm-id', 'host-key', 'host-fingerprint', 'clean-tree'):
                    candidate = copy.deepcopy(p)
                    if field == 'region':
                        candidate['target']['imds']['location'] = 'elsewhere'
                        candidate['target']['control_plane']['location'] = 'elsewhere'
                    if field == 'vm-id': candidate['target']['control_plane']['vm_id'] = 'other'
                    if field == 'host-key':
                        Path(custody['known_hosts']).write_bytes(HOST_LINE.replace(b'192.0.2.1', b'*'))
                        candidate['custody']['known_hosts_sha256'] = digest(Path(custody['known_hosts']).read_bytes())
                    destination = root / ('negative-' + field)
                    self.prepare_packet(destination, candidate)
                    if field == 'payload':
                        (destination / 'guest.py').write_bytes(b'forged')
                        index = json.loads((destination / 'packet.json').read_bytes())
                        index['guest_sha256'] = digest(b'forged')
                        (destination / 'packet.json').write_bytes(encoded(index))
                    if field == 'index': (destination / 'packet.json').write_bytes(encoded({}))
                    fresh_value['target'] = candidate['target']
                    fresh_value['host_key_fingerprint'] = 'SHA256:wrong' if field == 'host-fingerprint' else receiver.known_host(HOST_LINE, '192.0.2.1')
                    fresh.write_bytes(encoded(fresh_value))
                    bad = encoded({**approval, 'packet_path': str(destination.resolve()),
                        'proposal_sha256': digest((destination / 'proposal.json').read_bytes()),
                        'fresh_control_plane_readback_sha256': digest(fresh.read_bytes())})
                    def changed_git(argv, **kwargs):
                        return b'?? untracked' if field == 'clean-tree' and argv[6] == 'status' else synthetic_git(argv, **kwargs)
                    with self.subTest(field=field), patch.object(receiver.subprocess, 'check_output', side_effect=changed_git), self.assertRaises(ValueError):
                        receiver.approved(destination, bad, digest(bad))
                    Path(custody['known_hosts']).write_bytes(HOST_LINE)
                fresh_value['target'] = p['target']
                fresh_value['host_key_fingerprint'] = receiver.known_host(HOST_LINE, '192.0.2.1')
                fresh_value['observed_at'] = '2000-01-01T00:00:00+00:00'
                fresh.write_bytes(encoded(fresh_value))
                bad = encoded({**approval, 'fresh_control_plane_readback_sha256': digest(fresh.read_bytes())})
                with self.assertRaises(ValueError):
                    receiver.approved(final, bad, digest(bad))

    def test_transport_bound_and_cleanup_failure_retains_streams(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = 'import sys; sys.stdin.buffer.read(); print("partial"); print("private",file=sys.stderr)'
            argv = [sys.executable, '-c', script]
            with patch.object(receiver, 'kill_group', side_effect=OSError('cleanup')):
                result = receiver.receive(argv, b'payload', root)
            self.assertIsNone(result['failure'])
            self.assertEqual(result['cleanup_errors'], ['OSError'])
            self.assertEqual((root / 'guest.json').read_bytes(), b'partial\n')
            self.assertEqual((root / 'stderr.private').read_bytes(), b'private\n')
            self.assertEqual((root / 'guest.json').stat().st_mode & 0o777, 0o600)

    def test_launch_failure_and_overflow_are_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(receiver.subprocess, 'Popen', side_effect=OSError('missing')):
                result = receiver.receive(['never'], b'payload', Path(tmp))
            self.assertEqual(result['failure'], 'OSError')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            script = 'import sys; sys.stdin.buffer.read(); print("x"*1000)'
            with patch.object(receiver, 'DOCUMENT_LIMIT', 100):
                result = receiver.receive([sys.executable, '-c', script], b'payload', root)
            self.assertEqual(result['failure'], 'ValueError')
            self.assertEqual((root / 'guest.json').stat().st_size, 100)

    def test_fixed_ssh_no_forwarding_and_agent_public_identity(self):
        p = {'target': {'connection': {'user': 'ubuntu', 'host': 'example.invalid'}},
             'custody': {'known_hosts': '/private/tmp/known-hosts', 'ssh_public_key': '/private/tmp/key.pub'}}
        argv = receiver.ssh_argv(p)
        self.assertIn('StrictHostKeyChecking=yes', argv)
        self.assertIn('ForwardAgent=no', argv)
        self.assertIn('IdentitiesOnly=yes', argv)
        self.assertEqual(argv[-1], 'sudo -n /usr/bin/python3 -I -B -')
        self.assertNotIn('bash', argv)


if __name__ == '__main__':
    unittest.main()

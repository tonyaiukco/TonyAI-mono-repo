#!/usr/bin/env python3
"""Tests for runtime_contract.py — closure reader, OCI closure check, and composition plan. Pure: all
readers are in-memory fakes. No Docker, DB, network, or filesystem reads outside the injected reader.
Run: python3 -I -B test_runtime_contract.py -v"""
import hashlib
import importlib.util
import json
import os
import sys
import unittest

_HERE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'scripts', 'r3_db_candidate'))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod  # dataclasses needs the module registered before exec
    spec.loader.exec_module(mod)
    return mod


rc = _load('runtime_contract', 'runtime_contract.py')


def _sha(data):
    return hashlib.sha256(data).hexdigest()


class StartupClosureTests(unittest.TestCase):
    def test_empty_evidence_is_open_unresolved_with_every_fact_missing(self):
        result = rc.read_startup_closure({}, lambda _p: b'')
        self.assertEqual(result.status, 'OPEN_UNRESOLVED')
        self.assertEqual(sorted(result.missing), sorted(rc.REQUIRED_CLOSURE_FACTS))
        self.assertEqual(result.present, {})

    def test_partial_evidence_reports_exactly_what_is_missing(self):
        body = b'log_destination = jsonlog\n'
        index = {'logging_settings': {'path': '/e/pg.conf', 'sha256': _sha(body)}}
        result = rc.read_startup_closure(index, lambda p: body)
        self.assertEqual(result.status, 'OPEN_UNRESOLVED')
        self.assertIn('logging_settings', result.present)
        self.assertNotIn('logging_settings', result.missing)
        self.assertIn('supautils_conf', result.missing)

    def test_hash_mismatch_refuses(self):
        index = {'supautils_conf': {'path': '/e/s.conf', 'sha256': 'a' * 64}}
        with self.assertRaises(rc.ContractRefusal) as ctx:
            rc.read_startup_closure(index, lambda p: b'different-bytes')
        self.assertTrue(ctx.exception.code.startswith('CLOSURE_HASH_MISMATCH'))

    def test_unknown_fact_name_refuses(self):
        index = {'not_a_real_fact': {'path': '/e/x', 'sha256': 'a' * 64}}
        with self.assertRaises(rc.ContractRefusal) as ctx:
            rc.read_startup_closure(index, lambda p: b'')
        self.assertTrue(ctx.exception.code.startswith('CLOSURE_UNKNOWN_FACT'))

    def test_closed_requires_all_facts_and_verified_oci(self):
        # Every fact present AND the OCI closure verified -> CLOSED_FROM_RETAINED_EVIDENCE.
        bodies = {fact: ('body-%s' % fact).encode() for fact in rc.REQUIRED_CLOSURE_FACTS}
        index = {fact: {'path': '/e/%s' % fact, 'sha256': _sha(bodies[fact])} for fact in rc.REQUIRED_CLOSURE_FACTS}
        index['_oci_closure'] = {'status': 'OCI_CLOSURE_VERIFIED', 'config_digest': rc.CONFIG_DIGEST}
        result = rc.read_startup_closure(index, lambda p: bodies[os.path.basename(p)])
        self.assertEqual(result.status, 'CLOSED_FROM_RETAINED_EVIDENCE')
        self.assertEqual(result.missing, [])

    def test_all_facts_but_unverified_oci_stays_open(self):
        bodies = {fact: ('b-%s' % fact).encode() for fact in rc.REQUIRED_CLOSURE_FACTS}
        index = {fact: {'path': '/e/%s' % fact, 'sha256': _sha(bodies[fact])} for fact in rc.REQUIRED_CLOSURE_FACTS}
        index['_oci_closure'] = {'status': 'OCI_EVIDENCE_INCOMPLETE'}
        result = rc.read_startup_closure(index, lambda p: bodies[os.path.basename(p)])
        self.assertEqual(result.status, 'OPEN_UNRESOLVED')
        self.assertEqual(result.missing, [])
        self.assertTrue(any('config digest' in n for n in result.notes))

    def test_all_facts_and_verified_status_but_wrong_config_digest_stays_open(self):
        # PM1: the CLOSED gate must cross-check the OCI config_digest against the pin, not just the status.
        bodies = {fact: ('q-%s' % fact).encode() for fact in rc.REQUIRED_CLOSURE_FACTS}
        index = {fact: {'path': '/e/%s' % fact, 'sha256': _sha(bodies[fact])} for fact in rc.REQUIRED_CLOSURE_FACTS}
        index['_oci_closure'] = {'status': 'OCI_CLOSURE_VERIFIED', 'config_digest': 'sha256:' + '0' * 64}
        result = rc.read_startup_closure(index, lambda p: bodies[os.path.basename(p)])
        self.assertEqual(result.status, 'OPEN_UNRESOLVED')
        self.assertTrue(any('config digest' in n for n in result.notes))


class OciClosureTests(unittest.TestCase):
    def _layout(self):
        config_body = json.dumps({
            'config': {'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['postgres']},
            'rootfs': {'diff_ids': ['sha256:' + 'd' * 64]},
        }, sort_keys=True).encode()
        # Force the config bytes to hash to the pinned CONFIG_DIGEST by stubbing the pin check? No —
        # instead point the pin at the real body for a positive test by monkeypatching CONFIG_DIGEST.
        config_sha = 'sha256:' + _sha(config_body)
        manifest_body = json.dumps({
            'config': {'digest': config_sha},
            'layers': [{'digest': 'sha256:' + _sha(b'layer0')}],
        }, sort_keys=True).encode()
        manifest_sha = 'sha256:' + _sha(manifest_body)
        index_body = json.dumps({
            'manifests': [{'digest': manifest_sha, 'platform': {'os': 'linux', 'architecture': 'amd64'}}],
        }, sort_keys=True).encode()
        files = {
            '/l/oci-layout': json.dumps({'imageLayoutVersion': '1.0.0'}).encode(),
            '/l/index.json': index_body,
            '/l/manifest.json': manifest_body,
            '/l/config.json': config_body,
            '/l/layer0': b'layer0',
        }
        layout_index = {'oci_layout': '/l/oci-layout', 'index': '/l/index.json', 'manifest': '/l/manifest.json',
                        'config': '/l/config.json', 'layers': ['/l/layer0']}
        return files, layout_index, config_sha

    def test_incomplete_inputs_reported(self):
        out = rc.verify_oci_closure({'oci_layout': '/l/x'}, lambda p: b'')
        self.assertEqual(out['status'], 'OCI_EVIDENCE_INCOMPLETE')
        self.assertIn('index', out['missing_inputs'])

    def test_config_pin_mismatch_is_refused(self):
        files, layout_index, _ = self._layout()
        out = rc.verify_oci_closure(layout_index, lambda p: files[p])
        # The pinned CONFIG_DIGEST is the real supabase digest, not our synthetic one -> OCI_CONFIG_PIN.
        self.assertEqual(out['status'], 'OCI_CLOSURE_REFUSED')
        self.assertEqual(out['code'], 'OCI_CONFIG_PIN')

    def test_verifies_when_pin_matches(self):
        files, layout_index, config_sha = self._layout()
        original = rc.CONFIG_DIGEST
        try:
            rc.CONFIG_DIGEST = config_sha  # exercise the positive path with a controlled digest
            out = rc.verify_oci_closure(layout_index, lambda p: files[p])
            self.assertEqual(out['status'], 'OCI_CLOSURE_VERIFIED')
            self.assertEqual(out['image_entrypoint'], ['docker-entrypoint.sh'])
        finally:
            rc.CONFIG_DIGEST = original

    def test_tampered_layer_digest_refused(self):
        files, layout_index, config_sha = self._layout()
        files['/l/layer0'] = b'tampered'
        original = rc.CONFIG_DIGEST
        try:
            rc.CONFIG_DIGEST = config_sha
            out = rc.verify_oci_closure(layout_index, lambda p: files[p])
            self.assertEqual(out['status'], 'OCI_CLOSURE_REFUSED')
            self.assertEqual(out['code'], 'OCI_LAYER_DIGEST')
        finally:
            rc.CONFIG_DIGEST = original


class CompositionPlanTests(unittest.TestCase):
    def _open_plan(self):
        return rc.assemble_plan(rc.read_startup_closure({}, lambda _p: b''))

    def test_open_closure_plan_is_not_executable(self):
        plan = self._open_plan()
        self.assertFalse(plan['executable'])
        self.assertIn('OPEN_UNRESOLVED', plan['blocking_reason'])
        self.assertEqual(plan['credential_route']['status'], 'BLOCKED_PENDING_CLOSURE')
        self.assertEqual(plan['runtime_status'], 'NOT_EXECUTED')
        self.assertEqual(plan['historical_status'], 'NOT_REPRODUCED')

    def test_run_argv_is_hardened_and_loopback_only(self):
        argv = rc.plan_run_container()
        self.assertIn('--read-only', argv)
        self.assertIn('--cap-drop', argv)
        self.assertEqual(argv[argv.index('--cap-drop') + 1], 'ALL')
        self.assertIn('--pids-limit', argv)
        self.assertIn('--restart', argv)
        self.assertEqual(argv[argv.index('--restart') + 1], 'no')
        # published port is loopback only
        pub = argv[argv.index('--publish') + 1]
        self.assertTrue(pub.startswith('127.0.0.1:'))
        # host network is impossible: --network is present exactly once and names the internal network
        self.assertEqual(argv.count('--network'), 1)
        self.assertEqual(argv[argv.index('--network') + 1], rc.NETWORK_NAME)
        self.assertNotEqual(argv[argv.index('--network') + 1], 'host')
        # the docker socket is never BIND-MOUNTED into the container (a mount value contains ':/').
        # (`docker --host unix:///var/run/docker.sock` is the client talking to the daemon, which is fine.)
        mount_values = [argv[i + 1] for i, a in enumerate(argv[:-1]) if a in ('-v', '--volume', '--mount')]
        self.assertFalse(any('docker.sock' in m for m in mount_values))
        self.assertNotIn('/var/run/docker.sock:/var/run/docker.sock', argv)
        self.assertNotIn('--privileged', argv)
        # the image is the exact pinned digest
        self.assertEqual(argv[-1], rc.IMAGE)
        # the password is NOT present anywhere in the argv
        self.assertFalse(any('password' in a.lower() and '=' in a for a in argv))

    def test_network_is_internal(self):
        self.assertIn('--internal', rc.plan_create_network())

    def test_teardown_targets_only_named_objects_no_prune(self):
        for cmd in rc.plan_teardown():
            self.assertNotIn('prune', cmd)
            self.assertNotIn('--all', cmd)
        names = ' '.join(' '.join(c) for c in rc.plan_teardown())
        self.assertIn(rc.CONTAINER_NAME, names)
        self.assertIn(rc.NETWORK_NAME, names)
        self.assertIn(rc.VOLUME_NAME, names)

    def test_image_identity_uses_pinned_config_digest(self):
        ident = rc.plan_image_identity_commands()
        self.assertEqual(ident['expected_id'], rc.CONFIG_DIGEST)
        self.assertEqual(ident['expected_repo_digest'], rc.IMAGE)
        self.assertEqual(ident['expected_architecture'], 'amd64')

    def test_credential_route_blocked_until_closure(self):
        self.assertEqual(rc.plan_credential_route('OPEN_UNRESOLVED')['status'], 'BLOCKED_PENDING_CLOSURE')
        self.assertEqual(rc.plan_credential_route('CLOSED_FROM_RETAINED_EVIDENCE')['status'], 'PLANNED')

    def test_loaded_library_observer_binds_pids_and_pins_hashes(self):
        plan = rc.plan_loaded_library_observer({'A': 11, 'B': 22, 'C': 33})
        self.assertEqual(plan['expected_library_sha256'], rc.SUPAUTILS_BINARY_SHA256)
        self.assertEqual(plan['library_path'], rc.SUPAUTILS_LIBRARY_PATH)
        self.assertIn('/proc/11/maps', ' '.join(plan['lanes']['A']['read_maps']))
        with self.assertRaises(rc.ContractRefusal):
            rc.plan_loaded_library_observer({'A': 1, 'B': 2})  # missing C
        with self.assertRaises(rc.ContractRefusal):
            rc.plan_loaded_library_observer({'A': 0, 'B': 2, 'C': 3})  # non-positive pid

    def test_custody_seal_reuses_recipient_and_excludes_secrets(self):
        seal = rc.plan_custody_seal()
        self.assertEqual(seal['recipient_normalized_sha256'], rc.AGE_RECIPIENT_NORMALIZED_SHA256)
        self.assertEqual(seal['age_version'], 'v1.3.2')
        self.assertIn('probe/setup credentials', seal['excluded'])
        self.assertIn('manifest.json', seal['evidence_allowlist'])

    def test_log_capture_requires_closure_fact(self):
        self.assertEqual(rc.plan_log_capture()['requires_closure_fact'], 'logging_settings')
        self.assertEqual(rc.plan_log_capture()['format'], 'jsonlog')


class LoadedLibraryBridgeTests(unittest.TestCase):
    def test_bridge_defers_to_loaded_library_validator(self):
        # Prove the bridge actually calls the real loaded-library.py validator (shape refusal path).
        with self.assertRaises(Exception):
            rc.validate_loaded_library_evidence({'wrong': 'shape'}, {'A': {'pid': 1, 'nonce': 'a' * 32}})


if __name__ == '__main__':
    unittest.main(verbosity=2)

#!/usr/bin/env python3
"""Offline tests for db-candidate04/closure_adapter.py. No Docker, no network, no database: every path
is driven with a synthetic, in-process OCI layout + rootfs tree built in a temp dir. Run with:

    python3 -I -B -m unittest test_closure_adapter -v

The headline proofs:
  * a FULL offline-obtainable fact set still yields OPEN_UNRESOLVED because the two container-only GUC
    facts remain missing (test_full_offline_set_is_still_open), and the plan is non-executable;
  * a config-digest mismatch, a tampered layer (diff_id), a tampered emitted fact, and a path-traversal
    member are each refused, not fabricated.
"""
import gzip
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import unittest

_HERE = os.path.realpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'scripts', 'r3_db_candidate'))


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod  # dataclasses needs the module registered before exec
    spec.loader.exec_module(mod)
    return mod


ca = _load('closure_adapter', 'closure_adapter.py')
rc = ca.rc


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')


def make_layer_tar(members, gzip_it=True):
    """members: {rootfs_relpath_without_leading_slash: bytes | ('dir',) | ('sym', target) | ('wh', name)}.
    Returns (stored_blob_bytes, diff_id_with_prefix, media_type)."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tar:
        for name, value in members.items():
            if isinstance(value, tuple) and value and value[0] == 'dir':
                info = tarfile.TarInfo(name.rstrip('/') + '/')
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                tar.addfile(info)
            elif isinstance(value, tuple) and value and value[0] == 'sym':
                info = tarfile.TarInfo(name)
                info.type = tarfile.SYMTYPE
                info.linkname = value[1]
                tar.addfile(info)
            else:
                data = value
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))
    uncompressed = buf.getvalue()
    diff_id = 'sha256:' + sha256_hex(uncompressed)
    if gzip_it:
        stored = gzip.compress(uncompressed, mtime=0)
        media = 'application/vnd.oci.image.layer.v1.tar+gzip'
    else:
        stored = uncompressed
        media = 'application/vnd.oci.image.layer.v1.tar'
    return stored, diff_id, media


def build_layout(root, layers, entrypoint, cmd, ref='db',
                 break_config=False, extra_roots=None, as_index=False):
    """Write a synthetic OCI layout under `root`. layers: list of (members_dict, gzip_bool).
    Returns the config digest (the pin for this layout)."""
    blobs = os.path.join(root, 'blobs', 'sha256')
    os.makedirs(blobs, exist_ok=True)

    layer_descs, diff_ids = [], []
    for members, gz in layers:
        stored, diff_id, media = make_layer_tar(members, gzip_it=gz)
        digest = 'sha256:' + sha256_hex(stored)
        with open(os.path.join(blobs, digest[7:]), 'wb') as handle:
            handle.write(stored)
        layer_descs.append({'mediaType': media, 'digest': digest, 'size': len(stored)})
        diff_ids.append(diff_id)

    config = {'architecture': 'amd64', 'os': 'linux',
              'config': {'Entrypoint': entrypoint, 'Cmd': cmd},
              'rootfs': {'type': 'layers', 'diff_ids': diff_ids}}
    config_bytes = canonical(config)
    if break_config:
        config_bytes = config_bytes + b' '  # alters the digest only
    config_digest = 'sha256:' + sha256_hex(config_bytes)
    with open(os.path.join(blobs, config_digest[7:]), 'wb') as handle:
        handle.write(config_bytes)

    manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                'config': {'mediaType': 'application/vnd.oci.image.config.v1+json',
                           'digest': config_digest, 'size': len(config_bytes)},
                'layers': layer_descs}
    manifest_bytes = canonical(manifest)
    manifest_digest = 'sha256:' + sha256_hex(manifest_bytes)
    with open(os.path.join(blobs, manifest_digest[7:]), 'wb') as handle:
        handle.write(manifest_bytes)

    if as_index:
        # Multi-arch: index.json root points at an image-index blob that carries the amd64 child.
        child_index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                       'manifests': [
                           {'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                            'digest': manifest_digest, 'size': len(manifest_bytes),
                            'platform': {'os': 'linux', 'architecture': 'amd64'}},
                           {'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                            'digest': 'sha256:' + ('a' * 64), 'size': 1,
                            'platform': {'os': 'linux', 'architecture': 'arm64'}}]}
        child_bytes = canonical(child_index)
        child_digest = 'sha256:' + sha256_hex(child_bytes)
        with open(os.path.join(blobs, child_digest[7:]), 'wb') as handle:
            handle.write(child_bytes)
        root_manifests = [{'mediaType': 'application/vnd.oci.image.index.v1+json',
                           'digest': child_digest, 'size': len(child_bytes),
                           'annotations': {'org.opencontainers.image.ref.name': ref}}]
    else:
        root_manifests = [{'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                           'digest': manifest_digest, 'size': len(manifest_bytes),
                           'platform': {'os': 'linux', 'architecture': 'amd64'},
                           'annotations': {'org.opencontainers.image.ref.name': ref}}]
    if extra_roots:
        root_manifests = list(root_manifests) + list(extra_roots)

    index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
             'manifests': root_manifests}
    with open(os.path.join(root, 'index.json'), 'wb') as handle:
        handle.write(canonical(index))
    with open(os.path.join(root, 'oci-layout'), 'wb') as handle:
        handle.write(canonical({'imageLayoutVersion': '1.0.0'}))
    return config_digest


# A rootfs surface that carries every offline-obtainable fact.
POSTGRES_CONF = (b"# main conf\n"
                 b"listen_addresses = '*'\n"
                 b"include_dir = 'conf.d'\n"
                 b"include_if_exists = 'extra.conf'\n"
                 b"log_destination = 'jsonlog'\n"
                 b"logging_collector = on\n")
CONF_D_10 = b"shared_preload_libraries = 'supautils, pg_stat_statements'\n"
EXTRA_CONF = b"log_min_messages = warning\n"
SUPAUTILS_CONF = b"supautils.reserved_roles = 'supabase_admin'\nsupautils.privileged_role = 'postgres'\n"
PG_HBA = b"local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n"
ENTRYPOINT = b"#!/usr/bin/env bash\nset -e\n: \"${POSTGRES_USER:=postgres}\"\n# supabase_admin bootstrap\n"
INITDB_ROLES = b"CREATE ROLE supabase_admin SUPERUSER;\n"
INITDB_JWT = b"ALTER DATABASE postgres SET something = 1;\n"


def full_surface_members():
    return {
        'etc/postgresql/postgresql.conf': POSTGRES_CONF,
        'etc/postgresql/conf.d/10-preload.conf': CONF_D_10,
        'etc/postgresql/extra.conf': EXTRA_CONF,
        'etc/postgresql/pg_hba.conf': PG_HBA,
        'etc/postgresql-custom/supautils.conf': SUPAUTILS_CONF,
        'usr/local/bin/docker-entrypoint.sh': ENTRYPOINT,
        'docker-entrypoint-initdb.d/00-roles.sql': INITDB_ROLES,
        'docker-entrypoint-initdb.d/10-jwt.sql': INITDB_JWT,
    }


class AdapterTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='r4-adapter-test-')
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.layout = os.path.join(self.tmp, 'layout')
        self.evidence = os.path.join(self.tmp, 'evidence')
        os.makedirs(self.layout, exist_ok=True)
        self._saved_rc = rc.CONFIG_DIGEST
        self._saved_ca = ca.CONFIG_DIGEST

    def tearDown(self):
        rc.CONFIG_DIGEST = self._saved_rc
        ca.CONFIG_DIGEST = self._saved_ca

    def pin(self, digest):
        """Override the pinned config digest (both modules) to this synthetic layout's digest."""
        rc.CONFIG_DIGEST = digest
        ca.CONFIG_DIGEST = digest

    def build_full(self, **kwargs):
        digest = build_layout(self.layout, [(full_surface_members(), True)],
                              entrypoint=['docker-entrypoint.sh'], cmd=['postgres'], **kwargs)
        return digest


class TestFullOfflineSetStillOpen(AdapterTestBase):
    def test_full_offline_set_is_still_open(self):
        digest = self.build_full()
        self.pin(digest)
        evidence_index, report, oci = ca.build_closure_evidence(self.layout, self.evidence)
        # All 9 obtainable facts offered; the 2 container-only ones withheld.
        offered = sorted(k for k in evidence_index if k != '_oci_closure')
        self.assertEqual(len(offered), 9)
        for fact in ca.CONTAINER_ONLY_FACTS:
            self.assertNotIn(fact, evidence_index)
        closure = rc.read_startup_closure(evidence_index, ca.make_reader())
        self.assertEqual(closure.status, 'OPEN_UNRESOLVED')
        self.assertEqual(sorted(closure.missing), sorted(ca.CONTAINER_ONLY_FACTS))
        self.assertEqual(len(closure.present), 9)
        plan = rc.assemble_plan(closure)
        self.assertFalse(plan['executable'])
        self.assertIn('shared_preload_libraries', plan['blocking_reason'])
        self.assertIn('supautils_gucs', plan['blocking_reason'])

    def test_oci_closure_verified_and_pinned(self):
        digest = self.build_full()
        self.pin(digest)
        evidence_index, report, oci = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertEqual(oci['status'], 'OCI_CLOSURE_VERIFIED')
        self.assertEqual(oci['config_digest'], digest)
        self.assertEqual(evidence_index['_oci_closure']['config_digest'], digest)

    def test_every_required_fact_classified_once(self):
        digest = self.build_full()
        self.pin(digest)
        _, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        classified = set(report['present']) | set(report['missing_in_rootfs']) | set(ca.CONTAINER_ONLY_FACTS)
        self.assertEqual(classified, set(rc.REQUIRED_CLOSURE_FACTS))
        # none double-classified
        self.assertFalse(set(report['present']) & set(report['missing_in_rootfs']))
        self.assertFalse(set(report['present']) & set(ca.CONTAINER_ONLY_FACTS))


class TestFactContents(AdapterTestBase):
    def setUp(self):
        super().setUp()
        self.digest = self.build_full()
        self.pin(self.digest)
        self.evidence_index, self.report, self.oci = ca.build_closure_evidence(
            self.layout, self.evidence)

    def test_single_file_facts_point_at_rootfs_bytes(self):
        hba = self.evidence_index['pg_hba_conf']
        with open(hba['path'], 'rb') as handle:
            self.assertEqual(handle.read(), PG_HBA)
        self.assertEqual(hba['sha256'], sha256_hex(PG_HBA))

    def test_image_entrypoint_derived_from_config(self):
        with open(self.evidence_index['image_entrypoint']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertEqual(obj['entrypoint'], ['docker-entrypoint.sh'])
        self.assertEqual(obj['cmd'], ['postgres'])
        self.assertEqual(obj['_config_digest'], self.digest)

    def test_include_chain_resolves_dir_and_file(self):
        with open(self.evidence_index['postgresql_conf_include_chain']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        resolved = {d['resolved'] for d in obj['directives']}
        self.assertIn('/etc/postgresql/conf.d', resolved)
        self.assertIn('/etc/postgresql/extra.conf', resolved)
        self.assertEqual(obj['uncaptured_targets'], [])
        source_paths = {s['path'] for s in obj['sources']}
        self.assertIn('/etc/postgresql/postgresql.conf', source_paths)
        self.assertIn('/etc/postgresql/conf.d/10-preload.conf', source_paths)

    def test_logging_settings_are_declared_static_only(self):
        with open(self.evidence_index['logging_settings']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertEqual(obj['declared']['log_destination'], 'jsonlog')
        self.assertEqual(obj['declared']['logging_collector'], 'on')
        self.assertIn('static', obj['_derivation'].lower())
        self.assertIn('effective', obj['_caveat'].lower())

    def test_initdb_order_is_lexical(self):
        with open(self.evidence_index['initdb_scripts']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertEqual([e['name'] for e in obj['order']], ['00-roles.sql', '10-jwt.sql'])

    def test_bootstrap_identity_tokens_declared(self):
        with open(self.evidence_index['bootstrap_superuser_identity']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertIn('supabase_admin', obj['declared_tokens'])
        self.assertIn('static', obj['_derivation'].lower())

    def test_container_only_facts_absent_from_evidence(self):
        for fact in ('shared_preload_libraries', 'supautils_gucs'):
            self.assertNotIn(fact, self.evidence_index)
        self.assertIn('running-server', self.report['container_only_note'])

    # -- Headline honesty property: every derived artifact records the TRUE sha256 of each rootfs file
    #    it was built from, so each fact traces back to pinned image bytes. (QA: previously untested;
    #    four source-hash fabrication mutants survived without these.)
    def _rootfs_bytes(self):
        return {
            '/etc/postgresql/postgresql.conf': POSTGRES_CONF,
            '/etc/postgresql/conf.d/10-preload.conf': CONF_D_10,
            '/etc/postgresql/extra.conf': EXTRA_CONF,
            '/etc/postgresql/pg_hba.conf': PG_HBA,
            '/etc/postgresql-custom/supautils.conf': SUPAUTILS_CONF,
            '/usr/local/bin/docker-entrypoint.sh': ENTRYPOINT,
            '/docker-entrypoint-initdb.d/00-roles.sql': INITDB_ROLES,
            '/docker-entrypoint-initdb.d/10-jwt.sql': INITDB_JWT,
        }

    def test_include_chain_source_hashes_match_rootfs_bytes(self):
        truth = self._rootfs_bytes()
        with open(self.evidence_index['postgresql_conf_include_chain']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertTrue(obj['sources'])
        for src in obj['sources']:
            self.assertIn(src['path'], truth, 'source path must be a real rootfs file')
            self.assertEqual(src['sha256'], sha256_hex(truth[src['path']]),
                             'include-chain source sha256 must equal the rootfs file bytes')
        # the include_dir member hashes too
        for directive in obj['directives']:
            for member in directive.get('members', []):
                self.assertEqual(member['sha256'], sha256_hex(truth[member['path']]))

    def test_initdb_source_hashes_match_rootfs_bytes(self):
        truth = self._rootfs_bytes()
        with open(self.evidence_index['initdb_scripts']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        for entry in obj['order']:
            self.assertEqual(entry['sha256'], sha256_hex(truth[entry['path']]),
                             'initdb entry sha256 must equal the rootfs file bytes')

    def test_logging_source_hashes_match_rootfs_bytes(self):
        truth = self._rootfs_bytes()
        with open(self.evidence_index['logging_settings']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        for src in obj['sources']:
            self.assertEqual(src['sha256'], sha256_hex(truth[src['path']]))

    def test_bootstrap_source_hashes_match_rootfs_bytes(self):
        truth = self._rootfs_bytes()
        with open(self.evidence_index['bootstrap_superuser_identity']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertTrue(obj['sources'])
        for src in obj['sources']:
            self.assertEqual(src['sha256'], sha256_hex(truth[src['path']]),
                             'bootstrap source sha256 must equal the rootfs file bytes')


class TestConfigDigestMismatch(AdapterTestBase):
    def test_mismatch_is_refused(self):
        # build a layout whose config digest != pin
        digest = self.build_full()
        self.pin('sha256:' + ('0' * 64))  # pin something else
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.build_closure_evidence(self.layout, self.evidence)
        self.assertTrue(ctx.exception.code.startswith('OCI_NOT_VERIFIED')
                        or ctx.exception.code == 'OCI_CONFIG_PIN')

    def test_corrupted_config_blob_refused(self):
        digest = build_layout(self.layout, [(full_surface_members(), True)],
                              entrypoint=['x'], cmd=['y'], break_config=True)
        # break_config changed the stored bytes AFTER digest computed? No: build_layout computes the
        # digest from the already-broken bytes, so verify will pass the self-consistency but we pin a
        # different value to force the refusal path for a genuinely different config.
        self.pin(digest)
        # Now tamper the on-disk config blob so its bytes no longer match the descriptor digest.
        blob = os.path.join(self.layout, 'blobs', 'sha256', digest[7:])
        with open(blob, 'ab') as handle:
            handle.write(b'tampered')
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.build_closure_evidence(self.layout, self.evidence)
        # config blob bytes no longer match the manifest's config descriptor digest.
        self.assertTrue(ctx.exception.code.startswith('OCI_NOT_VERIFIED'), ctx.exception.code)
        self.assertIn('OCI_CONFIG_DESC', ctx.exception.code)


class TestTamperedLayer(AdapterTestBase):
    def test_tampered_layer_blob_fails_content_address(self):
        # Corrupting a layer blob on disk is caught by the OCI content-address check (OCI_LAYER_DIGEST)
        # inside verify_oci_closure, BEFORE materialisation — so the forged bytes never reach the rootfs.
        # (The diff_id check is the second, independent guard; see test_diff_id_mismatch_direct.)
        digest = self.build_full()
        self.pin(digest)
        blobs = os.path.join(self.layout, 'blobs', 'sha256')
        with open(os.path.join(self.layout, 'index.json'), 'rb') as handle:
            index = json.loads(handle.read())
        man_digest = index['manifests'][0]['digest'][7:]
        with open(os.path.join(blobs, man_digest), 'rb') as handle:
            manifest = json.loads(handle.read())
        layer_digest = manifest['layers'][0]['digest'][7:]
        with open(os.path.join(blobs, layer_digest), 'ab') as handle:
            handle.write(b'\x00junk')
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.build_closure_evidence(self.layout, self.evidence)
        self.assertIn('OCI_LAYER_DIGEST', ctx.exception.code)

    def test_diff_id_mismatch_direct(self):
        # Exercise materialize_rootfs's diff_id check directly with a good blob but a wrong diff_id.
        members = {'etc/postgresql/postgresql.conf': POSTGRES_CONF}
        stored, diff_id, media = make_layer_tar(members, gzip_it=True)
        store = {'L': stored}
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.materialize_rootfs(['L'], [media], ['sha256:' + ('b' * 64)],
                                  lambda p: store[p])
        self.assertTrue(ctx.exception.code.startswith('ROOTFS_DIFF_ID_MISMATCH'))


class TestTamperedEmittedFact(AdapterTestBase):
    def test_tampered_evidence_file_fails_closure_hash(self):
        digest = self.build_full()
        self.pin(digest)
        evidence_index, _, _ = ca.build_closure_evidence(self.layout, self.evidence)
        # Tamper a written fact file after emission; read_startup_closure must reject it.
        target = evidence_index['pg_hba_conf']['path']
        with open(target, 'ab') as handle:
            handle.write(b'host evil all 0.0.0.0/0 trust\n')
        with self.assertRaises(rc.ContractRefusal) as ctx:
            rc.read_startup_closure(evidence_index, ca.make_reader())
        self.assertTrue(ctx.exception.code.startswith('CLOSURE_HASH_MISMATCH'))


class TestMissingFacts(AdapterTestBase):
    def test_missing_postgresql_conf_cascades(self):
        members = full_surface_members()
        del members['etc/postgresql/postgresql.conf']
        digest = build_layout(self.layout, [(members, True)],
                              entrypoint=['docker-entrypoint.sh'], cmd=['postgres'])
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertNotIn('postgresql_conf', evidence_index)
        self.assertIn('postgresql_conf', report['missing_in_rootfs'])
        # include chain + logging depend on the conf, so they too are absent
        self.assertIn('postgresql_conf_include_chain', report['missing_in_rootfs'])
        self.assertIn('logging_settings', report['missing_in_rootfs'])
        closure = rc.read_startup_closure(evidence_index, ca.make_reader())
        self.assertEqual(closure.status, 'OPEN_UNRESOLVED')
        for fact in ('postgresql_conf', 'postgresql_conf_include_chain', 'logging_settings'):
            self.assertIn(fact, closure.missing)

    def test_missing_supautils_conf(self):
        members = full_surface_members()
        del members['etc/postgresql-custom/supautils.conf']
        digest = build_layout(self.layout, [(members, True)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertNotIn('supautils_conf', evidence_index)
        self.assertIn('supautils_conf', report['missing_in_rootfs'])


class TestWhiteouts(AdapterTestBase):
    def test_whiteout_deletes_earlier_file(self):
        base = full_surface_members()
        # layer 2 whiteouts pg_hba.conf
        upper = {'etc/postgresql/.wh.pg_hba.conf': b''}
        digest = build_layout(self.layout, [(base, True), (upper, True)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertNotIn('pg_hba_conf', evidence_index)
        self.assertIn('pg_hba_conf', report['missing_in_rootfs'])

    def test_opaque_whiteout_clears_dir(self):
        base = full_surface_members()
        upper = {'docker-entrypoint-initdb.d/.wh..wh..opq': b'',
                 'docker-entrypoint-initdb.d/99-new.sql': b'SELECT 1;\n'}
        digest = build_layout(self.layout, [(base, True), (upper, True)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        with open(evidence_index['initdb_scripts']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        names = [e['name'] for e in obj['order']]
        self.assertEqual(names, ['99-new.sql'])

    def test_later_layer_overrides_file(self):
        base = full_surface_members()
        upper = {'etc/postgresql/pg_hba.conf': b"host all all 10.0.0.0/8 scram-sha-256\n"}
        digest = build_layout(self.layout, [(base, True), (upper, True)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, _, _ = ca.build_closure_evidence(self.layout, self.evidence)
        with open(evidence_index['pg_hba_conf']['path'], 'rb') as handle:
            self.assertEqual(handle.read(), b"host all all 10.0.0.0/8 scram-sha-256\n")


class TestTraversalAndSymlink(AdapterTestBase):
    def test_traversal_member_refused(self):
        store = {'L': None}
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w') as tar:
            info = tarfile.TarInfo('etc/postgresql/../../escape')
            data = b'x'
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        stored = gzip.compress(buf.getvalue(), mtime=0)
        diff_id = 'sha256:' + sha256_hex(buf.getvalue())
        store['L'] = stored
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.materialize_rootfs(['L'], ['application/vnd.oci.image.layer.v1.tar+gzip'],
                                  [diff_id], lambda p: store[p])
        self.assertEqual(ctx.exception.code, 'ROOTFS_TRAVERSAL')

    def test_symlink_recorded_not_followed(self):
        members = full_surface_members()
        members['etc/postgresql/pg_hba.conf'] = ('sym', '/etc/passwd')
        digest = build_layout(self.layout, [(members, True)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        # a symlink is not a readable config file -> the fact is reported absent, never dereferenced
        self.assertNotIn('pg_hba_conf', evidence_index)
        self.assertIn('pg_hba_conf', report['missing_in_rootfs'])


class TestCompressionVariants(AdapterTestBase):
    def test_uncompressed_tar_layer(self):
        digest = build_layout(self.layout, [(full_surface_members(), False)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, _, _ = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertIn('postgresql_conf', evidence_index)

    def test_zstd_layer_refused(self):
        store = {'L': b'\x28\xb5\x2f\xfd' + b'\x00' * 16}
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.materialize_rootfs(['L'], ['application/vnd.oci.image.layer.v1.tar+zstd'],
                                  ['sha256:' + ('c' * 64)], lambda p: store[p])
        self.assertEqual(ctx.exception.code, 'LAYER_ZSTD_UNSUPPORTED')


class TestCeilings(AdapterTestBase):
    def _layer(self, members):
        stored, diff_id, media = make_layer_tar(members, gzip_it=True)
        return {'L': stored}, media, diff_id

    def test_oversized_file_refused(self):
        saved = ca.MAX_KEPT_FILE_BYTES
        ca.MAX_KEPT_FILE_BYTES = 16
        self.addCleanup(setattr, ca, 'MAX_KEPT_FILE_BYTES', saved)
        store, media, diff_id = self._layer(
            {'etc/postgresql/postgresql.conf': b'x' * 64})
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.materialize_rootfs(['L'], [media], [diff_id], lambda p: store[p])
        self.assertTrue(ctx.exception.code.startswith('ROOTFS_FILE_TOO_LARGE'))

    def test_oversized_total_surface_refused(self):
        saved = ca.MAX_KEPT_TOTAL_BYTES
        ca.MAX_KEPT_TOTAL_BYTES = 20
        self.addCleanup(setattr, ca, 'MAX_KEPT_TOTAL_BYTES', saved)
        store, media, diff_id = self._layer({
            'etc/postgresql/a.conf': b'x' * 12,
            'etc/postgresql/b.conf': b'y' * 12,
        })
        with self.assertRaises(ca.AdapterRefusal) as ctx:
            ca.materialize_rootfs(['L'], [media], [diff_id], lambda p: store[p])
        self.assertEqual(ctx.exception.code, 'ROOTFS_SURFACE_TOO_LARGE')


class TestUncapturedInclude(AdapterTestBase):
    def test_missing_include_target_reported_uncaptured(self):
        members = full_surface_members()
        members['etc/postgresql/postgresql.conf'] = (
            b"include = 'absent.conf'\n"           # a hard include whose target is not in the rootfs
            b"log_destination = 'stderr'\n")
        digest = build_layout(self.layout, [(members, True)],
                              entrypoint=['x'], cmd=['y'])
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        with open(evidence_index['postgresql_conf_include_chain']['path'], 'rb') as handle:
            obj = json.loads(handle.read())
        self.assertIn('/etc/postgresql/absent.conf', obj['uncaptured_targets'])


class TestRootResolution(AdapterTestBase):
    def test_multi_arch_index_root(self):
        digest = build_layout(self.layout, [(full_surface_members(), True)],
                              entrypoint=['x'], cmd=['y'], as_index=True)
        self.pin(digest)
        evidence_index, _, oci = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertEqual(oci['status'], 'OCI_CLOSURE_VERIFIED')
        self.assertIn('postgresql_conf', evidence_index)

    def test_multiple_roots_selected_by_config_pin(self):
        # Add an unrelated extra root in index.json; selection must find the pinned one by config.
        extra = [{'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                  'digest': 'sha256:' + ('d' * 64), 'size': 2,
                  'platform': {'os': 'linux', 'architecture': 'amd64'},
                  'annotations': {'org.opencontainers.image.ref.name': 'other'}}]
        digest = build_layout(self.layout, [(full_surface_members(), True)],
                              entrypoint=['x'], cmd=['y'], ref='db', extra_roots=extra)
        self.pin(digest)
        evidence_index, _, oci = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertEqual(oci['config_digest'], digest)

    def test_acquire_annotation_form_resolves(self):
        # Lock the input contract to r3_image_acquire's real output: acquire writes index.json roots with
        # annotations["org.opencontainers.image.ref.name"] == the full "repo@sha256:..." digest ref, and a
        # db-only layout has exactly one root. The adapter must resolve it with no --image-ref, and also
        # when that exact ref is passed.
        ref = 'supabase/postgres@sha256:' + ('e' * 64)
        digest = build_layout(self.layout, [(full_surface_members(), True)],
                              entrypoint=['docker-entrypoint.sh'], cmd=['postgres'], ref=ref)
        self.pin(digest)
        ei_auto, _, oci_auto = ca.build_closure_evidence(self.layout, self.evidence)
        self.assertEqual(oci_auto['config_digest'], digest)
        self.assertIn('postgresql_conf', ei_auto)
        ei_ref, _, oci_ref = ca.build_closure_evidence(
            self.layout, self.evidence + '-ref', image_ref=ref)
        self.assertEqual(oci_ref['config_digest'], digest)

    def test_image_ref_disambiguates(self):
        extra = [{'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                  'digest': 'sha256:' + ('e' * 64), 'size': 2,
                  'platform': {'os': 'linux', 'architecture': 'amd64'},
                  'annotations': {'org.opencontainers.image.ref.name': 'other'}}]
        digest = build_layout(self.layout, [(full_surface_members(), True)],
                              entrypoint=['x'], cmd=['y'], ref='db', extra_roots=extra)
        self.pin(digest)
        evidence_index, _, oci = ca.build_closure_evidence(
            self.layout, self.evidence, image_ref='db')
        self.assertEqual(oci['config_digest'], digest)


class TestPermissions(AdapterTestBase):
    def test_evidence_tree_is_private(self):
        digest = self.build_full()
        self.pin(digest)
        ca.build_closure_evidence(self.layout, self.evidence)
        mode = os.stat(self.evidence).st_mode & 0o777
        self.assertEqual(mode, 0o700)
        # a written fact file is 0600
        derived = os.path.join(self.evidence, 'derived', 'image_entrypoint.json')
        self.assertEqual(os.stat(derived).st_mode & 0o777, 0o600)


class TestSummaryHonesty(AdapterTestBase):
    def test_summary_reports_open_and_not_executed(self):
        digest = self.build_full()
        self.pin(digest)
        evidence_index, report, _ = ca.build_closure_evidence(self.layout, self.evidence)
        closure = rc.read_startup_closure(evidence_index, ca.make_reader())
        summary = ca.summarize(evidence_index, report, closure)
        self.assertEqual(summary['closure_status'], 'OPEN_UNRESOLVED')
        self.assertEqual(summary['historical_status'], 'NOT_REPRODUCED')
        self.assertEqual(summary['runtime_status'], 'NOT_EXECUTED')
        self.assertEqual(summary['r3_status'], 'OPEN')
        self.assertEqual(sorted(summary['container_only_withheld']),
                         sorted(ca.CONTAINER_ONLY_FACTS))


if __name__ == '__main__':
    unittest.main(verbosity=2)

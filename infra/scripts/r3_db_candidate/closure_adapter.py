#!/usr/bin/env python3
"""db-candidate04/closure_adapter.py — OFFLINE closure-evidence adapter.

Bridges the registry-denied, empty-store OCI image transport that
infra/scripts/r3_image_import.py produces (a content-addressed OCI layout:
oci-layout + index.json + blobs/sha256/<digest> for the pinned db image's
platform manifest, config and layer blobs) into the startup-closure reader that
db-candidate03/runtime_contract.read_startup_closure consumes.

What it does, strictly offline, with no Docker, no network and no database:

  1. Resolves the pinned linux/amd64 db image inside a retained OCI layout and
     verifies it content-addresses to the pinned CONFIG_DIGEST, reusing
     runtime_contract.verify_oci_closure (the same primitive candidate03 uses).
  2. Materialises the rootfs IN MEMORY from the verified layer blobs: each layer
     blob is decompressed, its uncompressed digest is checked against the
     config's rootfs.diff_ids in order, and its members are applied with OCI/AUFS
     whiteout semantics. The rootfs is therefore a function of the SAME verified,
     pinned bytes — there is no separately-trusted rootfs input to forge.
  3. Extracts the startup-closure facts that are genuinely present in those bytes
     as {path, sha256} entries, writing each obtainable fact (or a canonical
     derived artifact built only from verified rootfs bytes) into a 0700 custody
     evidence tree, and emits EXACTLY the evidence_index that
     read_startup_closure consumes, plus a reader over that tree.
  4. Marks the two facts that only a running container can prove
     (effective shared_preload_libraries, effective supautils GUCs) as
     CONTAINER_ONLY and WITHHOLDS them, so the closure stays OPEN_UNRESOLVED
     honestly until the owner's single live run captures them.

It NEVER fabricates a fact and NEVER interprets bytes into a desired config: a
derived artifact carries only raw declarations plus the sha256 of every rootfs
file it was built from, so each fact traces back to pinned image bytes. A fact
whose source path is absent from the rootfs is reported absent, never guessed.

Historical status stays NOT_REPRODUCED; the native runtime stays NOT_EXECUTED;
R3 stays OPEN. This module executes nothing: `--emit` reads an OCI layout from
disk and writes a custody evidence tree + evidence_index JSON; that is all.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import tarfile

# ---------------------------------------------------------------------------------------------------
# Reuse the candidate03 contract (copied into this packet by exact hash; see binding04.json). We import
# the sibling module by file path so the hyphen-free name resolves without touching candidate03's copy.
# ---------------------------------------------------------------------------------------------------
import importlib.util


def _load_sibling(filename, module_name):
    import sys
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod  # dataclasses needs the module registered before exec
    spec.loader.exec_module(mod)
    return mod


rc = _load_sibling('runtime_contract.py', 'r4_runtime_contract')

CONFIG_DIGEST = rc.CONFIG_DIGEST
REQUIRED_CLOSURE_FACTS = rc.REQUIRED_CLOSURE_FACTS
verify_oci_closure = rc.verify_oci_closure
HEX64 = rc.HEX64


class AdapterRefusal(Exception):
    """Fail-closed refusal. Every refusal carries a stable code; nothing is guessed past one."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _check(condition, code):
    if not condition:
        raise AdapterRefusal(code)


def _sha256_bytes(data):
    return hashlib.sha256(bytes(data)).hexdigest()


def _canonical(obj):
    """Deterministic JSON bytes: sorted keys, compact separators, UTF-8. Used for every derived
    artifact so its sha256 is reproducible by any offline reviewer."""
    return json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')


# ===================================================================================================
# Fact classification. Each REQUIRED_CLOSURE_FACTS entry is exactly one of:
#   CONFIG   — carried by the verified image config blob (derived artifact)
#   FILE     — a single rootfs file, emitted as that file's {path, sha256}
#   DERIVED  — a canonical artifact built ONLY from verified rootfs files it names by sha256
#   CONTAINER_ONLY — provable only by a running server; WITHHELD so the closure stays open
# The FILE/DERIVED path lists are the pinned supabase/postgres image's known locations; a fact whose
# sources are all absent is reported absent (missing_in_rootfs), never fabricated.
# ===================================================================================================
CONFIG_FACTS = ('image_entrypoint',)

FILE_FACTS = {
    # fact -> ordered candidate rootfs paths (first present wins; absence is reported, not guessed)
    'docker_entrypoint_script': (
        '/usr/local/bin/docker-entrypoint.sh',
        '/docker-entrypoint.sh',
    ),
    'postgresql_conf': (
        '/etc/postgresql/postgresql.conf',
        '/var/lib/postgresql/data/postgresql.conf',
    ),
    'supautils_conf': (
        '/etc/postgresql-custom/supautils.conf',
    ),
    'pg_hba_conf': (
        '/etc/postgresql/pg_hba.conf',
        '/var/lib/postgresql/data/pg_hba.conf',
    ),
}

DERIVED_FACTS = ('postgresql_conf_include_chain', 'logging_settings',
                 'initdb_scripts', 'bootstrap_superuser_identity')

CONTAINER_ONLY_FACTS = ('shared_preload_libraries', 'supautils_gucs')

# Directory holding the initdb scripts whose on-disk order the entrypoint applies.
INITDB_DIRS = ('/docker-entrypoint-initdb.d',)

# Logging GUC names whose DECLARED (static) value we read from the conf chain. Effective values are a
# running-server fact and are NOT claimed here.
LOGGING_GUCS = ('log_destination', 'logging_collector', 'log_directory', 'log_filename',
                'log_file_mode', 'log_rotation_age', 'log_rotation_size', 'log_min_messages',
                'log_min_error_statement', 'log_statement', 'log_connections', 'log_line_prefix')

# Tokens that textually DECLARE a bootstrap superuser identity in the entrypoint / initdb scripts.
BOOTSTRAP_TOKENS = ('POSTGRES_USER', 'POSTGRES_SUPERUSER', 'supabase_admin', 'postgres')

# Only rootfs paths under these prefixes are retained while layering, so memory stays bounded to the
# configuration surface. Any include/initdb target found outside them is REPORTED as uncaptured, never
# silently dropped. The real image keeps its whole config surface here.
KEEP_PREFIXES = ('/etc/postgresql', '/etc/postgresql-custom', '/usr/local/bin',
                 '/docker-entrypoint-initdb.d', '/docker-entrypoint.sh')

MAX_KEPT_FILE_BYTES = 8 * 1024 * 1024    # a single config/script file; refuse an oversized surprise
MAX_KEPT_TOTAL_BYTES = 64 * 1024 * 1024  # total retained config surface ceiling


# ===================================================================================================
# 1. OCI layout resolution + strict pin verification (delegates the content-addressing to candidate03).
# ===================================================================================================
_INDEX_MEDIA_TYPES = (
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
)


def _blob_path(layout_dir, digest):
    _check(isinstance(digest, str) and digest.startswith('sha256:')
           and bool(HEX64.match(digest[7:])), 'OCI_BAD_DIGEST')
    return os.path.join(layout_dir, 'blobs', 'sha256', digest[7:])


def build_layout_index(layout_dir, read_bytes, image_ref=None):
    """Resolve the pinned linux/amd64 image inside an OCI layout to the {oci_layout, index, manifest,
    config, layers} shape verify_oci_closure wants. Descends one image-index level for a multi-arch
    root. 'index' is always the JSON document that directly carries the linux/amd64 descriptor, so
    verify_oci_closure's single-platform-child check holds. image_ref optionally disambiguates when the
    layout holds several roots (the #228 subset holds nine)."""
    _check(callable(read_bytes), 'LAYOUT_INPUT')
    oci_layout_path = os.path.join(layout_dir, 'oci-layout')
    index_path = os.path.join(layout_dir, 'index.json')
    top = json.loads(read_bytes(index_path))
    manifests = top.get('manifests') or []
    _check(isinstance(manifests, list) and manifests, 'LAYOUT_INDEX_EMPTY')

    def ref_of(descriptor):
        ann = descriptor.get('annotations') or {}
        return ann.get('org.opencontainers.image.ref.name')

    if image_ref is not None:
        roots = [m for m in manifests if ref_of(m) == image_ref]
        _check(len(roots) == 1, 'LAYOUT_REF_NOT_UNIQUE')
        root = roots[0]
    elif len(manifests) == 1:
        root = manifests[0]
    else:
        # No ref given and several roots: pick the one whose platform-manifest closure pins to
        # CONFIG_DIGEST. We never pick by name heuristics.
        root = _select_root_by_config(layout_dir, read_bytes, manifests)

    root_digest = root.get('digest')
    root_media = root.get('mediaType')
    index_doc_path = index_path
    if root_media in _INDEX_MEDIA_TYPES:
        # Multi-arch root: the linux/amd64 descriptor lives inside this child index blob.
        child_path = _blob_path(layout_dir, root_digest)
        index_doc_path = child_path
    else:
        # Single-arch root already named in index.json: synthesize a one-entry index document so
        # verify_oci_closure sees a linux/amd64 child pointing at this manifest. We DO NOT trust the
        # synthesized bytes for anything except locating the manifest; verify re-hashes the manifest.
        index_doc_path = _synth_index(layout_dir, root)

    index_doc = json.loads(read_bytes(index_doc_path)) if isinstance(index_doc_path, str) \
        else index_doc_path
    children = [m for m in index_doc.get('manifests', [])
                if (m.get('platform') or {}).get('os') == 'linux'
                and (m.get('platform') or {}).get('architecture') == 'amd64']
    _check(len(children) == 1, 'LAYOUT_PLATFORM_CHILD')
    manifest_digest = children[0].get('digest')
    manifest = json.loads(read_bytes(_blob_path(layout_dir, manifest_digest)))
    config_digest = (manifest.get('config') or {}).get('digest')
    layer_digests = [d.get('digest') for d in manifest.get('layers', [])]
    _check(all(layer_digests), 'LAYOUT_LAYER_DIGEST')
    return {
        'oci_layout': oci_layout_path,
        # verify_oci_closure reads 'index' bytes; give it a reader-visible document. For the multi-arch
        # case that's the child index blob path; for single-arch we pass an in-memory doc the adapter's
        # read_bytes serves. We standardise on blob/real paths by writing nothing and handing the parsed
        # doc path. To keep read_bytes simple, we always hand verify a path it can read:
        'index': index_doc_path if isinstance(index_doc_path, str) else None,
        'index_doc': index_doc,
        'manifest': _blob_path(layout_dir, manifest_digest),
        'config': _blob_path(layout_dir, config_digest),
        'layers': [_blob_path(layout_dir, d) for d in layer_digests],
        'config_digest': config_digest,
        'manifest_digest': manifest_digest,
        'layer_digests': layer_digests,
    }


def _synth_index(layout_dir, root):
    """Return an in-memory one-entry index document (dict) presenting the single-arch root as a
    linux/amd64 child. Returned as a dict, handled by callers (not a path)."""
    platform = root.get('platform') or {'os': 'linux', 'architecture': 'amd64'}
    return {'schemaVersion': 2, 'manifests': [{'mediaType': root.get('mediaType'),
            'digest': root.get('digest'), 'size': root.get('size'), 'platform': platform}]}


def _select_root_by_config(layout_dir, read_bytes, manifests):
    for root in manifests:
        try:
            media = root.get('mediaType')
            if media in _INDEX_MEDIA_TYPES:
                doc = json.loads(read_bytes(_blob_path(layout_dir, root.get('digest'))))
            else:
                doc = _synth_index(layout_dir, root)
            children = [m for m in doc.get('manifests', [])
                        if (m.get('platform') or {}).get('os') == 'linux'
                        and (m.get('platform') or {}).get('architecture') == 'amd64']
            if len(children) != 1:
                continue
            manifest = json.loads(read_bytes(_blob_path(layout_dir, children[0].get('digest'))))
            if (manifest.get('config') or {}).get('digest') == CONFIG_DIGEST:
                return root
        except (AdapterRefusal, ValueError, KeyError, OSError):
            continue
    raise AdapterRefusal('LAYOUT_NO_PINNED_ROOT')


def verify_layout(layout_index, read_bytes):
    """Run candidate03's content-addressed verification against the resolved layout. verify_oci_closure
    needs an 'index' it can read; for the synthesized single-arch case we wrap read_bytes so the
    in-memory index_doc is served under a sentinel path. Returns the oci_closure dict unchanged."""
    index_entry = layout_index.get('index')
    index_doc = layout_index.get('index_doc')
    if index_entry is None:
        sentinel = '<adapter:index_doc>'
        doc_bytes = _canonical(index_doc) if index_doc is not None else b''

        # verify_oci_closure only parses the index for platform descriptors + the child digest; the
        # digest it compares is sha256(manifest bytes), so the index document's own bytes are not pinned
        # and a canonical serialization is sound.
        def wrapped(path):
            return doc_bytes if path == sentinel else read_bytes(path)

        slim = {k: v for k, v in layout_index.items()
                if k in ('oci_layout', 'manifest', 'config', 'layers')}
        slim['index'] = sentinel
        return verify_oci_closure(slim, wrapped)
    slim = {k: v for k, v in layout_index.items()
            if k in ('oci_layout', 'index', 'manifest', 'config', 'layers')}
    return verify_oci_closure(slim, read_bytes)


# ===================================================================================================
# 2. In-memory rootfs materialisation from verified layer blobs (diff_id checked, whiteouts applied).
# ===================================================================================================
def _decompress_layer(blob, media_type):
    """Return the uncompressed tar bytes for a layer blob. gzip is detected by media type or magic;
    an already-uncompressed tar passes through. zstd and other schemes are refused (not fabricated)."""
    if blob[:2] == b'\x1f\x8b' or (media_type and media_type.endswith('gzip')):
        return gzip.decompress(bytes(blob))
    if blob[:4] == b'\x28\xb5\x2f\xfd' or (media_type and media_type.endswith('zstd')):
        raise AdapterRefusal('LAYER_ZSTD_UNSUPPORTED')
    # Uncompressed tar: starts with a ustar header (magic at offset 257) for a non-empty archive.
    return bytes(blob)


def _norm(path):
    """Normalise a tar member path to an absolute, '..'-free rootfs path. Refuses traversal."""
    parts = []
    for part in path.replace('\\', '/').split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            raise AdapterRefusal('ROOTFS_TRAVERSAL')
        parts.append(part)
    return '/' + '/'.join(parts)


def materialize_rootfs(layer_paths, layer_media_types, diff_ids, read_bytes,
                       keep_prefixes=KEEP_PREFIXES):
    """Build the config-surface view of the rootfs from verified layer blobs. For each layer in order:
    read the blob, decompress, CHECK its uncompressed sha256 == diff_ids[i], then apply its members with
    whiteout semantics onto the accumulated view. Only files under keep_prefixes are retained (bounded
    memory); directories and whiteouts everywhere are still processed so deletions are honoured. Returns
    (files, dirs): files = {rootfs_path: bytes}; dirs = set of rootfs dir paths seen (for initdb order).
    """
    _check(len(layer_paths) == len(diff_ids), 'ROOTFS_LAYER_COUNT')
    files = {}
    present_dirs = set()
    total = 0
    for i, path in enumerate(layer_paths):
        blob = read_bytes(path)
        _check(isinstance(blob, (bytes, bytearray)), 'ROOTFS_LAYER_READ:' + str(i))
        media = layer_media_types[i] if i < len(layer_media_types) else None
        tar_bytes = _decompress_layer(blob, media)
        _check(_sha256_bytes(tar_bytes) == (diff_ids[i][7:] if diff_ids[i].startswith('sha256:')
               else diff_ids[i]), 'ROOTFS_DIFF_ID_MISMATCH:' + str(i))
        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode='r:') as tar:
            for member in tar:
                name = _norm(member.name)
                base = name.rsplit('/', 1)[-1]
                parent = name.rsplit('/', 1)[0] or '/'
                if base == '.wh..wh..opq':
                    # Opaque whiteout: drop everything previously under parent.
                    for existing in [p for p in files if p == parent or p.startswith(parent + '/')]:
                        del files[existing]
                    continue
                if base.startswith('.wh.'):
                    target = (parent + '/' + base[4:]).replace('//', '/')
                    for existing in [p for p in files
                                     if p == target or p.startswith(target + '/')]:
                        del files[existing]
                    continue
                if member.isdir():
                    present_dirs.add(name)
                    continue
                if not (member.isfile() or member.issym() or member.islnk()):
                    continue
                if not any(name == p or name.startswith(p.rstrip('/') + '/') for p in keep_prefixes):
                    # Not part of the retained config surface; a later layer may still whiteout it, which
                    # is handled above regardless of retention.
                    files.pop(name, None)
                    continue
                if member.issym() or member.islnk():
                    # Record a symlink target as metadata bytes; we never FOLLOW it (no traversal, no
                    # execution). A fact pointing at a symlink is reported, not dereferenced.
                    files[name] = ('@symlink:' + (member.linkname or '')).encode('utf-8')
                    present_dirs.add(parent)
                    continue
                extracted = tar.extractfile(member)
                data = extracted.read() if extracted is not None else b''
                _check(len(data) <= MAX_KEPT_FILE_BYTES, 'ROOTFS_FILE_TOO_LARGE:' + name)
                total += len(data)
                _check(total <= MAX_KEPT_TOTAL_BYTES, 'ROOTFS_SURFACE_TOO_LARGE')
                files[name] = data
                present_dirs.add(parent)
    return files, present_dirs


# ===================================================================================================
# 3. Fact extraction into an evidence_index + 0700 custody tree.
# ===================================================================================================
def _parse_includes(conf_bytes):
    """Return [(directive, target)] for include / include_if_exists / include_dir in a postgresql.conf.
    Comments (#...) are stripped; quoted targets are unquoted. No value is interpreted beyond locating
    the referenced path."""
    out = []
    for raw in conf_bytes.decode('utf-8', 'replace').splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        low = line.lower()
        for directive in ('include_if_exists', 'include_dir', 'include'):
            if low.startswith(directive):
                rest = line[len(directive):].strip()
                if rest.startswith('='):
                    rest = rest[1:].strip()
                target = rest.strip().strip("'\"")
                if target:
                    out.append((directive, target))
                break
    return out


def _resolve_conf_path(base_path, target):
    """Resolve an include target relative to the including file's directory, normalised to a rootfs
    absolute path. A target that is already absolute is used as-is."""
    if target.startswith('/'):
        return _norm(target)
    base_dir = base_path.rsplit('/', 1)[0] or '/'
    return _norm(base_dir + '/' + target)


def _scan_declared_gucs(conf_bytes, names):
    """Extract DECLARED `name = value` assignments for the given GUC names from one conf file. Returns
    {name: value_string}. These are static declarations only; the effective runtime value is NOT
    claimed (it may be overridden by other conf files, ALTER SYSTEM, or the command line)."""
    found = {}
    for raw in conf_bytes.decode('utf-8', 'replace').splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line or '=' not in line:
            # Postgres also accepts whitespace-separated; handle `name value`.
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0].lower() in names:
                found[parts[0].lower()] = parts[1].strip().strip("'\"")
            continue
        key, _, value = line.partition('=')
        key = key.strip().lower()
        if key in names:
            found[key] = value.strip().strip("'\"")
    return found


def _first_present(files, candidates):
    for path in candidates:
        if path in files and not files[path].startswith(b'@symlink:'):
            return path
    return None


def _emit_derived(evidence_dir, fact, obj, written):
    data = _canonical(obj)
    rel = os.path.join('derived', fact + '.json')
    abs_path = os.path.join(evidence_dir, rel)
    os.makedirs(os.path.dirname(abs_path), mode=0o700, exist_ok=True)
    with open(os.open(abs_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as handle:
        handle.write(data)
    written[rel] = _sha256_bytes(data)
    return abs_path, _sha256_bytes(data)


def _emit_file(evidence_dir, fact, rootfs_path, data, written):
    rel = os.path.join('rootfs', rootfs_path.lstrip('/'))
    abs_path = os.path.join(evidence_dir, rel)
    os.makedirs(os.path.dirname(abs_path), mode=0o700, exist_ok=True)
    with open(os.open(abs_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as handle:
        handle.write(data)
    written[rel] = _sha256_bytes(data)
    return abs_path, _sha256_bytes(data)


def extract_facts(files, present_dirs, oci_closure, evidence_dir):
    """Produce (evidence_index, report). evidence_index is exactly what read_startup_closure consumes:
    {fact: {'path': <abs path under evidence_dir>, 'sha256': ...}} for every obtainable-and-present fact,
    plus '_oci_closure'. report classifies each of the 11 facts: present / missing_in_rootfs /
    container_only. Container-only facts are WITHHELD from evidence_index by design."""
    os.makedirs(evidence_dir, mode=0o700, exist_ok=True)
    evidence_index = {}
    report = {'present': {}, 'missing_in_rootfs': {}, 'container_only': list(CONTAINER_ONLY_FACTS)}
    written = {}

    # -- CONFIG fact: image_entrypoint from the verified config blob --------------------------------
    if oci_closure.get('status') == 'OCI_CLOSURE_VERIFIED':
        obj = {'_fact': 'image_entrypoint', '_derivation': 'image config Entrypoint/Cmd',
               '_config_digest': oci_closure.get('config_digest'),
               'entrypoint': oci_closure.get('image_entrypoint'),
               'cmd': oci_closure.get('image_cmd')}
        _, digest = _emit_derived(evidence_dir, 'image_entrypoint', obj, written)
        evidence_index['image_entrypoint'] = {
            'path': os.path.join(evidence_dir, 'derived', 'image_entrypoint.json'), 'sha256': digest}
        report['present']['image_entrypoint'] = {'source': 'config', 'config_digest': obj['_config_digest']}
    else:
        report['missing_in_rootfs']['image_entrypoint'] = 'OCI closure not verified'

    # -- FILE facts: single rootfs files ------------------------------------------------------------
    for fact, candidates in FILE_FACTS.items():
        path = _first_present(files, candidates)
        if path is None:
            report['missing_in_rootfs'][fact] = 'none of ' + ', '.join(candidates) + ' present in rootfs'
            continue
        abs_path, digest = _emit_file(evidence_dir, fact, path, files[path], written)
        evidence_index[fact] = {'path': abs_path, 'sha256': digest}
        report['present'][fact] = {'source_rootfs_path': path, 'sha256': digest}

    # -- DERIVED: include chain ---------------------------------------------------------------------
    conf_path = _first_present(files, FILE_FACTS['postgresql_conf'])
    include_sources, include_targets, uncaptured = [], [], []
    if conf_path is not None:
        queue = [conf_path]
        seen = set()
        while queue:
            current = queue.pop(0)
            if current in seen or current not in files or files[current].startswith(b'@symlink:'):
                continue
            seen.add(current)
            include_sources.append({'path': current, 'sha256': _sha256_bytes(files[current])})
            for directive, target in _parse_includes(files[current]):
                resolved = _resolve_conf_path(current, target)
                entry = {'directive': directive, 'raw_target': target, 'resolved': resolved}
                if directive == 'include_dir':
                    members = sorted(p for p in files
                                     if p.startswith(resolved.rstrip('/') + '/')
                                     and p.endswith('.conf') and '/' not in p[len(resolved) + 1:])
                    entry['members'] = [{'path': p, 'sha256': _sha256_bytes(files[p])}
                                        for p in members if not files[p].startswith(b'@symlink:')]
                    if not members and not any(d == resolved or d.startswith(resolved + '/')
                                               for d in present_dirs):
                        uncaptured.append(resolved)
                    queue.extend(members)
                else:
                    if resolved in files and not files[resolved].startswith(b'@symlink:'):
                        queue.append(resolved)
                    elif directive == 'include':
                        uncaptured.append(resolved)
                include_targets.append(entry)
        obj = {'_fact': 'postgresql_conf_include_chain',
               '_derivation': 'include/include_dir/include_if_exists directives resolved within rootfs',
               'root_conf': conf_path, 'sources': include_sources, 'directives': include_targets,
               'uncaptured_targets': sorted(set(uncaptured))}
        _, digest = _emit_derived(evidence_dir, 'postgresql_conf_include_chain', obj, written)
        evidence_index['postgresql_conf_include_chain'] = {
            'path': os.path.join(evidence_dir, 'derived', 'postgresql_conf_include_chain.json'),
            'sha256': digest}
        report['present']['postgresql_conf_include_chain'] = {
            'source_count': len(include_sources), 'uncaptured': obj['uncaptured_targets']}
    else:
        report['missing_in_rootfs']['postgresql_conf_include_chain'] = 'postgresql.conf absent'

    # -- DERIVED: logging settings (declared/static) ------------------------------------------------
    if conf_path is not None:
        declared = {}
        sources = []
        for src in include_sources or [{'path': conf_path, 'sha256': _sha256_bytes(files[conf_path])}]:
            scanned = _scan_declared_gucs(files[src['path']], LOGGING_GUCS)
            if scanned:
                sources.append(src)
            # later files override earlier within the same declared chain order
            declared.update(scanned)
        obj = {'_fact': 'logging_settings',
               '_derivation': 'DECLARED (static) logging GUCs from the conf chain; NOT effective runtime',
               '_caveat': 'effective values require a running server (pg_settings/SHOW)',
               'declared': declared, 'sources': sources}
        _, digest = _emit_derived(evidence_dir, 'logging_settings', obj, written)
        evidence_index['logging_settings'] = {
            'path': os.path.join(evidence_dir, 'derived', 'logging_settings.json'), 'sha256': digest}
        report['present']['logging_settings'] = {'declared_keys': sorted(declared), 'static_only': True}
    else:
        report['missing_in_rootfs']['logging_settings'] = 'postgresql.conf absent'

    # -- DERIVED: initdb scripts order --------------------------------------------------------------
    initdb_entries = []
    initdb_dir_present = False
    for d in INITDB_DIRS:
        if d in present_dirs or any(p.startswith(d + '/') for p in files):
            initdb_dir_present = True
            members = sorted(p for p in files if p.startswith(d + '/')
                             and '/' not in p[len(d) + 1:])
            for p in members:
                entry = {'name': p[len(d) + 1:], 'path': p}
                if files[p].startswith(b'@symlink:'):
                    entry['symlink'] = files[p].decode('utf-8')[len('@symlink:'):]
                else:
                    entry['sha256'] = _sha256_bytes(files[p])
                initdb_entries.append(entry)
    if initdb_dir_present:
        obj = {'_fact': 'initdb_scripts',
               '_derivation': 'docker-entrypoint-initdb.d entries in the lexical order the entrypoint runs',
               'dir': INITDB_DIRS[0], 'order': initdb_entries}
        _, digest = _emit_derived(evidence_dir, 'initdb_scripts', obj, written)
        evidence_index['initdb_scripts'] = {
            'path': os.path.join(evidence_dir, 'derived', 'initdb_scripts.json'), 'sha256': digest}
        report['present']['initdb_scripts'] = {'count': len(initdb_entries)}
    else:
        report['missing_in_rootfs']['initdb_scripts'] = 'no docker-entrypoint-initdb.d in rootfs surface'

    # -- DERIVED: bootstrap superuser identity (declared/static) ------------------------------------
    entry_path = _first_present(files, FILE_FACTS['docker_entrypoint_script'])
    boot_sources, declared_tokens = [], []
    scan_paths = []
    if entry_path is not None:
        scan_paths.append(entry_path)
    scan_paths.extend(e['path'] for e in initdb_entries if 'sha256' in e)
    for p in scan_paths:
        text = files[p].decode('utf-8', 'replace')
        hits = sorted({tok for tok in BOOTSTRAP_TOKENS if tok in text})
        if hits:
            boot_sources.append({'path': p, 'sha256': _sha256_bytes(files[p]), 'tokens': hits})
            declared_tokens.extend(hits)
    if boot_sources:
        obj = {'_fact': 'bootstrap_superuser_identity',
               '_derivation': 'superuser-identity tokens DECLARED in entrypoint/initdb (static)',
               '_caveat': 'effective bootstrap identity confirmed only by the live run',
               'declared_tokens': sorted(set(declared_tokens)), 'sources': boot_sources}
        _, digest = _emit_derived(evidence_dir, 'bootstrap_superuser_identity', obj, written)
        evidence_index['bootstrap_superuser_identity'] = {
            'path': os.path.join(evidence_dir, 'derived', 'bootstrap_superuser_identity.json'),
            'sha256': digest}
        report['present']['bootstrap_superuser_identity'] = {'tokens': obj['declared_tokens'],
                                                             'static_only': True}
    else:
        report['missing_in_rootfs']['bootstrap_superuser_identity'] = \
            'no entrypoint/initdb bytes declaring a superuser identity'

    # -- OCI closure passthrough --------------------------------------------------------------------
    evidence_index['_oci_closure'] = oci_closure
    # Write a manifest of everything emitted, for custody.
    manifest_path = os.path.join(evidence_dir, 'evidence-manifest.json')
    with open(os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'wb') as handle:
        handle.write(_canonical({'written': written, 'config_digest': CONFIG_DIGEST}))
    report['container_only_note'] = (
        'shared_preload_libraries and supautils_gucs are the EFFECTIVE, running-server values; they are '
        'withheld so the closure stays OPEN_UNRESOLVED until the owner captures them from one live run.')
    return evidence_index, report


def make_reader():
    """read_bytes(path) -> bytes over the custody evidence tree (absolute paths the adapter emitted)."""
    def read_bytes(path):
        with open(path, 'rb') as handle:
            return handle.read()
    return read_bytes


def make_blob_reader(layout_dir):
    """read_bytes over an OCI layout directory on disk (for build_layout_index / verify)."""
    def read_bytes(path):
        with open(path, 'rb') as handle:
            return handle.read()
    return read_bytes


# ===================================================================================================
# 4. End-to-end offline build (no Docker, no network, no DB).
# ===================================================================================================
def build_closure_evidence(layout_dir, evidence_dir, read_bytes=None, image_ref=None):
    """From an OCI layout dir, produce (evidence_index, report, oci_closure). Fails closed if the layout
    does not content-address to the pinned CONFIG_DIGEST. Writes the custody evidence tree under
    evidence_dir. Executes nothing."""
    read_bytes = read_bytes or make_blob_reader(layout_dir)
    layout_index = build_layout_index(layout_dir, read_bytes, image_ref=image_ref)
    oci_closure = verify_layout(layout_index, read_bytes)
    _check(oci_closure.get('status') == 'OCI_CLOSURE_VERIFIED', 'OCI_NOT_VERIFIED:'
           + str(oci_closure.get('status')) + ':' + str(oci_closure.get('code') or ''))
    _check(oci_closure.get('config_digest') == CONFIG_DIGEST, 'OCI_CONFIG_PIN')
    manifest = json.loads(read_bytes(layout_index['manifest']))
    media_types = [d.get('mediaType') for d in manifest.get('layers', [])]
    diff_ids = oci_closure.get('diff_ids') or []
    files, present_dirs = materialize_rootfs(
        layout_index['layers'], media_types, diff_ids, read_bytes)
    evidence_index, report = extract_facts(files, present_dirs, oci_closure, evidence_dir)
    return evidence_index, report, oci_closure


def summarize(evidence_index, report, closure_result):
    """A compact, honest summary object for the custody record."""
    offered = sorted(k for k in evidence_index if k != '_oci_closure')
    return {
        'config_digest': CONFIG_DIGEST,
        'oci_closure_status': evidence_index.get('_oci_closure', {}).get('status'),
        'facts_offered_offline': offered,
        'facts_present': sorted(closure_result.present),
        'facts_missing': sorted(closure_result.missing),
        'container_only_withheld': list(CONTAINER_ONLY_FACTS),
        'closure_status': closure_result.status,
        'historical_status': 'NOT_REPRODUCED',
        'runtime_status': 'NOT_EXECUTED',
        'r3_status': 'OPEN',
        'missing_in_rootfs': report.get('missing_in_rootfs', {}),
    }


def main(argv):
    parser = argparse.ArgumentParser(description='Offline R3 closure-evidence adapter (no Docker/net/DB).')
    parser.add_argument('--layout', required=True, help='Path to the verified OCI layout directory.')
    parser.add_argument('--evidence-out', required=True, help='Custody evidence tree output dir (0700).')
    parser.add_argument('--image-ref', default=None, help='Optional ref.name to disambiguate roots.')
    args = parser.parse_args(argv)
    evidence_index, report, oci = build_closure_evidence(
        args.layout, args.evidence_out, image_ref=args.image_ref)
    closure = rc.read_startup_closure(evidence_index, make_reader())
    plan = rc.assemble_plan(closure)
    out = {'summary': summarize(evidence_index, report, closure),
           'closure': closure.to_json(),
           'report': report,
           'executable': plan['executable'],
           'blocking_reason': plan['blocking_reason']}
    json.dump(out, __import__('sys').stdout, indent=2, sort_keys=True)
    __import__('sys').stdout.write('\n')
    return 0 if not plan['executable'] else 0


if __name__ == '__main__':
    import sys
    sys.exit(main(sys.argv[1:]))

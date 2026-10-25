#!/usr/bin/env python3
"""Targeted call-site mutations in disposable source copies, one per worker. No cloud or Docker."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
# Exact anchors deliberately fail if source changes; unmatched/syntax errors are
# invalid mutations, never counted as killed tests.
MUTATIONS = []
def add(file, name, old, new): MUTATIONS.append((file, name, old, new))
def install(name, old, new): add('infra/scripts/r3_install.py', name, old, new)
def toolchain(name, old, new): add('infra/scripts/r3_toolchain.py', name, old, new)
def workflow(name, old, new): add('.github/workflows/r3-qualification.yml', name, old, new)

install('nonroot', 'os.geteuid() != 0', 'False')
install('platform', "platform.machine() != 'x86_64'", 'False')
install('os-version', "platform.freedesktop_os_release().get('VERSION_ID') != '24.04'", 'False')
install('os-name', "platform.freedesktop_os_release().get('ID') != 'ubuntu'", 'False')
install('ambient', "    if any(k.startswith(('APT_', 'DPKG_', 'LD_')) or k in ('PYTHONPATH', 'PYTHONHOME', 'DEBIAN_FRONTEND') for k in os.environ):", '    if False:')
install('root-ownership-call', 'bundle = safe_path(Path(bundle).absolute(), directory=True)', 'bundle = Path(bundle).absolute()')
install('entry-ownership-call', '        safe_path(path, directory=path.is_dir())', '        pass')
install('approval-hash', 'if digest(approval_bytes) != approved_hash:', 'if False:')
install('approval-bindings', 'if approval != expected:', 'if False:')
install('helper-location', "if Path(__file__).resolve().parent != bundle / 'helpers':", 'if False:')
install('contract-call', 'contract = validate_contract(json.loads(contract_bytes))', 'contract = json.loads(contract_bytes)')
install('imds-call', "        validate_identity(contract, json.load(response)['compute'])", '        pass')
install('replay-forbidden', 'if any(Path(p).exists() or Path(p).is_symlink() for p in forbidden):', 'if False:')
install('existing-packages', 'if probe.returncode == 0:', 'if False:')
install('closure-call', '    plan = dependency_plan(lock, paths, simulation)', "    plan = ''; simulation.update(stdout=b'', stderr=b'', returncode=0)")
install('pending-package-audit', "    if capture(['dpkg', '--audit']).strip():\n        raise ValueError('Pending or inconsistent package state refused.')", "    if False:\n        raise ValueError('Pending or inconsistent package state refused.')")
toolchain('plan-configured-versions', "            or {match.groups() for match in configured if match} != expected", '')
toolchain('plan-candidate-versions', "            or {match.groups() for match in planned if match} != expected", '')
install('archive-prewrite', '    check_node_archive(node)', '    pass')
install('node-directory-root', "member.name == root or member.name.startswith(root + '/')", "member.name.startswith(root + '/')")
install('archive-filter', "archive.extractall('/opt/tonyai-tools', filter='data')", "archive.extractall('/opt/tonyai-tools', filter='fully_trusted')")
install('attempt-journal', "    if policy is None:\n        write_new('/etc/tonyai/r3-install-attempt.json', encoded(expected))", '    if policy is None:\n        pass')
install('policy-content', "b'#!/bin/sh\\nexit 101\\n'", "b'#!/bin/sh\\nexit 0\\n'")
install('mask-call', "    capture(['systemctl', 'mask', *SERVICES])", '    pass')
install('runtime-mask', "['systemctl', 'mask', *SERVICES]", "['systemctl', 'mask', '--runtime', *SERVICES]")
install('post-install-masks', "    verify_masks()\n    Path('/opt/tonyai-tools')", "    Path('/opt/tonyai-tools')")
install('apt-exit', 'if process.returncode:', 'if False:')
install('package-readback', "if actual != [item['name'], item['version'], 'amd64', 'installed']:", 'if False:')
install('node-readback', "if capture(['/opt/tonyai-tools/node-v22.23.3-linux-x64/bin/node', '--version']).strip() != 'v22.23.3':", 'if False:')
install('package-holds', "    capture(['apt-mark', 'hold', *[item['name'] for item in lock['packages']]])", '    pass')
install('daemon-live-restore', "'live-restore': False", "'live-restore': True")
install('node-dir-modes', '            path.chmod(0o755)', '            pass')
toolchain('signed-outer-bytes', "not armored.startswith(begin + b'\\n') and not armored.startswith(begin + b'\\r\\n')", 'False')
toolchain('signed-suffix', "armored[armored.index(end) + len(end):] not in (b'', b'\\n', b'\\r\\n')", 'False')
toolchain('signer-count', 'len(valid) != 1', 'not valid')
toolchain('signer-fingerprint', "lock['docker_signing_fingerprint'] not in (valid[0][2], valid[0][-1])", 'False')
toolchain('index-sha256-section', "sections.get('SHA256', [])", "sections.get('SHA1', [])")
toolchain('node-hash', "if sha(node.read_bytes()) != lock['node']['sha256']:", 'if False:')
toolchain('package-signed-pin', "if len(matches) != 1 or matches[0].get('SHA256') != item['sha256']:", 'if not matches:')
toolchain('dependency-plan-count', 'len(planned) != len(expected)', 'False')
add('infra/scripts/r3_artifacts.py', 'fetch-digest', 'if expected is not None and sha(data) != expected:', 'if False:')
add('infra/scripts/r3_artifacts.py', 'fetch-redirect', "if not response.url.startswith('https://'):", 'if False:')
add('infra/scripts/r3_transfer.py', 'transfer-lock', "if (directory / 'r3-toolchain.lock.json').read_bytes() != reviewed:", 'if False:')
add('infra/scripts/r3_transfer.py', 'transfer-invocation', "['python3', '-I', '-B',", "['python3', '-I',")
add('infra/scripts/r3_transfer.py', 'transfer-apt', "'installer_internal_apt_argv': install_argv(packages, transaction_log='/etc/tonyai/r3-install.dpkg.log')", "'installer_internal_apt_argv': ['apt-get', 'install', *packages]")
add('infra/scripts/r3_artifacts.py', 'stage-clean-source', '    source_sha = clean_source()', "    source_sha = git('rev-parse', 'HEAD').decode().strip()")
add('infra/scripts/r3_artifacts.py', 'stage-helper-allowlist', '    for name in HELPERS:', "    for name in HELPERS + ('private.json',):")
q = 'infra/scripts/r3_qualification.py'
add(q, 'bind-default-version-gate', "if compose_version == '2.38.2':", 'if True:')
add(q, 'bind-default-type-gate', "volume.get('type') == 'bind' and isinstance(bind, dict)", 'isinstance(bind, dict)')
add(q, 'bind-default-overwrites-true', "bind.setdefault('create_host_path', False)", "bind['create_host_path'] = False")
add(q, 'bind-default-normalization-missing', "bind.setdefault('create_host_path', False)", 'pass')
add(q, 'bind-default-input-mutation', 'normalized = copy.deepcopy(config)', 'normalized = config')
add(q, 'bind-default-version-forwarding', "check_effective(config, lock, compose_version=versions['compose'])", 'check_effective(config, lock)')
add(q, 'effective-boundary-validator', '    validate(config)', '    pass')
add(q, 'empty-runner', "if capture(DOCKER + ['ps', '-aq']).strip() or Path('/srv/tonyai').exists():", 'if False:')
add(q, 'image-identity', "if meta['Architecture'] != 'amd64' or meta['Os'] != 'linux' or item['image'] not in meta['RepoDigests']:", 'if False:')
add(q, 'db-policy', "if lock['db']['image'] != policy['image'] or images['db'] != policy['config_digest']:", 'if False:')
add(q, 'health', "if not state['Running'] or state.get('Health', {}).get('Status', 'healthy') != 'healthy':", 'if False:')
add(q, 'public-source-files', "            path.chmod(0o755 if path.name.endswith('entrypoint.sh') else 0o644)", '            pass')
add(q, 'public-source-directories', '            path.chmod(0o755)', '            pass')
add(q, 'cleanup', "        capture(compose() + ['down', '--timeout', '30'])", '        pass')
add(q, 'smoke-cli-failure-exit', '        return 1', '        return 0')
add(q, 'smoke-cli-arity', '        if len(argv) != 2:', '        if False:')
add(q, 'smoke-exception-leak', '        print(status.failure(), file=sys.stderr)', '        print(sys.exc_info()[1], file=sys.stderr)')
add(q, 'smoke-child-output-leak', '    if result.returncode:', '    print(result.stdout, result.stderr)\n    if result.returncode:')
add(q, 'smoke-premature-summary', "    finally:\n        # Only this project; never global prune, volume deletion or DB reset.",
    "        write(output / 'summary.json', json.dumps(report, indent=2).encode())\n    finally:\n        # Only this project; never global prune, volume deletion or DB reset.")
status = 'infra/scripts/r3_smoke_status.py'
add(status, 'smoke-phase-attribution', '        self.phase = phase', "        self.phase = 'ARGUMENTS'")
add(status, 'smoke-primary-failure', '            if unwinding:', '            if False:')
add(status, 'smoke-cleanup-failure-state', "            setattr(self, field, 'FAILED')", "            setattr(self, field, 'SUCCEEDED')")
add(status, 'smoke-cleanup-success-state', "            setattr(self, field, 'SUCCEEDED')", "            setattr(self, field, 'NOT_STARTED')")
add(status, 'smoke-cleanup-suppressed', "            setattr(self, field, 'FAILED')\n            raise", "            setattr(self, field, 'FAILED')\n            pass")
add(status, 'smoke-public-phase-allowlist', "self.phase if self.phase in PHASES else 'UNKNOWN'", 'self.phase')
add(status, 'smoke-public-cleanup-allowlist', "self.compose_cleanup if self.compose_cleanup in CLEANUP_STATES else 'UNKNOWN'", 'self.compose_cleanup')
workflow('automatic-trigger', '  workflow_dispatch:', '  push:\n  workflow_dispatch:')
workflow('write-permissions', '  contents: read', '  contents: write')
workflow('job-runner-context', '    timeout-minutes: 35', '    timeout-minutes: 35\n    env:\n      DOCKER_CONFIG: ${{ runner.temp }}/unsafe')
workflow('upload-runtime', '      - name: Publish status-only smoke report', '      - uses: actions/upload-artifact@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n      - name: Publish status-only smoke report')
workflow('source-sha-github', '          test "$REVIEWED_SHA" = "$GITHUB_SHA"', '          true # no dispatch binding')
workflow('source-sha-checkout', '          test "$(git rev-parse HEAD)" = "$REVIEWED_SHA"', '          true # no checkout binding')
workflow('source-sha-format', '          [[ "$REVIEWED_SHA" =~ ^[a-f0-9]{40}$ ]]', '          true # no format binding')
toolchain('receipt-source-map', "    if manifest['files'] != expected:", '    if False:')
toolchain('receipt-verifier-call', '    lock, _ = verify_toolchain_snapshot(directory, manifest, lock_bytes, sha(approved_lock))',
          '    lock = json.loads(lock_bytes)')
toolchain('receipt-manifest-snapshot', "'manifest_sha256': sha(manifest_bytes)", "'manifest_sha256': sha((directory / 'manifest.json').read_bytes())")
toolchain('receipt-lock-snapshot', "'lock_sha256': sha(lock_bytes)", "'lock_sha256': sha((directory / 'r3-toolchain.lock.json').read_bytes())")
toolchain('receipt-arity', '        if len(sys.argv) != 3:', '        if False:')
toolchain('receipt-cli-success-on-failure', "        raise SystemExit('FAIL: vendor verification refused; no receipt accepted.')",
          "        print('FAIL: vendor verification refused; no receipt accepted.', file=sys.stderr)")
toolchain('receipt-source-value', "'source_sha': source,", "'source_sha': 'f' * 40,")
toolchain('receipt-extra-acceptance', "'qa_ready': False, 'install_authorized': False,", "'qa_ready': False, 'install_authorized': False, 'accepted': True,")
toolchain('receipt-fingerprint', "'docker_signing_fingerprint': lock['docker_signing_fingerprint'],", "'docker_signing_fingerprint': 'F' * 40,")
toolchain('receipt-package-hash', "for key in ('name', 'version', 'architecture', 'sha256')", "for key in ('name', 'version', 'architecture')")
toolchain('receipt-node-hash', "for key in ('version', 'sha256')", "for key in ('version',)")
toolchain('receipt-missing-gate', "'Private database regression', 'Realtime source and GCM consumer',", "'Private database regression',")
toolchain('receipt-empty-gates', "    if clean_source() != source:", "    report['unproven'] = []\n    if clean_source() != source:")
workflow('receipt-workflow-ignore-error', '          python3 -I -B infra/scripts/r3_toolchain.py "$R3_BUNDLE" "$RUNNER_TEMP/r3-vendor-receipt.json"',
         '          python3 -I -B infra/scripts/r3_toolchain.py "$R3_BUNDLE" "$RUNNER_TEMP/r3-vendor-receipt.json" || true')
workflow('receipt-workflow-continue', '      - name: Verify signatures and package control metadata without installing',
         '      - name: Verify signatures and package control metadata without installing\n        continue-on-error: true')
workflow('receipt-workflow-path', 'infra/scripts/r3_toolchain.py "$R3_BUNDLE" "$RUNNER_TEMP/r3-vendor-receipt.json"',
         'infra/scripts/r3_toolchain.py "$R3_BUNDLE" "$RUNNER_TEMP/different.json"')
workflow('receipt-workflow-nonempty', '          test -s "$RUNNER_TEMP/r3-vendor-receipt.json"', '          true # missing receipt accepted')
add('infra/scripts/selfhost_init.mjs', 'import-output-argument', 'existsSync(process.argv[1]) && ', '')
add('infra/scripts/selfhost_init.mjs', 'symlink-entry', 'realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)', 'process.argv[1] === fileURLToPath(import.meta.url)')

# Cross-lane fix round: local fixture guards, not live installation proof.
I, T, P, O, G, SP, W = ('infra/scripts/r3_install.py', 'infra/scripts/r3_toolchain.py', 'infra/scripts/r3_package_evidence.py',
    'infra/scripts/r3_image_transport.py', 'infra/scripts/r3_guard_files.py', 'infra/scripts/r3_source_plan.py',
    '.github/workflows/r3-offline-inputs.yml')
# Installer / plan
add(I, 'receipt-after-completion', "    write_new('/etc/tonyai/r3-installed-receipt.json', encoded(receipt))\n    write_new('/etc/tonyai/r3-install-complete.json', encoded(expected))",
    "    write_new('/etc/tonyai/r3-install-complete.json', encoded(expected))\n    write_new('/etc/tonyai/r3-installed-receipt.json', encoded(receipt))")
add(I, 'plan-file-not-retained', "    write_new('/etc/tonyai/r3-install-plan.txt', plan.encode())\n", '')
add(I, 'receipt-node-hash-from-archive-constant', "'sha256': digest(node_binary.read_bytes()),", "'sha256': lock['node']['sha256'],")
add(T, 'plan-conf-count', 'or any(match is None for match in configured) or len(configured) != len(expected)', 'or any(match is None for match in configured)')
add(T, 'plan-inst-old-version-allowed', r"re.fullmatch(r'Inst ([a-z0-9.+-]+) \(([^ ()]+)(?: [^()]*)?\)', line)", r"re.fullmatch(r'Inst ([a-z0-9.+-]+) (?:\[[^]]*\] )?\(([^ ()]+)(?: [^()]*)?\)', line)")
# Package evidence (inspect untested?)
add(P, 'pkg-archive-hash', "if path.is_symlink() or not path.is_file() or digest(path.read_bytes()) != item['sha256']:", 'if False:')
add(P, 'pkg-control-identity', "if [metadata[k] for k in ('Package', 'Version', 'Architecture')] != [item['name'], item['version'], 'amd64']:", 'if False:')
add(P, 'pkg-ar-layout', "if names != ['debian-binary', 'control.tar.xz', 'data.tar.xz']:", 'if False:')
add(P, 'pkg-node-unique', 'if len(matches) != 1 or not matches[0].isfile():', 'if not matches:')
add(P, 'pkg-node-path', "node_path = 'node-v22.23.3-linux-x64/bin/node'", "node_path = 'node-v22.23.3-linux-x64/bin/npm'")
add(P, 'pkg-drop-predepends', "('Depends', 'Pre-Depends', 'Provides', 'Conflicts', 'Breaks', 'Replaces')", "('Depends', 'Provides', 'Conflicts', 'Breaks', 'Replaces')")
add(P, 'pkg-continuation-dropped', "            result[key] += '\\n' + line\n", '')
add(P, 'pkg-closure-claim', "'dependency_closure': 'OPEN'", "'dependency_closure': 'PASS'")
# OCI transport
add(O, 'oci-config-platform', "if (config.get('os'), config.get('architecture'), config.get('variant', '')) != ('linux', 'amd64', ''):", 'if False:')
add(O, 'oci-diffid-count', 'if len(diff_ids) != len(manifest[\'layers\']) or any(not re.fullmatch(r\'sha256:[a-f0-9]{64}\', x) for x in diff_ids):', 'if False:')
add(O, 'oci-layout-version', "if document(layout_bytes) != {'imageLayoutVersion': '1.0.0'}:", 'if False:')
add(O, 'oci-twelve-service-lock', "if set(lock) != ACTIVE | {'caddy', 'functions', 'supavisor'}:", 'if False:')
add(O, 'oci-archive-mtime', 'info.size, info.mode, info.mtime = path.stat().st_size, 0o600, 0', 'info.size, info.mode, info.mtime = path.stat().st_size, 0o600, int(path.stat().st_mtime)')
add(O, 'oci-post-pack-revalidation', '    if verify(layout, lock) != (images, names, hashes):', '    if False:')
add(O, 'oci-empty-layers', "if config.get('rootfs', {}).get('type') != 'layers' or not manifest['layers']:", "if config.get('rootfs', {}).get('type') != 'layers':")
add(O, 'oci-layer-media', "        blob(layer, LAYERS)", "        blob(layer, LAYERS | MANIFESTS | INDEXES | CONFIGS)")
# Guard renderer
add(G, 'guard-ssh-root-login', "PermitRootLogin no", "PermitRootLogin yes")
add(G, 'guard-ssh-password', "PasswordAuthentication no", "PasswordAuthentication yes")
add(G, 'guard-mount-execstartpre', "ExecStartPre=/usr/local/sbin/tonyai-runtime-guard\n", '')
add(G, 'guard-runtime-mode', "(Path(__file__).with_name('selfhost_runtime_guard.py').read_bytes(), 0o755)", "(Path(__file__).with_name('selfhost_runtime_guard.py').read_bytes(), 0o644)")
add(G, 'guard-identity-wantedby', "WantedBy=multi-user.target\n", '')
# Source plan
add(SP, 'plan-gateway-redaction', '%RESPONSE_CODE% %BYTES_RECEIVED% %BYTES_SENT% %DURATION%', '%RESPONSE_CODE% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%')
add(SP, 'plan-gateway-template-pin', "if digest(data) != upstream['files'][template]:", 'if False:')
add(SP, 'plan-node-mode', "value, mode, origin = node_binary_hash, 0o755, 'pinned archive member; caller supplied hash'", "value, mode, origin = node_binary_hash, 0o644, 'pinned archive member; caller supplied hash'")
add(SP, 'plan-daemon-bytes', "generated['/etc/docker/daemon.json'] = (encoded(DAEMON), 0o600)", "generated['/etc/docker/daemon.json'] = (json.dumps(DAEMON).encode(), 0o600)")
add(SP, 'plan-node-hash-format', "if not re.fullmatch('[a-f0-9]{64}', node_binary_hash):", 'if False:')
add(SP, 'plan-bootstrap-ready', "'bootstrap_status': 'NOT_READY_FOR_BOOTSTRAP_APPROVAL'", "'bootstrap_status': 'READY'")
# Offline-input workflow
add(W, 'wf-reviewed-sha-from-github', 'REVIEWED_SHA: ${{ inputs.source_sha }}', 'REVIEWED_SHA: ${{ github.sha }}')
add(W, 'wf-clean-tree-assert', "          assert not subprocess.check_output(['git', 'status', '--porcelain']).strip()\n", '')
add(W, 'wf-binding-files', "'files': files,", '')
add(W, 'wf-artifact-name', 'name: r3-offline-inputs-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}', 'name: r3-offline-inputs')
add(W, 'wf-heredoc-isolation', 'python3 -I -B - <<', 'python3 - <<')
add(W, 'wf-source-plan-no-runtime', "prepare(report['node']['binary_sha256'], output / 'source-plan.json', bundle / 'runtime')", "prepare(report['node']['binary_sha256'], output / 'source-plan.json')")
add(W, 'wf-source-input-optional', '        required: true\n', '        required: false\n')
add(W, 'wf-qa-ready-claim', "'qa_ready': False, 'install_authorized': False}", "'qa_ready': True, 'install_authorized': False}")

add(T, 'plan-no-remove', "'--no-download', '--no-remove',", "'--no-download',")
add(T, 'plan-purg-action', "        raise ValueError('Unreviewed APT action or informational line.')", "        if line.startswith('Purg '): continue\n        raise ValueError('Unreviewed APT action or informational line.')")
add(T, 'plan-unknown-action', "        raise ValueError('Unreviewed APT action or informational line.')", "        if line.startswith('Foo '): continue\n        raise ValueError('Unreviewed APT action or informational line.')")
add(T, 'plan-summary-removal', '0 to remove and [0-9]+ not upgraded', '[0-9]+ to remove and [0-9]+ not upgraded')
add(O, 'oci-duplicate-keys', 'if key.casefold() in folded:', 'if False:')
add(O, 'oci-casefold-keys', 'if key.casefold() in folded:', 'if key in result:')
add(O, 'oci-index-keys', "    keys(index, ('schemaVersion', 'manifests'), ('mediaType',))", '    pass')
add(O, 'oci-descriptor-keys', "    keys(value, ('digest', 'size', 'mediaType'), ('annotations', 'platform'))", '    pass')
add(O, 'oci-annotation-keys', "        keys(value.get('annotations'), ('org.opencontainers.image.ref.name',))", '        pass')
add(O, 'oci-content-shape', "    keys(value, required, ('mediaType', 'annotations'))", '    pass')
add(O, 'oci-content-media', " or value.get('mediaType', media) != media", '')
add(O, 'oci-platform-alias', "            raise ValueError('Noncanonical platform alias.')", '            pass')
add('infra/scripts/replacement_host.py', 'host-generated-gateway-check', "        if generated.read_text() != ''.join(lines):", '        if False:')
for name in ('r3-installed-receipt.json', 'r3-install-complete.json', 'r3-install-plan.txt',
             'r3-install.stdout.log', 'r3-install.stderr.log', 'docker-packages.txt'):
    add(I, 'prewrite-' + name, "'" + name + "'", "'unused-" + name + "'")
add(W, 'wf-source-binding', "'source_sha': source,", "'source_sha': 'f' * 40,")
add(W, 'wf-workflow-binding', "'workflow_sha256': hashlib.sha256(Path('.github/workflows/r3-offline-inputs.yml').read_bytes()).hexdigest(),", "'workflow_sha256': 'f' * 64,")
add(W, 'wf-source-assert', "          assert source == os.environ['GITHUB_SHA']", '          pass')

add('infra/scripts/replacement_host.py', 'host-legacy-entrypoint', "'r3_guard_files.py'", "'selfhost_host_guard.sh'")
add(O, 'oci-root-platform', "    if root and 'platform' in value and value['platform'] != {'os': 'linux', 'architecture': 'amd64'}:", '    if False:')

add(O, 'oci-upstream-annotation-keys', '    keys(value, (), UPSTREAM_ANNOTATIONS)', '    pass')
add(O, 'oci-upstream-annotation-values', '    if any(not isinstance(item, str) for item in value.values()):', '    if False:')

add(O, 'oci-config-media', "        if config.get('mediaType', manifest['config']['mediaType']) != manifest['config']['mediaType']:", '        if False:')
add(O, 'oci-root-digest-binding', "        if ref.split('@')[-1] != entry['digest']:", '        if False:')

# Inventory/observation guards: synthetic discriminating faults, not guest proof.
PS = 'infra/scripts/r3_package_state.py'
AO = 'infra/scripts/r3_apt_observer.py'
add(PS, 'inventory-duplicate', '        if key in result:', '        if False:')
add(PS, 'inventory-existing-any-arch', "    if any(row['name'] in targets for row in before.values()):", '    if False:')
add(PS, 'inventory-exact-set', 'set(after) != set(before) | set(pins)', 'False')
add(PS, 'inventory-unchanged-existing', '    if any(after[key] != row for key, row in before.items()):', '    if False:')
add(PS, 'inventory-pin-version', "pin['name'], 'amd64', pin['version'], 'hold ok installed'", "pin['name'], 'amd64', row['version'], 'hold ok installed'")
add(PS, 'inventory-hold-metadata', '    if final != expected:', '    if False:')
# Removing the install-set check alone is equivalent: full configure coverage
# plus configure-requires-install still proves it. Exercise both bypassed guards.
install_coverage = """        if action == 'configure' and name not in actions['install']:
            raise ValueError('Dpkg configure precedes install.')
        actions[action][name] = pins[name]
    if (set(actions['install']) != set(pins)"""
add(PS, 'transaction-install-coverage', install_coverage,
    install_coverage.replace("action == 'configure' and name not in actions['install']", 'False')
                    .replace("set(actions['install']) != set(pins)", 'False'))
add(PS, 'transaction-complete-configures', "set(actions['configure']) != set(pins)", 'False')
add(PS, 'transaction-terminal-status', "states != {name: 'installed' for name in pins}", 'False')
add(PS, 'transaction-install-old-version', "('<none>', pins[name]) if action == 'install'", "(old, pins[name]) if action == 'install'")
add(PS, 'transaction-configure-version', "else (pins[name], '<none>')", "else (old, '<none>')")
add(PS, 'transaction-duplicate-action', " or name in actions[action]", '')
add(PS, 'transaction-configure-order', "        if action == 'configure' and name not in actions['install']:", '        if False:')
add(AO, 'observation-active', " or fields['ActiveState'] != 'inactive'", '')
add(AO, 'observation-persistent-mask', "fields['UnitFileState'] != 'masked'", 'False')
add(AO, 'observation-pending-job', " or fields['Job'] != ''", '')
add(AO, 'observation-main-pid', "or fields.get('MainPID', '0') != '0'", 'or False')
add(AO, 'observation-transition', "    if baseline is not None and observation['units'] != baseline['units']:", '    if False:')
add(AO, 'observation-foreign-process', "        if child is None or item['pgrp'] != child['pid']:", '        if False:')
add(AO, 'observation-reused-pid', "current != child or current['pgrp'] != child['pid']", "current['pgrp'] != child['pid']")
add(AO, 'observation-lock-probe', '            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)', '            pass')
add(AO, 'observation-no-process-scan', '    found = processes()', '    found = []')
install('inventory-pre-execute', '    if inventory(pre_execute_raw) != before:', '    if False:')
install('inventory-post-diff', '    diff = inventory_diff(before, after, lock)', "    diff = {}")
install('inventory-final-holds', '    held_inventory(after, final, lock)', '    pass')
install('transaction-log-validation', '    observed_actions = transaction(private_read(transaction_path).decode(), lock)', '    observed_actions = {}')
install('observation-validation', '        validate_observation(observed, initial_state, child)', '        pass')
install('observation-during-apt', "                sample('apt-running', child)", '                pass')
install('receipt-stdout-binding', "'stdout_sha256': digest(private_read('/etc/tonyai/r3-install.stdout.log'))", "'stdout_sha256': 'f' * 64")
install('receipt-stderr-binding', "'stderr_sha256': digest(private_read('/etc/tonyai/r3-install.stderr.log'))", "'stderr_sha256': 'f' * 64")
install('receipt-dpkg-binding', "'dpkg_log_sha256': digest(private_read(transaction_path))", "'dpkg_log_sha256': 'f' * 64")

# Coupled native-contract fixes: explicit non-PTY execution and native Job=.
toolchain('dpkg-pty-option', ", '-o', 'Dpkg::Use-Pty=0'", '')
add(AO, 'observation-zero-job-accepted', "fields['Job'] != ''", "fields['Job'] not in ('', '0')")

# Bounded collector review regression gate; synthetic inputs only.
add('infra/scripts/r3_policy_scope.py', 'policy-physical-line-comments', ', normalized(apt28_comment_view(raw))', '')
add('infra/scripts/r3_policy_scope.py', 'policy-reload-no', "item['NeedDaemonReload'] != 'no' or ", '')
add('infra/scripts/r3_policy_validate.py', 'policy-stderr', "good = blob(item['stderr'], 2 * 1024 * 1024) == b''", 'good = True')
add('infra/scripts/r3_policy_evidence.py', 'policy-path-stderr', " or value['stderr']['bytes'] != 0", '')
add('infra/scripts/r3_policy_validate.py', 'policy-cat-body', 'complete &= raw == expected_text', 'complete &= True')
add('infra/scripts/r3_policy_validate.py', 'policy-paths-crosscheck', "complete &= unit_paths(blob(sections[name]['value']['stdout'], 2 * 1024 * 1024)) == unit['paths']", 'complete &= True')
add('infra/scripts/r3_policy_validate.py', 'policy-apt-file', "complete &= sections.get('file:' + path) == {'state': 'ok', 'value': item}", 'complete &= True')
add('infra/scripts/r3_policy_validate.py', 'policy-fixed-unit', "complete &= sections['file:' + path] == {'state': 'ok', 'value': item}", 'complete &= True')
add('infra/scripts/r3_policy_validate.py', 'policy-scope-check-apt', '        check_apt(value)', '        pass')
add('infra/scripts/r3_policy_target.py', 'policy-proposal-imds', "or before['imds'] != proposal['target']['imds']", 'or False')
add('infra/scripts/r3_policy_validate.py', 'policy-os-release', "re.findall(rb'^ID=(.*)$', raw, re.M) == [b'ubuntu']", 'True')
add('infra/scripts/r3_policy_validate.py', 'policy-os-version', 're.findall(rb\'^VERSION_ID=(.*)$\', raw, re.M) == [b\'"24.04"\']', 'True')
add('infra/scripts/r3_policy_evidence.py', 'policy-unknown-read', '            if not reviewed_member(path, name, kernels):', '            if False:')
add('infra/scripts/r3_policy_evidence.py', 'policy-drift', 'elif again != section:', 'elif False:')
add('infra/scripts/r3_policy_evidence.py', 'policy-deadline-class', 'class CollectionDeadline(BaseException):', 'class CollectionDeadline(Exception):')
add('infra/scripts/r3_policy_evidence.py', 'policy-reread-deadline', "        if time.monotonic() >= deadline:\n            sections[name] = {'state': 'error', 'error': 'TimeoutError', 'prior': section['value']}\n            checkpoint(value)\n            continue", '        if False:\n            continue')
add('infra/scripts/r3_policy_capture.py', 'policy-path-recheck', "            same(before, observed('stat-path', os.stat, Path(path).name, dir_fd=parent, follow_symlinks=False))", '            pass')
add('infra/scripts/r3_policy_capture.py', 'policy-length-recheck', 'if len(data) != before.st_size:', 'if False:')
add('infra/scripts/r3_policy_receive.py', 'policy-packet-path', "and approval.get('packet_path') == str(packet.resolve())", 'and True')
add('infra/scripts/r3_policy_receive.py', 'policy-payload', 'require(guest == payload(proposal))', 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-region', "require(target['imds']['location'] == 'SwedenCentral')", 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-vm-id', "control['vm_id'] == target['imds']['resourceId']", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-index', "require(index == {'proposal_sha256': digest(proposal_bytes), 'guest_sha256': digest(guest),\n                      'state': 'PREPARED_UNAPPROVED_UNEXECUTED'})", 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-host-name', 'fields[0] == host', 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-host-fingerprint', "fresh['host_key_fingerprint'] == host_fingerprint", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-update-hostkeys', "'UpdateHostKeys=no'", "'UpdateHostKeys=yes'")
add('infra/scripts/r3_policy_git.py', 'policy-replace-objects', "['git', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', str(root), *args]", "['git', '-C', str(root), *args]")
add('infra/scripts/r3_policy_git.py', 'policy-git-env', 'env=env, timeout=10', 'timeout=10')
add('infra/scripts/r3_policy_git.py', 'policy-ignored-cache', "or git(root, 'status', '--porcelain', '--ignored', '--untracked-files=all',\n                   '--', 'infra/scripts', 'infra/selfhost')", 'or False')
add('infra/scripts/r3_policy_git.py', 'policy-blob', "if digest(git(root, 'show', head + ':' + name)) != expected:", 'if False:')
add('infra/scripts/r3_policy_packet.py', 'policy-source-cache', '    sys.pycache_prefix = _source_cache.name', '    pass')
add('infra/scripts/r3_policy_receive.py', 'policy-source-cache', '    sys.pycache_prefix = _source_cache.name', '    pass')
add('infra/scripts/r3_noble_guest.py', 'policy-partial-hashes', "result['checks'].update(status='PARTIAL_REVIEW_REQUIRED', policy_input_hashes={})", "result['checks'].update(status='PARTIAL_REVIEW_REQUIRED')")
add('infra/scripts/r3_noble_fixture.py', 'policy-partial-readback-hashes', "checked.update(status='PARTIAL_REVIEW_REQUIRED', policy_input_hashes={})", "checked.update(status='PARTIAL_REVIEW_REQUIRED')")
add('infra/scripts/r3_noble_guest.py', 'policy-route-fallback', '    except Exception:\n        return 1\n    if purpose', '    except Exception:\n        return installation_main()\n    if purpose')
add('infra/scripts/r3_noble_guest.py', 'policy-route-purpose', "if manifest['purpose'] not in allowed_purposes:", 'if False:')

add('infra/scripts/r3_policy_git.py', 'policy-fsmonitor', "'-c', 'core.fsmonitor=false', ", '')

add('infra/scripts/r3_policy_receive.py', 'policy-transport-failure', "disposition['failure'] is not None or disposition['cleanup_errors']", "False or disposition['cleanup_errors']")
add('infra/scripts/r3_policy_receive.py', 'policy-cleanup-failure', "or disposition['cleanup_errors']", 'or False')
add('infra/scripts/r3_policy_receive.py', 'policy-transport-exit', "disposition['returncode'] != 0 or interrupted", 'False or interrupted')
add('infra/scripts/r3_policy_receive.py', 'policy-transport-signal', "or disposition['returncode'] != 0 or interrupted", "or disposition['returncode'] != 0 or False")
add('infra/scripts/r3_policy_receive.py', 'policy-transport-hashes', "checked.update(status='PARTIAL_REVIEW_REQUIRED', policy_input_hashes={})", "checked.update(status='PARTIAL_REVIEW_REQUIRED')")
add('infra/scripts/r3_policy_receive.py', 'policy-status-exit', "return 0 if summary['sealed'] and summary['status'] == 'COLLECTED_REVIEW_REQUIRED' else 2", "return 0 if summary['sealed'] else 2")
add('infra/scripts/r3_noble_fixture.py', 'policy-frame-files', 'or set(entries) != COLLECTION_FILES', 'or False')
add('infra/scripts/r3_noble_fixture.py', 'policy-checks-readback', "result.get('checks') != checked or result.get('status') != expected_status", "False or result.get('status') != expected_status")
add('infra/scripts/r3_noble_guest.py', 'policy-manifest-policy-file', "or 'installation-policy.json' in manifest['files']):\n        raise ValueError('Collection cannot carry installation policy')", "or False):\n        raise ValueError('Collection cannot carry installation policy')")
add('infra/scripts/r3_noble_inputs.py', 'policy-stage-policy', 'if collection_only and policy_bytes is not None:', 'if False:')
add('infra/scripts/r3_noble_fixture.py', 'policy-controller-policy', "or (purpose == 'policy-collection' and policy_bytes is not None)", 'or False')
add('infra/scripts/r3_noble_fixture.py', 'policy-collection-exit', "('DIAGNOSTIC_PASS_REVIEW_REQUIRED', 'COLLECTED_REVIEW_REQUIRED', 'DIAGNOSTIC_OBSERVED_REVIEW_REQUIRED') and summary['sealed']", "('DIAGNOSTIC_PASS_REVIEW_REQUIRED',) and summary['sealed']")

# Independent re-review: program configuration and isolated authority/scope guards.
add('infra/scripts/r3_policy_git.py', 'policy-program-config-call', '    refuse_program_config(root)\n', '    pass\n')
add('infra/scripts/r3_policy_git.py', 'policy-filter-config', "'filter.', ", '')
add('infra/scripts/r3_policy_git.py', 'policy-info-attributes-size', 'or info.st_size != 0', 'or False')
add('infra/scripts/r3_policy_git.py', 'policy-no-lazy-fetch', "'GIT_NO_LAZY_FETCH': '1', ", '')
add('infra/scripts/r3_policy_validate.py', 'policy-apt-directory', "complete &= sections['directory:/etc/apt/apt.conf.d'] == {'state': 'ok', 'value': apt['directory']}", 'complete &= True')
add('infra/scripts/r3_policy_receive.py', 'policy-approval-digest', 'require(digest(approval_data) == expected_hash)', 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-approval-attempt-count', "and approval['attempts'] == 1", 'and True')
add('infra/scripts/r3_policy_receive.py', 'policy-owner-reference-bound', '<= 2000', '<= 20000')
add('infra/scripts/r3_policy_receive.py', 'policy-source-files', "source['files'] == sources()", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-source-map', "source['sha256'] == digest(encoded(source['files']))", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-published-head', "require(verified_head(ROOT, source['files']) == source['published_sha'])", "require(verified_head(ROOT, source['files']) is not None)")
add('infra/scripts/r3_policy_receive.py', 'policy-custody-digest', "require(digest(read(custody[key], 32 * 1024 * 1024)) == custody[key + '_sha256'])", 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-recipient-digest', "    recipient(custody['recipient'], custody['recipient_sha256'])", '    pass')
add('infra/scripts/r3_policy_receive.py', 'policy-agent-socket', "require(stat.S_ISSOCK(os.stat(os.environ.get('SSH_AUTH_SOCK', '')).st_mode))", 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-fresh-digest', "require(digest(fresh_bytes) == approval['fresh_control_plane_readback_sha256'])", 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-fresh-schema', "require(set(fresh) == {'observed_at', 'target', 'host_key_fingerprint'})", 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-fresh-future', '0 <= age <= 900', 'age <= 900')
add('infra/scripts/r3_policy_receive.py', 'policy-fresh-expired', '0 <= age <= 900', '0 <= age')
add('infra/scripts/r3_policy_receive.py', 'policy-fresh-target', "fresh['target'] == target", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-control-schema', "set(target['control_plane']) ==\n            {'tenant', 'subscription', 'vm_id', 'vm_uuid', 'location', 'image', 'disks', 'public_ip', 'private_ip', 'network'}", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-control-presence', 'require(all(control[k] for k in control))', 'require(True)')
add('infra/scripts/r3_policy_receive.py', 'policy-control-uuid', "control['vm_uuid'] == target['imds']['vmId']", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-control-subscription', "control['subscription'] == target['imds']['subscriptionId']", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-control-location', "control['location'] == 'swedencentral'", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-control-location-casefold', "control['location'] == 'swedencentral'", "control['location'].lower() == 'swedencentral'")
add('infra/scripts/r3_policy_receive.py', 'policy-region-casefold', "require(target['imds']['location'] == 'SwedenCentral')", "require(target['imds']['location'].lower() == 'swedencentral')")
add('infra/scripts/r3_policy_receive.py', 'policy-control-host', "connection['host'] in (control['public_ip'], control['private_ip'])", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-image-schema', "set(control['image']) == {'publisher', 'offer', 'sku', 'version', 'exactVersion'}", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-image-correspondence', "all(control['image'][k] == target['imds'][k] for k in ('publisher', 'offer', 'sku'))", 'True')
add('infra/scripts/r3_policy_receive.py', 'policy-image-exact-version', "control['image']['exactVersion'] == target['imds']['version']", 'True')

add('infra/scripts/r3_policy_git.py', 'policy-gitlinks', "if any(entry.startswith(b'160000 ') for entry in listing.split(b'\\0')):", 'if False:')
add('infra/scripts/r3_policy_git.py', 'policy-index-gitlinks', "git(root, 'ls-files', '--stage', '-z')", "b''")
add('infra/scripts/r3_policy_git.py', 'policy-head-gitlinks', "git(root, 'ls-tree', '-r', '-z', head)", "b''")

add('infra/scripts/r3_policy_capture.py', 'policy-context-nofollow', 'os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW', 'os.O_RDONLY | os.O_NONBLOCK')
add('infra/scripts/r3_policy_capture.py', 'policy-context-primary-cleanup', 'if primary is None or isinstance(primary, FileNotFoundError):', 'if True:')
add('infra/scripts/r3_policy_snap.py', 'policy-context-capture-scope', "        if isinstance(exc, capture.ReadError):\n            result['context']", "        if False:\n            result['context']")
add('infra/scripts/r3_policy_validate.py', 'policy-context-validation-scope', "snap_context=doc['format'] == 1 and path == '/usr/bin/snap'", 'snap_context=True')
add('infra/scripts/r3_policy_validate.py', 'policy-context-extra-fields', "set(value) == {'format', 'stage', 'errno', 'cleanup'}", 'True')
add('infra/scripts/r3_policy_validate.py', 'policy-context-stage', "require(item['stage'] in stages)", 'require(True)')
add('infra/scripts/r3_policy_validate.py', 'policy-context-errno-type', "type(item['errno']) is int", "isinstance(item['errno'], int)")
add('infra/scripts/r3_policy_validate.py', 'policy-context-cleanup-bound', "len(value['cleanup']) <= 2", 'True')
add('infra/scripts/r3_policy_validate.py', 'policy-context-error-class', "require(value['error'] == 'OSError')\n        read_context", "require(True)\n        read_context")
add('infra/scripts/r3_policy_snap.py', 'snap-exact-link', 'if link != LINK:', 'if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-policy-link-size', 'if info.st_size > LINK_LIMIT:', 'if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-unsupported-type', "        if link is None:\n            raise Refusal('UNSUPPORTED_TYPE')", "        if False:\n            raise Refusal('UNSUPPORTED_TYPE')")
add('infra/scripts/r3_policy_snap.py', 'snap-policy-leaf-nofollow', 'name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)', 'name, os.O_RDONLY | os.O_NONBLOCK, dir_fd=parent)')
add('infra/scripts/r3_policy_snap.py', 'snap-target-regular', 'if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:', 'if before.st_nlink != 1:')
add('infra/scripts/r3_policy_snap.py', 'snap-target-single-link', 'if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:', 'if not stat.S_ISREG(before.st_mode):')
add('infra/scripts/r3_policy_snap.py', 'snap-target-cap', 'if before.st_size > TARGET_LIMIT:', 'if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-read-deadline', 'if time.monotonic() >= deadline:', 'if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-alias-recheck', '            if link_again != link:', '            if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-target-parent-recheck', "        if parent_record(parent) != directory:\n            raise ValueError('CHANGED')\n        recheck(TARGET_PARENT", "        if False:\n            raise ValueError('CHANGED')\n        recheck(TARGET_PARENT")
add('infra/scripts/r3_policy_snap.py', 'snap-reopen-identity', 'if (now.st_dev, now.st_ino) != (before.st_dev, before.st_ino):', 'if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-target-reopen', '        recheck(TARGET_PARENT, parent, lambda again', '        (lambda *_args: None)(TARGET_PARENT, parent, lambda again')
add('infra/scripts/r3_policy_snap.py', 'snap-alias-reopen', '        recheck(ALIAS_PARENT, parent, unchanged)', '        pass')
add('infra/scripts/r3_policy_snap.py', 'snap-regular-parent-mode', "'stat-path', os.stat, ALIAS_NAME, dir_fd=again, follow_symlinks=False)))\n            if parent_record(parent) != directory:", "'stat-path', os.stat, ALIAS_NAME, dir_fd=again, follow_symlinks=False)))\n            if False:")
add('infra/scripts/r3_policy_snap.py', 'snap-recheck-primary', "        capture.close(again, 'close-parent', error)", "        capture.close(again, 'close-parent')")
add('infra/scripts/r3_policy_snap.py', 'snap-regular-reopen', '            recheck(ALIAS_PARENT, parent, lambda again', '            (lambda *_args: None)(ALIAS_PARENT, parent, lambda again')
add('infra/scripts/r3_policy_snap.py', 'snap-regular-identity', '            capture.same(info, before)\n', '')
add('infra/scripts/r3_policy_snap.py', 'snap-context-errno', "require(item['errno'] is None or type(item['errno']) is int and 1 <= item['errno'] <= 4095)", 'require(True)')
add('infra/scripts/r3_policy_snap.py', 'snap-context-cleanup-stage', " and item['stage'] in ('close-file', 'close-parent'))", ')')
add('infra/scripts/r3_policy_snap.py', 'snap-absent-keys', "require(set(value) == {'format', 'kind', 'alias'} and set(alias) == {'parent'})", 'require(True)')
add('infra/scripts/r3_policy_snap.py', 'snap-leaf-metadata', "        metadata(alias['leaf'])\n", '')
add('infra/scripts/r3_policy_snap.py', 'snap-absent-kind', "            return {'format': FORMAT, 'kind': 'absent', 'alias': {'parent': directory}}", "            raise ValueError('CHANGED')")
add('infra/scripts/r3_policy_snap.py', 'snap-root-parents', "p['uid'] == 0 and p['mode'] & 0o022 == 0", 'True')
add('infra/scripts/r3_policy_snap.py', 'snap-link-schema', "require(alias['link'] == LINK.decode('ascii'))", 'require(True)')
add('infra/scripts/r3_policy_snap.py', 'snap-target-cap-schema', "0 <= item['bytes'] <= TARGET_LIMIT", "0 <= item['bytes']")
add('infra/scripts/r3_policy_snap.py', 'snap-context-format', "value['format'] == 2 and value['stage'] in STAGES", "value['stage'] in STAGES")
add('infra/scripts/r3_policy_snap.py', 'snap-context-cleanup-bound', "len(value['cleanup']) <= 4", 'True')
add('infra/scripts/r3_policy_evidence.py', 'policy-trigger-pattern', 'match = KERNEL_TRIGGER.fullmatch(name) if', 'match = KERNEL_TRIGGER.search(name) if')
add('infra/scripts/r3_policy_evidence.py', 'policy-trigger-path', 'if path == TRIGGERS else None', 'if True else None')
add('infra/scripts/r3_policy_evidence.py', 'policy-trigger-installed', 'match is not None and match.group(1) in kernels', 'match is not None')
add('infra/scripts/r3_policy_evidence.py', 'policy-kernels-status', " and row['status'] == 'install ok installed')", ')')
add('infra/scripts/r3_policy_evidence.py', 'policy-kernels-prefix', "if row['name'].startswith('linux-image-') and", 'if')
add('infra/scripts/r3_policy_evidence.py', 'policy-kernels-command', "if item.get('returncode') != 0 or item.get('failure') is not None:", 'if False:')
add('infra/scripts/r3_policy_validate.py', 'policy-validate-trigger-rule', 'known = reviewed_member(path, name, kernels)', 'known = name in DIRECTORY_NAMES[path]')
add('infra/scripts/r3_policy_snap.py', 'snap-changed-code', "if type(exc) is ValueError and exc.args == ('CHANGED',):", 'if False:')
add('infra/scripts/r3_policy_snap.py', 'snap-changed-exact', "type(exc) is ValueError and exc.args == ('CHANGED',)", "exc.args[:1] == ('CHANGED',)")
add('infra/scripts/r3_policy_snap.py', 'snap-regular-codes', "'open-alias', 'REGULAR_UNSAFE', 'REGULAR_LIMIT'", "'open-alias', 'TARGET_UNSAFE', 'TARGET_LIMIT'")
add('infra/scripts/r3_policy_snap.py', 'snap-regular-format1-cap', "        if value['format'] == 1:\n            file_record(value['file'], False, absent=False)", "        if True:\n            file_record(value['file'], False, absent=False)")
add('infra/scripts/r3_policy_snap.py', 'snap-format-history', "value['format'] in (1, FORMAT)", "value['format'] == FORMAT")
add('infra/scripts/r3_policy_validate.py', 'snap-section-error-class', "require(value['error'] == 'OSError')\n        snap.validate_context", "require(True)\n        snap.validate_context")
add('infra/scripts/r3_policy_validate.py', 'snap-section-codes', "require(value['error'] in (*ERRORS, 'CHANGED', *snap.REFUSALS))", "require(True)")
add('infra/scripts/r3_policy_validate.py', 'snap-section-required', '        expected.add(snap.SECTION)', '        pass')
add('infra/scripts/r3_policy_validate.py', 'snap-section-completeness', '        complete &= snap_section(sections.get(snap.SECTION))', '        snap_section(sections.get(snap.SECTION))')
add('infra/scripts/r3_policy_validate.py', 'snap-format-dispatch', "extra = EXTRA_FILES if doc['format'] == 1 else COLLECTED_FILES", 'extra = EXTRA_FILES')
add('infra/scripts/r3_policy_evidence.py', 'snap-late-resample', "name.startswith(('file:', 'directory:', 'snap:'))", "name.startswith(('file:', 'directory:'))")
add('infra/scripts/r3_policy_evidence.py', 'snap-not-a-file', "COLLECTED_FILES = tuple(p for p in EXTRA_FILES if p != '/usr/bin/snap')", 'COLLECTED_FILES = EXTRA_FILES')
add('infra/scripts/r3_policy_packet.py', 'snap-packet-module', "'r3_policy_capture', 'r3_policy_snap', 'r3_policy_scope',", "'r3_policy_capture', 'r3_policy_scope',")
add('infra/scripts/r3_noble_inputs.py', 'snap-guest-module', "'r3_policy_capture.py', 'r3_policy_snap.py',", "'r3_policy_capture.py',")


add('infra/scripts/r3_access_identity_diagnostic.py', 'identity-diagnostic-flags', "all(value[k] is False for k in ('access_verified', 'qualification', 'installation_success'))", 'True')
add('infra/scripts/r3_access_identity_diagnostic.py', 'identity-diagnostic-complete-fields', "all(x['kind'] == 'string' and 1 <= x['characters'] <= 2048 for x in fields.values())", 'True')
add('infra/scripts/r3_access_identity_diagnostic.py', 'identity-diagnostic-response-size', 'type(count) is int and 1 <= count <= 32768', 'True')
add('infra/scripts/r3_access_identity_diagnostic.py', 'identity-diagnostic-deadline', 'signal.alarm(30)', 'signal.alarm(60)')
add('infra/scripts/r3_access_repair_contract.py', 'identity-diagnostic-prior-delivery-hash', "sha256(encoded(previous)) == prior['delivery_sha256']", 'True')
add('infra/scripts/r3_access_repair_contract.py', 'identity-diagnostic-prior-source', "previous_proposal['source']['published_sha'] == prior['source_sha']", 'True')
add('infra/scripts/r3_access_repair_control.py', 'identity-diagnostic-terminal-state', "view.get('executionState') == prior['execution_state']", 'True')
add('infra/scripts/r3_access_repair_control.py', 'identity-diagnostic-location', 'actual.lower() == expected.lower()', 'True')
snap_file = 'infra/scripts/r3_snap_leaf.py'
add(snap_file, 'snap-directory-nofollow', 'os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW', 'os.O_RDONLY | os.O_DIRECTORY')
add(snap_file, 'snap-leaf-nofollow', 'follow_symlinks=False', 'follow_symlinks=True')
add(snap_file, 'snap-link-size', "require(value['st_size'] <= 4096)", 'require(True)')
add(snap_file, 'snap-binding-types', "encoded(value['binding']) == encoded(binding)", "value['binding'] == binding")
add(snap_file, 'snap-qualified-forgery', "all(value[k] is False for k in ('policy_generated', 'qualification', 'installation_success'))", 'True')
add('infra/scripts/r3_noble_fixture.py', 'snap-frame-files', 'set(entries) != SNAP_FILES', 'False')
add('infra/scripts/r3_noble_fixture.py', 'snap-frame-readback', "result['checks'] != checked or result['status'] != checked['status']", 'False')
add('infra/scripts/r3_noble_inputs.py', 'snap-input-policy', 'if snap_leaf and (collection_only or policy_bytes is not None):', 'if False:')


add('infra/scripts/r3_access_repair_history.py', 'recovery-history-published-anchor', "(source['published_sha'], sha256(encoded(source['files']))) == PUBLISHED_CLOSURES[diagnostic]", 'True')
add('infra/scripts/r3_access_repair_history.py', 'recovery-history-module-hash', "sha256(source) == proposal['source']['files'].get('infra/scripts/' + name + '.py')", 'True')
add('infra/scripts/r3_access_repair_history.py', 'recovery-history-embedded-proposal', 'embedded == proposal', 'True')
add('infra/scripts/r3_access_repair_history.py', 'recovery-history-wrapper', 'factory(proposal, modules=modules) == guest', 'True')
add('infra/scripts/r3_access_repair_history.py', 'recovery-history-export', "sha256(export) == delivery['export_sha256']", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-other-identities', "all(item['exact_match'] is True for key, item in fields.items() if key != 'location')", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-early-refusal', "failed['phase'] == 'identity-before'", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-new-attempt', "proposal['packet_id'] not in (diagnostic['packet_id'], prior['proposal']['packet_id'])", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-terminal-provider', "props.get('provisioningState') == state", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-exact-output', "value == plan['amendment']['failed_summary' if index == 0 else 'diagnostic_report']", 'True')
add('infra/scripts/r3_access_repair_control.py', 'recovery-amendment-prior-check', "check_response(request('GET', url), plan, proposal, fresh, index)", "request('GET', url)")
add('infra/scripts/r3_access_repair_control.py', 'recovery-amendment-poll-bound', "range(5 if 'amendment' in plan else 6)", "range(4 if 'amendment' in plan else 6)")
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-prior-error', "view['exitCode'] == code and not view.get('error')", "view['exitCode'] == code")
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-no-extensions', "fresh['extensions'] == []", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-failure-kind', "failed['failure'] == 'ValueError'", 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-prior-hash-keys', 'set(hashes) == set(ids[:2])', 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-command-set', 'set(observed) == set(ids)', 'True')
add('infra/scripts/r3_access_repair_amendment.py', 'recovery-amendment-prior-exit-code', "prior['exit_code'] == 2", 'True')
add('infra/scripts/r3_access_repair_contract.py', 'recovery-amendment-approval-phase', "require(phase in ('repair', 'export'), 'AMENDMENT_PHASE')", "require(True, 'AMENDMENT_PHASE')")
add('infra/scripts/r3_access_repair_control.py', 'recovery-amendment-perform-phase', "require(phase == 'repair', 'AMENDMENT_PHASE')", "require(True, 'AMENDMENT_PHASE')")
add('infra/scripts/r3_access_repair_control.py', 'recovery-amendment-live-identities', "ids == fresh['extensions' if key == 'extensions' else 'run_commands']", 'True')
# PackageKit gate and installer facts (option C, PR-C0): zero entries before this.
add('infra/scripts/r3_install_policy.py', 'install-gate-is-true', "observed.get('packagekit_activation_possible') is not False:", "observed.get('packagekit_activation_possible') is True:")
add('infra/scripts/r3_install_policy.py', 'install-gate-truthy', "observed.get('packagekit_activation_possible') is not False:", "observed.get('packagekit_activation_possible'):")
add('infra/scripts/r3_install_policy.py', 'install-facts-binding', "            or digest(encoded(observed)) != policy['facts_sha256']):", '            or False):')
add('infra/scripts/r3_install_policy.py', 'install-mandb-guard', "        if observed['files'][name].get('absent'):\n            raise ValueError('Missing native trigger guard')", "        if False:\n            raise ValueError('Missing native trigger guard')")
add('infra/scripts/r3_install_policy.py', 'install-trigger-version', "if row.get('version') != item['version'] or row.get('status') != 'install ok installed':", "if row.get('status') != 'install ok installed':")
add('infra/scripts/r3_install_policy.py', 'install-trigger-status', "if row.get('version') != item['version'] or row.get('status') != 'install ok installed':", "if row.get('version') != item['version']:")
add('infra/scripts/r3_install_policy.py', 'install-bus-socket-type', "        if not stat.S_ISSOCK(info.st_mode):\n            raise ValueError('Unsafe D-Bus system socket')", "        if False:\n            raise ValueError('Unsafe D-Bus system socket')")
add('infra/scripts/r3_install_policy.py', 'install-bus-socket-nofollow', "info = os.stat('system_bus_socket', dir_fd=fd, follow_symlinks=False)", "info = os.stat('system_bus_socket', dir_fd=fd, follow_symlinks=True)")
add('infra/scripts/r3_install_policy.py', 'install-bus-dir-nofollow', '            try:\n                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)', '            try:\n                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)')
add('infra/scripts/r3_install_policy.py', 'install-bus-always-checked', "    socket = bus_socket(root)\n    packagekit = (not files['/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'].get('absent')\n                  and socket)", "    packagekit = (not files['/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'].get('absent')\n                  and bus_socket(root))")
add('infra/scripts/r3_install_policy.py', 'install-predicate-registration', "    packagekit = (not files['/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'].get('absent')\n                  and socket)", '    packagekit = socket')
add('infra/scripts/r3_policy_capture.py', 'capture-bus-socket-type', "        if not stat.S_ISSOCK(value.st_mode):\n            raise ValueError('UNSAFE_SOCKET')", "        if False:\n            raise ValueError('UNSAFE_SOCKET')")
add('infra/scripts/r3_policy_validate.py', 'policy-predicate-socket', "predicate = not service['value'].get('absent', False) and sock['value']['exists']", "predicate = not service['value'].get('absent', False)")
add('infra/scripts/r3_policy_validate.py', 'policy-predicate-registration', "predicate = not service['value'].get('absent', False) and sock['value']['exists']", "predicate = sock['value']['exists']")
add('infra/scripts/r3_maintenance.py', 'maintenance-pending-job', "if fields['Id'] != name or fields['Job'] != '':", "if fields['Id'] != name:")
add('infra/scripts/r3_maintenance.py', 'maintenance-active-work', "if name in SERVICES[:2] and (fields['ActiveState'], fields['SubState'], fields['MainPID']) != ('inactive', 'dead', '0'):", 'if False:')
add('infra/scripts/r3_maintenance.py', 'maintenance-foreign-writer', '    if len(found) > 1:\n', '    if False:\n')
add('infra/scripts/r3_maintenance.py', 'maintenance-inventory-pre-stop', "            if inventory_read('pre-stop', remaining()) != before:", '            if False:')
add('infra/scripts/r3_maintenance.py', 'maintenance-mask-proof', "if not path.is_symlink() or os.readlink(path) != '/dev/null':", 'if False:')
add('infra/scripts/r3_maintenance.py', 'maintenance-inventory-post-stop', "    if inventory_read('post-stop', remaining()) != before:", '    if False:')
add('infra/scripts/r3_maintenance.py', 'maintenance-completion', "    if complete != {'units': list(UNITS), 'inventory_unchanged': True, 'release_authorized': False}:", '    if False:')

# Registry-denied image transport run: fixture guards only, never transport proof.
TA, TI, TQ, TW = ('infra/scripts/r3_image_acquire.py', 'infra/scripts/r3_image_import.py',
                  'infra/scripts/r3_image_qualify.py', '.github/workflows/r3-image-transport.yml')
add(TA, 'transport-acquire-manifest-digest', "    if 'sha256:' + hashlib.sha256(data).hexdigest() != descriptor['digest']:", '    if False:')
add(TA, 'transport-acquire-media-type', "    if media not in MANIFESTS | INDEXES or value.get('mediaType', media) != media:", '    if False:')
add(TA, 'transport-acquire-blob-digest', "    if total != size or 'sha256:' + digest.hexdigest() != descriptor['digest']:", '    if total != size:')
add(TA, 'transport-acquire-ambiguous-child', "            if len(children) != 1 or children[0]['platform'] != {'os': 'linux', 'architecture': 'amd64'}:", '            if not children:')
add(TA, 'transport-acquire-registry-domain', "REFERENCE = re.compile(r'(?:([a-z0-9]+(?:[_-]+", "REFERENCE = re.compile(r'(?:([a-z0-9.]+(?:[_-]+")
add(TA, 'transport-acquire-https-redirect', "        if urllib.parse.urlsplit(newurl).scheme != 'https':", '        if False:')
add(TA, 'transport-acquire-bearer-redirected', "request.add_unredirected_header('Authorization', 'Bearer ' + token)", "request.add_header('Authorization', 'Bearer ' + token)")
add(TA, 'transport-acquire-platform-lock', "        if item.get('platform') != 'linux/amd64':", '        if False:')
add(TI, 'transport-import-host-namespace', '    if inode == host_inode:', '    if False:')
add(TI, 'transport-import-uplink', "    if [(link.get('ifname'), link.get('link_type')) for link in links] != [('lo', 'loopback')]:", '    if False:')
add(TI, 'transport-import-route', "        if route.get('dev') != 'lo' or route.get('dst') == 'default' or 'gateway' in route:", "        if route.get('dev') != 'lo':")
add(TI, 'transport-import-classic-store', "    if info.get('Driver') != 'overlayfs' or ('driver-type', 'io.containerd.snapshotter.v1') not in status:", '    if False:')
add(TI, 'transport-import-empty-store', "        if images or content or names or info.get('Images'):", '        if images:')
add(TI, 'transport-import-extra-content', "    if sorted(content) != sorted(expected['blobs']):", "    if not set(expected['blobs']) <= set(content):")
add(TI, 'transport-import-target-id', "    if (image.get('Id') != item['id'] or descriptor.get('digest') != item['id']", "    if (descriptor.get('digest') != item['id']")
add(TI, 'transport-import-repo-digest', "    if set(image.get('RepoDigests') or []) != {item['image']} or image.get('RepoTags'):", "    if image.get('RepoTags'):")
add(TI, 'transport-import-diff-ids', "    if image.get('RootFS') != {'Type': 'layers', 'Layers': item['diff_ids']}:", '    if False:')
add(TI, 'transport-import-started', "            or state.get('StartedAt') != '0001-01-01T00:00:00Z'):", '            or False):')
add(TI, 'transport-import-name-probe', "            if (any(row['resolved'] for row in names) or", '            if (False or')
add(TI, 'transport-import-address-probe', "                    or any(row['connected'] or row['errno'] not in UNREACHABLE for row in addresses)):", "                    or any(row['connected'] for row in addresses)):")
add(TI, 'transport-import-daemon-probe', '            if pulled or not any(REGISTRY_NAME.fullmatch(name) for name in asked):', '            if not any(REGISTRY_NAME.fullmatch(name) for name in asked):')
add(TI, 'transport-import-dns-window', '            if violations:', '            if False:')
add(TI, 'transport-import-excluded', "                raise ValueError('An inactive service image is present.')", '                pass')
add(TI, 'transport-import-archive-hash', "                    or file_hash(request['archive']) != analysis['archive_sha256']", '                    or False')
add(TI, 'transport-import-raw-name', "canonical(root['annotations']['org.opencontainers.image.ref.name'])}}", "root['annotations']['org.opencontainers.image.ref.name']}}")
add(TI, 'transport-import-engine-server', "            if version['Client']['Version'] != ENGINE or version['Server']['Version'] != ENGINE:", "            if version['Client']['Version'] != ENGINE:")
add(TI, 'transport-import-daemon-namespace', '            if inode != own or exe != str(self.bin / name):', '            if False:')
add(TI, 'transport-import-stop-killed', "                if 'killed' in result['daemon_stop'].values():", '                if False:')
add(TI, 'transport-import-db-policy', "            if lock['db']['image'] != policy['image'] or readback['db']['config_digest'] != policy['config_digest']:", '            if False:')
add(TI, 'transport-import-stored-config', "                        or blob_digest(config) != item['config']", '                        or False')
add(TI, 'transport-import-resolver-files', "    if read(target) != expected or read(source) != expected:", '    if False:')
add(TI, 'transport-import-resolver-inode', '    if (seen.st_dev, seen.st_ino) != (staged.st_dev, staged.st_ino):', '    if False:')
add(TA, 'transport-acquire-localhost', "    if namespace == 'localhost':", '    if False:')
add(TQ, 'transport-run-containment', "    if summary['containment'].get('remaining') != 0:", '    if False:')
add(TQ, 'transport-run-kill-lingering', "        run(['sudo', '-n', 'kill', '-KILL', *[p.decode() for p in pids]], raw, 'netns-kill', privileged=True)", '        pass')
add(TQ, 'transport-run-chown-before-seal', "        run(['sudo', '-n', 'chown', '-R', '--no-dereference', f'{os.getuid()}:{os.getgid()}', str(raw / 'isolated')],\n            raw, 'isolated-chown', privileged=True)", '        pass')
add(TQ, 'transport-run-seal-unreadable', "        raise ValueError('Unreadable raw evidence directory') from error", '        pass')
add(TI, 'transport-import-extract-links', '            if (not member.isfile() or member.name in seen', '            if (member.name in seen')
add(TQ, 'transport-run-attempt', "            or env.get('GITHUB_RUN_ATTEMPT') != '1' or env.get('RUNNER_ENVIRONMENT') != 'github-hosted'", "            or env.get('RUNNER_ENVIRONMENT') != 'github-hosted'")
add(TQ, 'transport-run-workflow-ref', "            or env.get('GITHUB_WORKFLOW_REF') != env.get('GITHUB_REPOSITORY', '') + '/' + WORKFLOW + '@' + ref):", '            or False):')
add(TQ, 'transport-run-import-status', "    if result.get('status') != 'TRANSPORT_IDENTITY_PASS' or set(result.get('images', {})) != ACTIVE:", "    if set(result.get('images', {})) != ACTIVE:")
add(TQ, 'transport-run-source-recheck', "    if source_binding(env) != source:\n        raise ValueError('Source changed before the denied import')", "    if False:\n        raise ValueError('Source changed before the denied import')")
add(TQ, 'transport-run-seal-links', '    if any(p.is_symlink() or not p.is_file() for p in files):', '    if False:')
# qa-auditor round: each guard below survived the first test set.
add(TI, 'transport-import-stored-root', "                if blob_digest(root) != item['id']:", '                if False:')
add(TI, 'transport-import-stored-child', '                    if blob_digest(data) != child:', '                    if False:')
add(TI, 'transport-import-probe-observed', "            if (any(row['resolved'] for row in names) or {row['name'] for row in names} - observed", "            if (any(row['resolved'] for row in names)")
add(TI, 'transport-import-analysis-sha', "            if (file_hash(request['analysis']) != request['analysis_sha256']", '            if (False')
add(TI, 'transport-import-lock-sha', "                    or analysis['image_lock_sha256'] != file_hash(ROOT / 'infra/selfhost/images.qa.lock.json')):", '                    or False):')
add(TI, 'transport-import-reverify', "            if images != analysis['images']:", '            if False:')
add(TI, 'transport-import-subset-count', '    if len(roots) != len(ACTIVE):', '    if False:')
add(TI, 'transport-import-subset-analysis', "    if images != {name: analysis['images'][name] for name in sorted(ACTIVE)}:", '    if False:')
add(TI, 'transport-import-subset-verify', '    images, names, _ = verify(destination, nine)', "    images, names, _ = {n: analysis['images'][n] for n in sorted(ACTIVE)}, {'oci-layout', 'index.json', *('blobs/sha256/' + b[7:] for b in blobs)}, None")
add(TI, 'transport-import-deb-hash', "            if file_hash(deb) != item['sha256']:", '            if False:')
add(TI, 'transport-import-deb-members', '            if found != set(members):', '            if False:')
add(TI, 'transport-import-daemon-exe', '            if inode != own or exe != str(self.bin / name):', '            if inode != own:')
add(TI, 'transport-import-new-roots', "        if any((work / name).exists() for name in ('docker-root', 'containerd-root')):", '        if False:')
add(TI, 'transport-import-inode-change', "            if result['namespace_after']['inode'] != result['namespace_before']['inode']:", '            if False:')
add(TI, 'transport-import-skip-final-store', "            result['store_final'] = self.store_state('store-final', expected)", "            result['store_final'] = {}")
add(TI, 'transport-import-skip-namespace-after', "            result['namespace_after'] = self.observe_namespace('namespace-after')", "            result['namespace_after'] = result['namespace_before']")
add(TI, 'transport-import-request-keys', '    if set(request) != keys:', '    if False:')
add(TI, 'transport-import-request-root-owner', 'v <= 0 for v in owner', 'v < 0 for v in owner')
add(TI, 'transport-import-request-absolute', '        if not Path(request[key]).is_absolute():', '        if False:')
add(TI, 'transport-import-request-digest', "    if not re.fullmatch('[a-f0-9]{64}', request['analysis_sha256']):", '    if False:')
add(TI, 'transport-import-request-endpoints', "            or any(not isinstance(v, list) or not v for v in request['endpoints'].values())):", '            or False):')
add(TI, 'transport-import-excluded-set', '            for name in sorted(set(lock) - ACTIVE):', "            for name in sorted(set(lock) - ACTIVE - {'caddy'}):")
add(TI, 'transport-import-create-pull', "self.docker('create', '--pull', 'never',", "self.docker('create', '--pull', 'always',")
add(TI, 'transport-import-log-cap', '                os.truncate(path, DAEMON_LOG_LIMIT)', '                pass')
add(TI, 'transport-import-extract-prefix', "                    or not re.fullmatch(r'oci-layout|index\\.json|blobs/sha256/[a-f0-9]{64}', member.name)):", "                    or not re.match(r'oci-layout|index\\.json|blobs/sha256/[a-f0-9]{64}', member.name)):")
add(TQ, 'transport-run-preflight-tools', "        if shutil.which(tool, path=ENV['PATH']) is None:", '        if False:')
add(TQ, 'transport-run-preflight-space', '    if usage.f_bavail * usage.f_frsize < FREE_BYTES:', '    if False:')
add(TQ, 'transport-run-preflight-netns', "    if run(['ip', 'netns', 'list'], raw, 'netns-before').strip() or (NETNS_ETC / NETNS).exists():", "    if run(['ip', 'netns', 'list'], raw, 'netns-before').strip():")
add(TQ, 'transport-run-hosted-stop', '    if present:', '    if False:')
add(TQ, 'transport-run-hosted-inactive', "    if any(state not in ('inactive', 'failed') for state in states.decode().split()) or len(states.split()) != len(units):", '    if False:')
add(TQ, 'transport-run-fallback-tunnels', "    run(['sudo', '-n', 'sysctl', '-w', 'net.core.fb_tunnels_only_for_init_net=2'], raw, 'netns-tunnels', privileged=True)\n", '')
add(TQ, 'transport-run-dirty-tree', "    if git('rev-parse', 'HEAD').decode().strip() != sha or git('status', '--porcelain=v1', '--untracked-files=all'):", "    if git('rev-parse', 'HEAD').decode().strip() != sha:")
add(TQ, 'transport-run-blob-hash', "        if hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\\0' + data).hexdigest() != blob.decode():", '        if False:')
add(TQ, 'transport-run-final-recheck', "            if source_binding(env) != source:\n                raise ValueError('Source changed after execution')", "            if False:\n                raise ValueError('Source changed after execution')")
add(TQ, 'transport-run-partial-ciphertext', "            (publish / 'transport-evidence.tar.age').unlink(missing_ok=True)", '            pass')
add(TQ, 'transport-run-nine-images', "    if result.get('status') != 'TRANSPORT_IDENTITY_PASS' or set(result.get('images', {})) != ACTIVE:", "    if result.get('status') != 'TRANSPORT_IDENTITY_PASS':")
add(TA, 'transport-acquire-final-https', "        if final.scheme != 'https' or not final.hostname:", '        if False:')
add(TA, 'transport-acquire-token', '            if not isinstance(value, str) or not value:', '            if False:')
add(TA, 'transport-acquire-document-limit', '    if len(data) > limit:', '    if False:')
add(TA, 'transport-acquire-child-size', "    if 'size' in descriptor and len(data) != descriptor['size']:", '    if False:')
add(TA, 'transport-acquire-child-type', "    if 'mediaType' in descriptor and descriptor['mediaType'] != media:", '    if False:')
add(TA, 'transport-acquire-existing-blob', '    elif path.read_bytes() != data:', '    elif False:')
add(TA, 'transport-acquire-foreign-urls', "            or type(size) is not int or not 0 <= size <= BLOB_LIMIT or descriptor.get('urls')):", '            or type(size) is not int or not 0 <= size <= BLOB_LIMIT):')
add(TA, 'transport-acquire-budget', '    if size > budget:', '    if False:')
add(TA, 'transport-acquire-stream-bound', '            if total > size:', '            if False:')
add(TA, 'transport-acquire-nested-index', "            if children[0].get('mediaType') not in MANIFESTS:", '            if False:')
add(TA, 'transport-acquire-config-size', '        if config.get(\'size\', DOCUMENT_LIMIT + 1) > DOCUMENT_LIMIT:', '        if False:')
add(TA, 'transport-acquire-user-agent', "headers={'User-Agent': 'tonyai-r3-acquire/1', **(headers or {})}", 'headers=headers or {}')
add(TW, 'transport-workflow-attempt', "    if: github.event_name == 'workflow_dispatch' && github.run_attempt == 1", "    if: github.event_name == 'workflow_dispatch'")
add(TW, 'transport-workflow-persist', '          persist-credentials: false', '          persist-credentials: true')
add(TW, 'transport-workflow-plaintext-upload', '            ${{ runner.temp }}/r3-image-transport-publish/summary.json', '            ${{ runner.temp }}/r3-image-transport-publish/summary.json\n            /mnt/tonyai-r3-transport-*/raw/**')
add(TW, 'transport-workflow-oidc', '  contents: read\n\nconcurrency', '  contents: read\n  id-token: write\n\nconcurrency')


def mutation_command(file, python_command, node_command):
    """Full R3 baseline first; exercise each mutation with its relevant suites."""
    if file.startswith('infra/scripts/r3_access_'):
        suites = ['test_r3_access_repair', 'test_r3_access_delivery', 'test_r3_access_custody', 'test_r3_access_identity_diagnostic', 'test_r3_access_amendment']
    elif file.endswith('.mjs'):
        return node_command
    # One chain: an r3_access_ file used to fall through to the final `else` and run the
    # whole R3 suite per mutant (about ten CI minutes for 29 mutants).
    elif file.endswith('r3_snap_leaf.py'):
        suites = ['test_r3_snap_leaf']
    elif file.startswith('infra/scripts/r3_policy_') or file.endswith(('r3_noble_guest.py', 'r3_noble_fixture.py', 'r3_noble_inputs.py')):
        suites = ['test_r3_policy_evidence', 'test_r3_policy_target', 'test_r3_policy_regressions', 'test_r3_policy_controller', 'test_r3_policy_approval', 'test_r3_policy_git_config', 'test_r3_policy_error_context', 'test_r3_policy_snap', 'test_r3_policy_triggers', 'test_r3_install_policy_facts', 'test_r3_snap_leaf', 'test_r3_noble_fixture', 'test_r3_noble_identity']
    elif file.endswith(('r3_image_acquire.py', 'r3_image_import.py', 'r3_image_qualify.py', 'r3-image-transport.yml')):
        suites = ['test_r3_image_transport_run']
    elif file.startswith('.github/workflows/'):
        suites = ['test_r3_workflow']
    elif file.endswith(('r3_image_transport.py', 'r3_guard_files.py', 'r3_package_evidence.py',
                        'r3_source_plan.py', 'replacement_host.py')):
        suites = ['test_r3_offline_package']
    elif file.endswith(('r3_package_state.py', 'r3_apt_observer.py')):
        suites = ['test_r3_package_state', 'test_r3_install_guards']
    elif file.endswith('r3_install.py'):
        suites = ['test_r3_install_guards', 'test_r3_preparation']
    elif file.endswith(('r3_install_policy.py', 'r3_maintenance.py')):
        suites = ['test_r3_maintenance_policy', 'test_r3_maintenance_integration', 'test_r3_install_guards',
                  'test_r3_install_policy_facts', 'test_r3_policy_evidence', 'test_r3_policy_controller']
    elif file.endswith('r3_transfer.py'):
        suites = ['test_r3_preparation']
    elif file.endswith(('r3_toolchain.py', 'r3_artifacts.py')):
        suites = ['test_r3_preparation', 'test_r3_provenance', 'test_r3_receipt']
    elif file.endswith(('r3_qualification.py', 'r3_smoke_status.py')):
        suites = ['test_r3_qualification_run', 'test_r3_compose_validation',
                  'test_r3_smoke_diagnostics', 'test_r3_preparation']
    else:
        return python_command
    loader = "import sys,unittest;sys.path.insert(0,'infra/tests');unittest.main(module=None,argv="
    return [sys.executable, '-B', '-c', loader + repr(['unittest', *suites]) + ')']


SOURCE_DIRS = ('infra/scripts', 'infra/tests', 'infra/selfhost', '.github/workflows')
MUTANT_TIMEOUT = 60


def anchor_matches(name):
    # SHA tests intentionally remove both job bindings.
    return 2 if name.startswith('source-sha-') else 1


def source_hashes(root):
    """Bind the bytes actually exercised in a disposable copy, not only the
    checkout observed by an external command wrapper."""
    return {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(root.rglob('*')) if path.is_file() and '__pycache__' not in path.parts}


def main(output, workers=None, source=ROOT, mutations=MUTATIONS):
    if workers is None: workers = os.cpu_count() or 1
    if workers < 1: raise ValueError('At least one mutation worker is required.')
    with tempfile.TemporaryDirectory(prefix='r3-mutants-') as temp:
        Path(temp).chmod(0o755)
        # One disposable copy per worker. A mutant is applied only in the copy its
        # worker holds, so no two mutants ever share a tree.
        roots = [Path(temp) / str(index) for index in range(min(workers, len(mutations) + 2))]
        for root in roots:
            root.mkdir(); root.chmod(0o755)
            for name in SOURCE_DIRS:
                shutil.copytree(source / name, root / name, ignore=shutil.ignore_patterns('__pycache__'))
        tested_source = source_hashes(roots[0])
        if any(source_hashes(root) != tested_source for root in roots[1:]):
            raise ValueError('Disposable worker copies differ before any test ran.')
        # Every anchor is checked in registry order before anything runs.
        for file, name, before, after in mutations:
            original = (roots[0] / file).read_text()
            if original.count(before) != anchor_matches(name): raise ValueError('Unmatched mutation: ' + name)
            if file.endswith('.py'): compile(original.replace(before, after), file, 'exec')
        command = [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'infra/tests', '-p', 'test_r3*.py']
        node_command = ['node', '--test', 'infra/tests/selfhost_init_entry.test.mjs']
        free = queue.Queue()
        for root in roots: free.put(root)

        def borrow(work):
            root = free.get()
            try: return work(root)
            finally: free.put(root)

        def baseline(test_command):
            return borrow(lambda root: subprocess.run(test_command, cwd=root, capture_output=True))

        def exercise(file, name, before, after):
            def work(root):
                path = root / file; original = path.read_text()
                # Re-checked in this copy: a drifted copy must never pass for an applied mutant.
                if original.count(before) != anchor_matches(name): raise ValueError('Unmatched mutation: ' + name)
                path.write_text(original.replace(before, after))
                test_command = mutation_command(file, command, node_command)
                try: result = subprocess.run(test_command, cwd=root, capture_output=True, timeout=MUTANT_TIMEOUT)
                finally: path.write_text(original)
                return {'name': name, 'file': file, 'command': test_command, 'result': 'KILLED' if result.returncode else 'SURVIVED',
                        'diagnostic': (result.stdout + result.stderr).decode()[-3000:] if result.returncode else ''}
            return borrow(work)

        with concurrent.futures.ThreadPoolExecutor(len(roots)) as pool:
            baselines = pool.submit(baseline, command), pool.submit(baseline, node_command)
            pending = [pool.submit(exercise, *mutation) for mutation in mutations]
            try:
                python_baseline, node_baseline = (future.result() for future in baselines)
                if python_baseline.returncode: raise SystemExit(python_baseline.stderr.decode())
                if node_baseline.returncode: raise SystemExit(node_baseline.stdout.decode() + node_baseline.stderr.decode())
                # Registry order, whatever order the workers finished in.
                results = [future.result() for future in pending]
            except BaseException:
                pool.shutdown(cancel_futures=True)
                raise
        if any(source_hashes(root) != tested_source for root in roots):
            raise ValueError('Disposable test source changed outside the restored mutations.')
    report = {'baseline': 'PASS', 'node_baseline': 'PASS', 'mutations': results, 'killed': sum(r['result'] == 'KILLED' for r in results),
              'survived': [r['name'] for r in results if r['result'] == 'SURVIVED'], 'invalid': 0,
              'source_sha256': tested_source, 'source_unchanged': True}
    with Path(output).open('x') as stream: json.dump(report, stream, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k not in ('mutations', 'source_sha256')}))
    return bool(report['survived'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--output', required=True)
    parser.add_argument('--workers', type=int, help='parallel worker copies (default: CPU count)')
    args = parser.parse_args()
    raise SystemExit(main(args.output, args.workers))

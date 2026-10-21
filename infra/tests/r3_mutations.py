#!/usr/bin/env python3
"""Targeted call-site mutations in a disposable source copy. No cloud or Docker."""
import argparse
import json
import os
from pathlib import Path
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
install('closure-call', '    plan = dependency_plan(lock, paths)', "    plan = ''")
install('pending-package-audit', "    if capture(['dpkg', '--audit']).strip():", '    if False:')
toolchain('plan-configured-versions', "            or {match.groups() for match in configured if match} != expected", '')
toolchain('plan-candidate-versions', "            or {match.groups() for match in planned if match} != expected", '')
install('archive-prewrite', '    check_node_archive(node)', '    pass')
install('node-directory-root', "member.name == root or member.name.startswith(root + '/')", "member.name.startswith(root + '/')")
install('archive-filter', "archive.extractall('/opt/tonyai-tools', filter='data')", "archive.extractall('/opt/tonyai-tools', filter='fully_trusted')")
install('attempt-journal', "    write_new('/etc/tonyai/r3-install-attempt.json', encoded(expected))", '    pass')
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
add('infra/scripts/r3_transfer.py', 'transfer-apt', "'installer_internal_apt_argv': install_argv(packages)", "'installer_internal_apt_argv': ['apt-get', 'install', *packages]")
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


def mutation_command(file, python_command, node_command):
    """Full R3 baseline first; exercise each mutation with its relevant suites."""
    if file.endswith('.mjs'):
        return node_command
    if file.startswith('.github/workflows/'):
        suites = ['test_r3_workflow']
    elif file.endswith(('r3_image_transport.py', 'r3_guard_files.py', 'r3_package_evidence.py',
                        'r3_source_plan.py', 'replacement_host.py')):
        suites = ['test_r3_offline_package']
    elif file.endswith('r3_install.py'):
        suites = ['test_r3_install_guards', 'test_r3_preparation']
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


def main(output):
    with tempfile.TemporaryDirectory(prefix='r3-mutants-') as temp:
        root = Path(temp)
        root.chmod(0o755)
        for name in ('infra/scripts', 'infra/tests', 'infra/selfhost', '.github/workflows'):
            shutil.copytree(ROOT / name, root / name, ignore=shutil.ignore_patterns('__pycache__'))
        command = [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'infra/tests', '-p', 'test_r3*.py']
        baseline = subprocess.run(command, cwd=root, capture_output=True)
        if baseline.returncode: raise SystemExit(baseline.stderr.decode())
        node_command = ['node', '--test', 'infra/tests/selfhost_init_entry.test.mjs']
        node_baseline = subprocess.run(node_command, cwd=root, capture_output=True)
        if node_baseline.returncode: raise SystemExit(node_baseline.stdout.decode() + node_baseline.stderr.decode())
        results = []
        for file, name, before, after in MUTATIONS:
            path = root / file; original = path.read_text()
            # SHA tests intentionally remove both job bindings.
            expected = 2 if name.startswith('source-sha-') else 1
            if original.count(before) != expected: raise ValueError('Unmatched mutation: ' + name)
            mutated = original.replace(before, after)
            if file.endswith('.py'): compile(mutated, file, 'exec')
            path.write_text(mutated)
            test_command = mutation_command(file, command, node_command)
            try:
                result = subprocess.run(test_command, cwd=root, capture_output=True, timeout=60)
                results.append({'name': name, 'file': file, 'command': test_command, 'result': 'KILLED' if result.returncode else 'SURVIVED',
                                'diagnostic': (result.stdout + result.stderr).decode()[-3000:] if result.returncode else ''})
            finally: path.write_text(original)
    report = {'baseline': 'PASS', 'node_baseline': 'PASS', 'mutations': results, 'killed': sum(r['result'] == 'KILLED' for r in results),
              'survived': [r['name'] for r in results if r['result'] == 'SURVIVED'], 'invalid': 0}
    with Path(output).open('x') as stream: json.dump(report, stream, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != 'mutations'}))
    return bool(report['survived'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--output', required=True)
    raise SystemExit(main(parser.parse_args().output))

"""Bounded Linux probe transport; stdin-only secrets and exact-CID local cleanup."""
import json
import hashlib
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
from uuid import uuid4
from cloud_ops import write_private_journal
from pooler import SafeFailure

OPERATION = 'hosted-acceptance-probe'
SCRIPTS = {'verify': 'hosted-smoke-fixture.mjs', 'fixtures': 'hosted-smoke-fixture.mjs',
           'storage': 'hosted-storage-probe.mjs', 'bootstrap': 'hosted-lifecycle-bootstrap.mjs', 'lifecycle': 'hosted-lifecycle-operator.mjs'}


def validate_receipt_location(receipt):
    receipt = Path(receipt).absolute()
    parent = receipt.parent
    info = parent.stat()
    if (parent.is_symlink() or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise SafeFailure('Probe receipts require an operator-owned mode-0700 parent directory.')
    return receipt


def arguments(name, image, bundle, execution, seal, operation):
    if (operation not in SCRIPTS or not re.fullmatch(r'[a-f0-9]{64}', seal)
            or not re.fullmatch(r'tonyai-hosted-probe-[a-f0-9]{32}', name)
            or not re.fullmatch(r'[a-z0-9]+\.azurecr\.io/tonyai/api@sha256:[a-f0-9]{64}', image)
            or os.getuid() == 0):
        raise SafeFailure('Invalid immutable probe transport binding.')
    return ['docker', 'run', '-i', '--pull=never', '--platform=linux/amd64', '--read-only',
            '--user=1000:' + str(os.getgid()), '--ulimit=core=0',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
            '--memory=512m', '--cpus=1', '--no-healthcheck', '--log-driver=none',
            '--network=' + ('none' if operation == 'verify' else 'bridge'),
            '--env=NODE_OPTIONS=', '--name=' + name,
            '--label=tonyai.operation=' + OPERATION, '--label=tonyai.seal=' + seal,
            '--cidfile=' + str(execution / 'container.id'),
            '--mount=type=bind,src=' + str(bundle) + ',dst=/observer,readonly',
            '--mount=type=bind,src=' + str(execution) + ',dst=/receipts',
            '--workdir=/observer', '--entrypoint=/usr/local/bin/node', image,
            '/observer/' + SCRIPTS[operation]]


def cleanup(name, execution, seal, env, call=subprocess.run):
    result = {'scope_matched': False, 'stopped': False, 'removed': False, 'absent': False}
    def docker(args, timeout=20):
        return call(['docker', *args], env=env, stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    try:
        cidfile = execution / 'container.id'
        cid = cidfile.read_text().strip() if cidfile.exists() else None
        if cid is not None and not re.fullmatch(r'[a-f0-9]{64}', cid):
            return result
        # If Docker failed before writing cidfile, discover only our exact random
        # name; metadata must still match before any stop/remove operation.
        observed = docker(['inspect', '--type=container', cid or name])
        if observed.returncode:
            filters = ['name=^/' + name + '$'] + (['id=' + cid] if cid is not None else [])
            result['absent'] = True
            for exact_filter in filters:
                missing = docker(['ps', '-a', '--no-trunc', '--filter', exact_filter, '--format', '{{.ID}}'])
                result['absent'] = result['absent'] and missing.returncode == 0 and not missing.stdout.strip()
            return result
        if len(observed.stdout) > 131072:
            return result
        rows = json.loads(observed.stdout)
        if not isinstance(rows, list) or len(rows) != 1:
            return result
        item = rows[0]
        observed_id = item.get('Id')
        labels = item.get('Config', {}).get('Labels') or {}
        if (not isinstance(observed_id, str) or not re.fullmatch(r'[a-f0-9]{64}', observed_id)
                or (cid is not None and observed_id != cid) or item.get('Name') != '/' + name
                or labels.get('tonyai.operation') != OPERATION or labels.get('tonyai.seal') != seal
                or type(item.get('State', {}).get('Running')) is not bool):
            return result
        result['scope_matched'] = True
        if item['State']['Running']:
            stopped = docker(['stop', '--timeout=120', observed_id], 135)
            if stopped.returncode or stopped.stdout.decode().strip() != observed_id:
                return result
            result['stopped'] = True
        removed = docker(['rm', observed_id])
        result['removed'] = removed.returncode == 0 and removed.stdout.decode().strip() == observed_id
        if not result['removed']:
            return result
        missing = docker(['ps', '-a', '--no-trunc', '--filter', 'id=' + observed_id, '--format', '{{.ID}}'])
        result['absent'] = missing.returncode == 0 and not missing.stdout.strip()
        return result
    except (OSError, ValueError, TypeError, KeyError, subprocess.TimeoutExpired, KeyboardInterrupt):
        return result


def run(image, bundle, operation, payload, receipt, seal, env):
    if operation not in SCRIPTS or payload.get('operation') != operation:
        raise SafeFailure('Probe operation differs from the approved input.')
    receipt = validate_receipt_location(receipt)
    if receipt.exists():
        raise SafeFailure('A probe receipt already exists; no repeat is implied.')
    name = 'tonyai-hosted-probe-' + uuid4().hex
    # Record the exact custody directory before Popen, never infer it later by glob.
    execution = Path(tempfile.mkdtemp(prefix='tonyai-hosted-probe-', dir=receipt.parent))
    if execution.stat().st_gid != os.getgid():
        # macOS inherits the parent directory's group; restrict our new mount
        # to the operator's actual primary group before allowing UID1000 writes.
        os.chown(execution, -1, os.getgid())
    if execution.stat().st_gid != os.getgid():
        raise SafeFailure('Probe receipt group differs from the operator group.')
    # The outer owner-only 0700 directory is never mounted. UID1000 needs
    # operator-group access only to this nested receipts mount (no secret values).
    execution.chmod(0o770)
    state = {'operation': operation, 'container_name': name, 'seal': seal,
             'execution_directory': str(execution), 'container_id_file': str(execution / 'container.id'),
             'object_receipt': str(execution / 'objects.json') if operation == 'storage' else None,
             'started': False, 'child_exit': None, 'interrupted': False, 'cleanup': None,
             'accepted': False, 'validation': 'NOT_DONE'}
    if operation == 'lifecycle':
        if payload.get('step') not in ('inject-disable', 'reconcile-dry', 'reconcile-apply', 'offboard-dry', 'offboard-apply'):
            raise SafeFailure('Unknown lifecycle step; no child started.')
        state['step'] = payload['step']
        state['target_sha256'] = hashlib.sha256(json.dumps(
            {'target': payload.get('target'), 'invitees': payload.get('invitees')}, sort_keys=True).encode()).hexdigest()
    write_private_journal(receipt, state, exclusive=True)
    child = None
    output = ''
    try:
        args = arguments(name, image, Path(bundle).resolve(), execution, seal, operation)
        child = subprocess.Popen(args, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        state['started'] = True
        deadline = {'verify': 45, 'fixtures': 300, 'storage': 900, 'bootstrap': 300, 'lifecycle': 300}[operation]
        try:
            output, _ = child.communicate(json.dumps(payload), timeout=deadline)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            state['interrupted'] = True
            child.send_signal(signal.SIGINT)
            try: output, _ = child.communicate(timeout=120)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                output = ''
        state['child_exit'] = child.poll()
    finally:
        try:
            state['cleanup'] = cleanup(name, execution, seal, env)
        finally:
            if child is not None and child.poll() is None:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                try: child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    raise SafeFailure('Docker client shutdown remains unconfirmed.') from None
            # No secret payload, stdout, stderr or raw engine error is persisted.
            write_private_journal(receipt, state)
        if not state['cleanup']['absent']:
            raise SafeFailure('Exact probe container cleanup is unconfirmed; no further operation.')
    try:
        if state['interrupted'] or len(output) > 16384:
            raise ValueError()
        report = json.loads(output)
        expected = {'verify': 'RUNTIME_VERIFIED', 'fixtures': 'FIXTURES_CREATED', 'storage': 'STORAGE_PROBED', 'bootstrap': 'BOOTSTRAP_CREATED', 'lifecycle': 'LIFECYCLE_OBSERVED'}[operation]
        if not isinstance(report, dict) or report.get('status') != expected:
            if isinstance(report, dict) and report.get('stage') in ('INPUT', 'RUNTIME_IMPORT', 'CA_READ', 'VERIFY', 'PROVISION'):
                state['failure_stage'] = report['stage']
                code = report.get('code')
                if code in ('EACCES', 'ENOENT', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND') or (isinstance(code, str) and re.fullmatch(r'P[1-3][0-9]{3}', code)):
                    state['failure_code'] = code
                if report.get('missingModule') in ('@tonyai/db', '@prisma/client'):
                    state['missing_module'] = report['missingModule']
                observed = report.get('observed')
                if operation == 'verify' and isinstance(observed, dict):
                    state['runtime_observation'] = {k: v for k, v in observed.items()
                        if (k == 'ca_matches' and type(v) is bool)
                        or (k in ('node_major', 'prisma_version') and isinstance(v, str) and re.fullmatch(r'[0-9.]{1,20}', v))}
            raise ValueError()
        if state['child_exit'] != 0:
            raise ValueError()
        if operation == 'fixtures' and (report.get('application_rows') != 6 or report.get('audit_rows') != 6):
            raise ValueError()
        if operation == 'verify' and (report.get('node_major') != 22 or report.get('prisma_version') != '6.19.3'
                                      or report.get('ca_sha256') != payload.get('caSha256')):
            raise ValueError()
        if operation == 'bootstrap' and (report.get('application_rows') != 2 or report.get('audit_rows') != 2):
            raise ValueError()
        if operation == 'storage' and (report.get('upload_attempts') != 12 or report.get('absent_objects') != 12
                                       or report.get('private_signed_expiry_checks') != 3):
            raise ValueError()
        if operation == 'lifecycle':
            if report.get('step') != payload.get('step'):
                raise ValueError()
            step = payload['step']
            if step == 'inject-disable':
                if (report.get('provider_calls') != 0 or report.get('injected_failures') != 1 or report.get('pending') != 1):
                    raise ValueError()
                state['observations'] = {k: report[k] for k in ('provider_calls', 'injected_failures', 'pending')}
            else:
                if (type(report.get('pending')) is not int or report['pending'] < 0 or report['pending'] > 3
                        or type(report.get('retired')) is not bool
                        or report['retired'] != (step == 'offboard-apply')
                        or (step.endswith('-apply') and report['pending'] != 0)):
                    raise ValueError()
                state['observations'] = {k: report[k] for k in ('pending', 'retired')}
        # Only fixed public observations escape the transport.
        state['accepted'] = True
        state['validation'] = 'ACCEPTED'
        state['report_status'] = expected
        write_private_journal(receipt, state)
        return {'status': expected}
    except (ValueError, TypeError, KeyError):
        state['validation'] = 'REJECTED'
        write_private_journal(receipt, state)
        raise SafeFailure('Probe stopped; outcome may be unknown. Preserve the private receipt, no retry.') from None

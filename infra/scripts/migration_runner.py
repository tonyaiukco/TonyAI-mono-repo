"""Linux runner: cached immutable image, no credential argv/env metadata or raw logs."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
from uuid import uuid4
from pooler import SafeFailure

ROOT = Path(__file__).resolve().parents[2]


def docker_environment():
    if os.environ.get('DOCKER_HOST') or os.environ.get('DOCKER_CONTEXT'):
        raise SafeFailure('Clear Docker endpoint overrides; a local Unix socket is required.')
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME')}
    result = subprocess.run(['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
                            env=env, capture_output=True, text=True, timeout=15, check=False)
    endpoint = result.stdout.strip()
    if result.returncode or not endpoint.startswith('unix:///'):
        raise SafeFailure('Migration credentials may only reach a local Unix Docker socket.')
    path = Path(endpoint.removeprefix('unix://'))
    if not stat.S_ISSOCK(path.stat().st_mode):
        raise SafeFailure('Local Docker endpoint is not a Unix socket.')
    return {**env, 'DOCKER_HOST': endpoint}


def inspect_image(image):
    env = docker_environment()
    result = subprocess.run(['docker', 'image', 'inspect', image], env=env,
                            capture_output=True, text=True, check=False, timeout=30)
    try:
        record, = json.loads(result.stdout)
        if result.returncode or record['Os'] != 'linux' or record['Architecture'] != 'amd64' or image not in record['RepoDigests']:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise SafeFailure('Selected immutable linux/amd64 API image must already be cached; no automatic pull.') from None
    return env


def arguments(name, image, bundle, engine, network='bridge'):
    return ['docker', 'run', '--rm', '--pull=never', '--name', name, '--platform', 'linux/amd64',
            '--network', network, '--read-only', '--log-driver=none', '--no-healthcheck', '--cap-drop=ALL',
            '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--cpus=1',
            '--user=1000:1000', '--ulimit', 'core=0', '--env', 'NODE_OPTIONS=', '--interactive',
            '--mount', f'type=bind,src={bundle},dst=/migration,readonly',
            '--mount', f'type=bind,src={engine},dst=/engine,readonly',
            '--mount', f'type=bind,src={ROOT / "infra/scripts/migration-engine.mjs"},dst=/runner.mjs,readonly',
            '--mount', f'type=bind,src={ROOT / "infra/scripts/migration-role-check.mjs"},dst=/migration-role-check.mjs,readonly',
            '--workdir=/migration', '--entrypoint=node', image, '/runner.mjs']


def run(image, bundle, engine, url, operation, network='bridge', env=None):
    name = 'tonyai-migration-' + uuid4().hex
    env = env or docker_environment()
    child = None
    try:
        child = subprocess.Popen(arguments(name, image, bundle, engine, network), env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, start_new_session=True)
        out, _ = child.communicate(json.dumps({'url': url, 'operation': operation}),
                                   timeout=90 if operation == 'probe' else 1000)
        try:
            report = json.loads(out)
            expected = 'PRIVILEGES_CHECKED' if operation.endswith('-check') else 'READ_ONLY_QUERY_SUCCEEDED' if operation == 'probe' else 'MIGRATIONS_CURRENT'
            if child.returncode or report.get('status') != expected:
                code = report.get('prisma_code')
                import re
                suffix = ' (' + code + ')' if isinstance(code, str) and re.fullmatch(r'P[1-3][0-9]{3}', code) else ''
                raise SafeFailure('Migration operation stopped' + suffix + '; no retry; inspect through the approved owner procedure.')
            if operation.endswith('-check'):
                identity = 'postgres' if operation == 'owner-check' else 'tonyai_runtime'
                findings, skipped = report['platform_default_findings'], report['library_skipped']
                if (report['identity'] != identity or type(findings) is not int or not 0 <= findings <= 10000
                        or type(skipped) is not int or not 0 <= skipped <= 10000
                        or (operation == 'owner-check' and skipped)
                        or report['findings_require_owner_review'] is not (findings > 0)):
                    raise ValueError()
                return {'status': expected, 'identity': identity, 'platform_default_findings': findings,
                        'library_skipped': skipped, 'findings_require_owner_review': findings > 0}
            count = report['applied_count']
            if type(count) is not int or count < 0 or count > 10000 or (operation == 'probe' and count):
                raise ValueError()
            return {'status': report['status'], 'applied_count': count}
        except (ValueError, TypeError, KeyError):
            raise SafeFailure('Invalid migration runner response; outcome unknown; no retry.') from None
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        raise SafeFailure('Migration runner interrupted; outcome unknown; no retry.') from None
    finally:
        # A Docker CLI exit does not prove the container stopped. Remove only our generated name.
        try:
            cleanup = subprocess.run(['docker', 'rm', '--force', name], env=env,
                                     capture_output=True, timeout=30, check=False)
            removed = cleanup.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            removed = False
        finally:
            if child is not None and child.poll() is None:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                try: child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    raise SafeFailure('Docker client cleanup unconfirmed; stop before any further operation.') from None
        if not removed:
            try:
                check = subprocess.run(['docker', 'container', 'ls', '--all', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}'],
                                       env=env, capture_output=True, text=True, timeout=15, check=False)
                absent = check.returncode == 0 and not check.stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                absent = False
            if not absent:
                raise SafeFailure('Runner cleanup unconfirmed; stop and inspect the generated migration container.')

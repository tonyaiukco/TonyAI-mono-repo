#!/usr/bin/env python3
"""Exact QA composition smoke on a fresh GitHub Ubuntu 24.04 amd64 runner only.

This deliberately does not emulate IMDS, Azure disks or custody acceptance.
Never upload the runtime directory, Compose output, container logs or credentials.
"""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

from r3_artifacts import ROOT, fetch, sha, write
from selfhost_pin import validate, redact_gateway

PROJECT = 'tonyai-r3-disposable'
ACTIVE = {'api-gw', 'auth', 'db', 'imgproxy', 'meta', 'realtime', 'rest', 'storage', 'studio'}


def capture(argv, cwd=None, data=None):
    result = subprocess.run(argv, cwd=cwd, input=data, capture_output=True, timeout=600)
    if result.returncode:
        raise ValueError('Disposable command failed; private diagnostics withheld.')
    return result.stdout


def require_runner(env, system, machine, os_release):
    if (env.get('GITHUB_ACTIONS') != 'true' or env.get('RUNNER_ENVIRONMENT') != 'github-hosted'
            or env.get('RUNNER_OS') != 'Linux' or env.get('RUNNER_ARCH') != 'X64'
            or system != 'Linux' or machine != 'x86_64'
            or os_release.get('ID') != 'ubuntu' or os_release.get('VERSION_ID') != '24.04'):
        raise ValueError('Only the agreed fresh GitHub Ubuntu 24.04 amd64 runner is allowed.')
    if any(env.get(k) for k in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'COMPOSE_FILE', 'COMPOSE_PROFILES',
                               'ARM_CLIENT_SECRET', 'AZURE_CLIENT_SECRET', 'DATABASE_URL', 'DIRECT_URL')):
        raise ValueError('Ambient target/credential overrides refused.')


def compose():
    return ['docker', '--host', 'unix:///var/run/docker.sock', 'compose', '-p', PROJECT,
            '--env-file', '.env', '-f', 'docker-compose.yml', '-f', 'compose.qa.yml',
            '-f', 'compose.https.yml', '-f', 'compose.r02.yml', '-f', 'compose.images.json']


def check_effective(config, lock):
    validate(config)
    services = config['services']
    if set(services) != set(lock):
        raise ValueError('Effective service set differs.')
    for name, service in services.items():
        if (service['image'] != lock[name]['image'] or service.get('platform') != 'linux/amd64'
                or service.get('restart') != 'no'):
            raise ValueError('Effective image/platform/restart differs.')
    if {name for name, service in services.items() if not service.get('profiles')} != ACTIVE:
        raise ValueError('Isolated active service set differs.')
    realtime = services['realtime']['environment']
    if realtime.get('DB_ENC_WRITE_GCM') != 'true' or len(realtime.get('DB_ENC_KEY_GCM', '').encode()) != 32:
        raise ValueError('Realtime GCM input differs.')


def run(output):
    require_runner(os.environ, platform.system(), platform.machine(), platform.freedesktop_os_release())
    if os.geteuid() != 0:
        raise ValueError('Disposable runner requires root for fixed QA bind paths.')
    if capture(['docker', 'ps', '-aq']).strip() or Path('/srv/tonyai').exists():
        raise ValueError('Runner is not empty; never remove another runtime.')
    os.umask(0o077)
    output = Path(output).absolute()
    output.mkdir(mode=0o700)
    runtime = output / 'runtime'
    runtime.mkdir(mode=0o700)
    upstream = json.loads((ROOT / 'infra/selfhost/upstream.lock.json').read_bytes())
    for name, expected in upstream['files'].items():
        write(runtime / name, fetch('https://raw.githubusercontent.com/supabase/supabase/' + upstream['commit'] + '/docker/' + name, expected))
    for name in ('compose.qa.yml', 'compose.https.yml', 'compose.r02.yml', 'Caddyfile'):
        write(runtime / name, (ROOT / 'infra/selfhost' / name).read_bytes())
    lock_bytes = (ROOT / 'infra/selfhost/images.qa.lock.json').read_bytes()
    lock = json.loads(lock_bytes)['services']
    write(runtime / 'compose.images.json', lock_bytes)
    # Public bind-mounted sources must be readable by the containers' nonroot
    # users. Only pinned entrypoints are executable; generated secrets stay0600.
    runtime.chmod(0o755)
    for path in runtime.rglob('*'):
        if path.is_dir():
            path.chmod(0o755)
        else:
            path.chmod(0o755 if path.name.endswith('entrypoint.sh') else 0o644)
    # Import only pure credential generation. Production initialization keeps all
    # root/IMDS/disk/source/custody guards; none is disabled for this runner.
    script = r"""import { createSettings } from './infra/scripts/selfhost_init.mjs';
import { writeFileSync } from 'node:fs';
const settings = createSettings('tonyai-staging-disposable.swedencentral.cloudapp.azure.com', 'qualification@example.invalid');
writeFileSync(process.argv[1], Object.entries(settings).map(([k,v]) => `${k}='${v}'`).join('\n')+'\n', {flag:'wx',mode:0o600});
"""
    capture(['node', '--input-type=module', '-e', script, str(runtime / '.env')], cwd=ROOT)
    for path in ('database/postgres', 'database/db-config', 'database/caddy-data', 'database/caddy-config', 'objects/storage'):
        Path('/srv/tonyai', path).mkdir(parents=True, mode=0o750)
    os.chdir(runtime)
    redact_gateway()
    config = json.loads(capture(compose() + ['--profile', '*', 'config', '--format', 'json']))
    check_effective(config, lock)
    images = {}
    for name, item in lock.items():
        capture(['docker', 'pull', '--platform', 'linux/amd64', item['image']])
        meta = json.loads(capture(['docker', 'image', 'inspect', item['image']]))[0]
        if meta['Architecture'] != 'amd64' or meta['Os'] != 'linux' or item['image'] not in meta['RepoDigests']:
            raise ValueError('Image identity mismatch.')
        images[name] = meta['Id']
    policy = json.loads((ROOT / 'infra/selfhost/database-image-policy.json').read_bytes())
    if lock['db']['image'] != policy['image'] or images['db'] != policy['config_digest']:
        raise ValueError('Database image policy mismatch.')
    # Seed the image's intrinsic configuration on the disposable runner. This is
    # not a claim that the production mount/IMDS/escrow guards ran here.
    container = capture(['docker', 'create', '--pull', 'never', '--entrypoint', 'true', lock['db']['image']]).decode().strip()
    try:
        capture(['docker', 'cp', '-a', container + ':/etc/postgresql-custom/.', '/srv/tonyai/database/db-config'])
    finally:
        capture(['docker', 'rm', '-v', container])
    metadata = capture(['docker', 'run', '--pull', 'never', '--rm', '--entrypoint', 'stat', lock['db']['image'], '-c', '%u:%g:%a', '/etc/postgresql-custom']).decode().strip()
    uid, gid, mode = metadata.split(':')
    os.chown('/srv/tonyai/database/db-config', int(uid), int(gid))
    Path('/srv/tonyai/database/db-config').chmod(int(mode, 8))
    try:
        capture(compose() + ['up', '-d', '--pull', 'never', '--no-build', '--wait', '--wait-timeout', '240', 'db'])
        if not Path('/srv/tonyai/database/db-config/pgsodium_root.key').is_file():
            raise ValueError('Database intrinsic key was not generated.')
        capture(compose() + ['up', '-d', '--pull', 'never', '--no-build', '--wait', '--wait-timeout', '240'])
        ids = capture(compose() + ['ps', '-q']).decode().split()
        containers = json.loads(capture(['docker', 'inspect', *ids]))
        observed = {}
        for item in containers:
            name = item['Config']['Labels']['com.docker.compose.service']
            if name not in ACTIVE or item['Image'] != images[name] or item['HostConfig']['RestartPolicy']['Name'] != 'no':
                raise ValueError('Running image/service/restart differs.')
            state = item['State']
            if not state['Running'] or state.get('Health', {}).get('Status', 'healthy') != 'healthy':
                raise ValueError('Unhealthy disposable service.')
            observed[name] = {'image_config': item['Image'], 'running': True}
        if set(observed) != ACTIVE:
            raise ValueError('Active services missing.')
        report = {'status': 'COMPOSITION_SMOKE_PASS', 'qa_ready': False,
                  'source_sha': capture(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
                  'image_lock_sha256': sha(lock_bytes), 'services': observed,
                  'unproven': ['Private refused-statement/stable-connection regression',
                              'Realtime image/source correspondence and GCM consumer round-trip',
                              'Offline image transport and pinned installer qualification',
                              'Azure IMDS/disks/firewall/SSH trust and two-stage custody',
                              'R4 credential retirement/activation and application readiness']}
        write(output / 'summary.json', json.dumps(report, indent=2).encode())
    finally:
        # Only this project; never global prune, volume deletion or DB reset.
        capture(compose() + ['down', '--timeout', '30'])


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Private output directory required.')
        run(sys.argv[1])
        print('PASS: composition smoke only; full R3 qualification remains gated.')
    except Exception:
        raise SystemExit('FAIL: disposable qualification refused or failed; no runtime output exported.')

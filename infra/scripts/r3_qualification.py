#!/usr/bin/env python3
"""QA composition smoke using hosted Docker tooling on a fresh GitHub Ubuntu 24.04 amd64 runner only.

This deliberately does not emulate IMDS, Azure disks or custody acceptance.
Never upload the runtime directory, Compose output, container logs or credentials.
"""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from r3_artifacts import ROOT, fetch, sha, write
from r3_smoke_status import SmokeStatus
from selfhost_pin import validate, redact_gateway

DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
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
    return [*DOCKER, 'compose', '-p', PROJECT,
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


def tooling(node, status=None):
    status = status or SmokeStatus()
    status.at('NODE_VERSION')
    if not Path(node).is_absolute():
        raise ValueError('Absolute setup-node executable required.')
    version = capture([node, '--version']).decode().strip()
    if version != 'v22.23.3':
        raise ValueError('Disposable Node version differs.')
    status.at('DOCKER_INFO')
    info = json.loads(capture(DOCKER + ['info', '--format', '{{json .}}']))
    # .Id/config_digest comparison below is qualified only for the classic store.
    status.at('IMAGE_STORE')
    if info.get('Driver') != 'overlay2' or any('containerd' in str(row).lower() for row in info.get('DriverStatus', [])):
        raise ValueError('Only the classic overlay2 image store is supported by this smoke.')
    status.at('DOCKER_VERSION')
    docker_version = json.loads(capture(DOCKER + ['version', '--format', '{{json .}}']))
    status.at('COMPOSE_VERSION')
    compose_version = capture(DOCKER + ['compose', 'version', '--short']).decode().strip()
    return {'node_executable': node, 'node': version,
            'docker': docker_version, 'compose': compose_version,
            'image_store': 'classic-overlay2', 'pinned_engine_qualified': False}


def run(output, node, status=None):
    status = status or SmokeStatus()
    status.at('RUNNER_GUARD')
    require_runner(os.environ, platform.system(), platform.machine(), platform.freedesktop_os_release())
    status.at('ROOT_GUARD')
    if os.geteuid() != 0:
        raise ValueError('Disposable runner requires root for fixed QA bind paths.')
    versions = tooling(node, status)
    status.at('EMPTY_RUNNER')
    if capture(DOCKER + ['ps', '-aq']).strip() or Path('/srv/tonyai').exists():
        raise ValueError('Runner is not empty; never remove another runtime.')
    status.at('STAGE_SOURCES')
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
    status.at('GENERATE_SETTINGS')
    capture([node, '--input-type=module', '-e', script, str(runtime / '.env')], cwd=ROOT)
    status.at('BIND_DIRECTORIES')
    for path in ('database/postgres', 'database/db-config', 'database/caddy-data', 'database/caddy-config', 'objects/storage'):
        Path('/srv/tonyai', path).mkdir(parents=True, mode=0o750)
    os.chdir(runtime)
    status.at('REDACT_GATEWAY')
    redact_gateway()
    status.at('COMPOSE_RENDER')
    config = json.loads(capture(compose() + ['--profile', '*', 'config', '--format', 'json']))
    status.at('COMPOSE_VALIDATE')
    check_effective(config, lock)
    images = {}
    for name, item in lock.items():
        status.at('IMAGE_PULL')
        capture(DOCKER + ['pull', '--platform', 'linux/amd64', item['image']])
        status.at('IMAGE_IDENTITY')
        meta = json.loads(capture(DOCKER + ['image', 'inspect', item['image']]))[0]
        if meta['Architecture'] != 'amd64' or meta['Os'] != 'linux' or item['image'] not in meta['RepoDigests']:
            raise ValueError('Image identity mismatch.')
        images[name] = meta['Id']
    status.at('DATABASE_POLICY')
    policy = json.loads((ROOT / 'infra/selfhost/database-image-policy.json').read_bytes())
    if lock['db']['image'] != policy['image'] or images['db'] != policy['config_digest']:
        raise ValueError('Database image policy mismatch.')
    # Seed the image's intrinsic configuration on the disposable runner. This is
    # not a claim that the production mount/IMDS/escrow guards ran here.
    status.at('SEED_CREATE')
    container = capture(DOCKER + ['create', '--pull', 'never', '--entrypoint', 'true', lock['db']['image']]).decode().strip()
    try:
        status.at('SEED_COPY')
        capture(DOCKER + ['cp', '-a', container + ':/etc/postgresql-custom/.', '/srv/tonyai/database/db-config'])
    finally:
        with status.cleanup('seed'):
            capture(DOCKER + ['rm', '-v', container])
    status.at('SEED_METADATA')
    metadata = capture(DOCKER + ['run', '--pull', 'never', '--rm', '--entrypoint', 'stat', lock['db']['image'], '-c', '%u:%g:%a', '/etc/postgresql-custom']).decode().strip()
    uid, gid, mode = metadata.split(':')
    os.chown('/srv/tonyai/database/db-config', int(uid), int(gid))
    Path('/srv/tonyai/database/db-config').chmod(int(mode, 8))
    try:
        status.at('DATABASE_START')
        capture(compose() + ['up', '-d', '--pull', 'never', '--no-build', '--wait', '--wait-timeout', '240', 'db'])
        status.at('DATABASE_KEY')
        if not Path('/srv/tonyai/database/db-config/pgsodium_root.key').is_file():
            raise ValueError('Database intrinsic key was not generated.')
        status.at('SERVICES_START')
        capture(compose() + ['up', '-d', '--pull', 'never', '--no-build', '--wait', '--wait-timeout', '240'])
        status.at('SERVICES_INSPECT')
        ids = capture(compose() + ['ps', '-q']).decode().split()
        containers = json.loads(capture(DOCKER + ['inspect', *ids]))
        status.at('SERVICES_VALIDATE')
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
        status.at('REPORT_BUILD')
        report = {'status': 'COMPOSITION_SMOKE_PASS', 'qa_ready': False, 'tooling': versions,
                  'source_sha': capture(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
                  'image_lock_sha256': sha(lock_bytes), 'services': observed,
                  'unproven': ['Private refused-statement/stable-connection regression',
                              'Realtime image/source correspondence and GCM consumer round-trip',
                              'Offline image transport and pinned installer qualification',
                              'Azure IMDS/disks/firewall/SSH trust and two-stage custody',
                              'R4 credential retirement/activation and application readiness']}
    finally:
        # Only this project; never global prune, volume deletion or DB reset.
        with status.cleanup('compose'):
            capture(compose() + ['down', '--timeout', '30'])
    status.at('REPORT_WRITE')
    write(output / 'summary.json', json.dumps(report, indent=2).encode())


def main(argv):
    status = SmokeStatus()
    try:
        if len(argv) != 2:
            raise ValueError('Private output directory required.')
        run(argv[0], argv[1], status)
    except Exception:
        print(status.failure(), file=sys.stderr)
        return 1
    print('PASS: composition smoke only; full R3 qualification remains gated.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

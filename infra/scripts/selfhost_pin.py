#!/usr/bin/env python3
"""Validate private QA composition and resolve upstream image tags to immutable digests."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


# Digest from the reviewed v0.8.2 upstream lock; the regression test binds both.
GATEWAY_TEMPLATE_SHA256 = "9d9a6d6ea0a372be99e165d995f012d383d5cc8473b92a06b7aa0bbd73566c3d"

class GatewayDestinationError(ValueError):
    """Safe operator diagnostic without runtime values."""


def compose_config(locked=False):
    command = ['docker', 'compose', '--env-file', '.env', '-f', 'docker-compose.yml',
               '-f', 'compose.qa.yml', '-f', 'compose.https.yml']
    if locked:
        command += ['-f', 'compose.images.json']
    command += ['--profile', '*', 'config', '--format', 'json']
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise ValueError('Compose validation failed; rendered secrets withheld.')
    return json.loads(result.stdout)


def validate(config):
    services = config['services']
    required = {'api-gw', 'caddy', 'db', 'storage', 'imgproxy', 'auth'}
    if not required <= set(services):
        raise ValueError('A boundary service is missing.')
    for name, service in services.items():
        if service.get('privileged') or service.get('network_mode') == 'host' or service.get('pid') == 'host' or service.get('cap_add'):
            raise ValueError('Host privileges bypass the container boundary.')
        for volume in service.get('volumes', []):
            if 'docker.sock' in volume.get('source', '') or volume.get('source') in ('/', '/proc', '/sys', '/dev'):
                raise ValueError('Host control mounts are prohibited.')
            if volume.get('source', '').startswith('/srv/tonyai/') and volume.get('bind', {}).get('create_host_path') is not False:
                raise ValueError('Persistent host paths must fail closed when missing.')
        ports = service.get('ports', [])
        expected = {'api-gw': ('127.0.0.1', '8000', 8000), 'caddy': ('0.0.0.0', '443', 443)}.get(name)
        if expected is None and ports:
            raise ValueError('Unexpected published service port.')
        if expected:
            actual = [(p.get('host_ip', '0.0.0.0'), p.get('published'), p['target']) for p in ports]
            if actual != [expected] or ports[0].get('protocol') != 'tcp':
                raise ValueError('Gateway port exposure differs from the reviewed boundary.')
    mounts = {name: {v['target']: v.get('source') for v in services[name].get('volumes', [])} for name in ('db', 'storage', 'imgproxy')}
    if (mounts['db'].get('/var/lib/postgresql/data') != '/srv/tonyai/database/postgres'
            or mounts['db'].get('/etc/postgresql-custom') != '/srv/tonyai/database/db-config'
            or any(mounts[name].get('/var/lib/storage') != '/srv/tonyai/objects/storage' for name in ('storage', 'imgproxy'))):
        raise ValueError('Persistent mounts differ from the reviewed data disks.')
    gateway = [v for v in services['api-gw'].get('volumes', []) if v.get('target') == '/etc/envoy/lds.template.yaml']
    if (len(gateway) != 1 or gateway[0].get('type') != 'bind'
            or not gateway[0].get('source', '').endswith('/volumes/api/envoy/lds.qa.yaml')
            or gateway[0].get('read_only') is not True
            or gateway[0].get('bind', {}).get('create_host_path') is not False):
        raise ValueError('Gateway must bind the generated file read-only without implicit path creation.')
    auth = services['auth']['environment']
    policy = {'GOTRUE_MAILER_OTP_LENGTH': '10', 'GOTRUE_RATE_LIMIT_HEADER': 'X-Forwarded-For',
              'GOTRUE_RATE_LIMIT_VERIFY': '30', 'GOTRUE_RATE_LIMIT_TOKEN_REFRESH': '30',
              'GOTRUE_MAILER_OTP_EXP': '3600', 'GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED': 'true',
              'GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL': '10'}
    if any(str(auth.get(key)) != value for key, value in policy.items()):
        raise ValueError('OTP, rate limiting or refresh policy differs from the reviewed contract.')
    keys = json.loads(auth['GOTRUE_JWT_KEYS'])
    signing = [key for key in keys if 'sign' in key.get('key_ops', [])]
    if (str(auth['GOTRUE_DISABLE_SIGNUP']).lower() != 'true'
            or str(auth['GOTRUE_EXTERNAL_PHONE_ENABLED']).lower() != 'false'
            or str(auth['GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED']).lower() != 'false'
            or str(auth['GOTRUE_PASSWORD_MIN_LENGTH']) != '12'
            or len(signing) != 1 or signing[0].get('alg') != 'ES256'
            or signing[0].get('kty') != 'EC' or signing[0].get('crv') != 'P-256'
            or not all(signing[0].get(field) for field in ('kid', 'd', 'x', 'y'))):
        raise ValueError('Authentication policy differs from the reviewed contract.')


def redact_gateway():
    source = Path('volumes/api/envoy/lds.template.yaml').read_bytes()
    if hashlib.sha256(source).hexdigest() != GATEWAY_TEMPLATE_SHA256:
        raise ValueError('Gateway template differs from the reviewed source digest.')
    template = source.decode()
    lines = template.splitlines(keepends=True)
    matches = [i for i, line in enumerate(lines) if 'inline_string:' in line and '%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%' in line]
    if len(matches) != 1:
        raise ValueError('Reviewed gateway log anchor changed.')
    lines[matches[0]] = '                        inline_string: "%RESPONSE_CODE% %BYTES_RECEIVED% %BYTES_SENT% %DURATION%\\n"\n'
    target = Path('volumes/api/envoy/lds.qa.yaml')
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise GatewayDestinationError('volumes/api/envoy/lds.qa.yaml is not a regular file; inspect and manually remove the leftover directory or symlink before restarting. Never remove the upstream template.')
    target.write_text(''.join(lines))
    target.chmod(0o644)


def main():
    target = Path('compose.images.json')
    if target.exists():
        raise ValueError('Image lock exists; use an explicit reviewed upgrade instead of repinning tags.')
    redact_gateway()
    config = compose_config()
    validate(config)
    locked = json.loads(Path(sys.argv[1]).read_text())['services'] if len(sys.argv) == 2 else None
    if locked is not None and (set(locked) != set(config['services']) or any(
            set(value) != {'image', 'platform'} or value['platform'] != 'linux/amd64'
            or not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', value['image'])
            for value in locked.values())):
        raise ValueError('Reviewed image lock differs from the service contract.')
    pinned = {}
    for name, service in config['services'].items():
        reference = locked[name]['image'] if locked is not None else service['image']
        subprocess.run(['docker', 'pull', '--platform', 'linux/amd64', reference], check=True)
        result = subprocess.run(['docker', 'image', 'inspect', reference, '--format', '{{json .RepoDigests}}'], capture_output=True, text=True, check=True)
        digests = json.loads(result.stdout)
        if not digests or not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', digests[0]):
            raise ValueError('Pulled image has no immutable repository digest.')
        if locked is not None and reference not in digests:
            raise ValueError('Pulled image does not match its recorded digest.')
        pinned[name] = {'image': reference if locked is not None else digests[0], 'platform': 'linux/amd64'}
    with target.open('x') as stream:
        json.dump({'services': pinned}, stream, indent=2)
        stream.write('\n')
    target.chmod(0o600)
    print('PASS: all service images pinned; private ports, mounts and Auth policy verified.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: runtime preparation failed; inspect privately. No rendered configuration emitted.')

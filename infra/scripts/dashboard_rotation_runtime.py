"""Narrow local Docker/HTTP adapter; private subprocess payloads never escape."""
import base64
import copy
import json
from pathlib import Path
import re
import subprocess
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request

from dashboard_rotation_store import digest, read
from selfhost_pin import validate, GATEWAY_TEMPLATE_SHA256

FILES = ['docker-compose.yml', 'compose.qa.yml', 'compose.https.yml', 'compose.images.json']


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Runtime:
    def __init__(self, store, source):
        self.store, self.source = store, Path(source)
        self.base = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
        self.compose = [*self.base, 'compose', '--project-name', 'supabase',
                        '--project-directory', str(store.runtime), '--env-file', str(store.env)]
        for name in FILES:
            self.compose += ['-f', str(store.runtime / name)]

    def call(self, command):
        result = subprocess.run(command, cwd=self.store.runtime, capture_output=True,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'},
                                timeout=300, check=False)
        if result.returncode:
            raise ValueError('Private Docker operation failed.')
        return result.stdout

    def sources(self):
        result = {}
        for name in ('selfhost_dashboard_rotation.py', 'dashboard_rotation_store.py',
                     'dashboard_rotation_runtime.py', 'selfhost_pin.py', 'upstream.lock.json',
                     'images.qa.lock.json', 'compose.qa.yml', 'compose.https.yml', 'Caddyfile'):
            result['helper/' + name] = digest(read(self.source / name))
        lock = json.loads(read(self.source / 'upstream.lock.json'))
        for name in ('docker-compose.yml', 'volumes/api/envoy/docker-entrypoint.sh',
                     'volumes/api/envoy/envoy.yaml', 'volumes/api/envoy/cds.yaml',
                     'volumes/api/envoy/lds.template.yaml'):
            result[name] = digest(read(self.store.runtime / name))
            if result[name] != lock['files'][name]:
                raise ValueError('Pinned upstream source mismatch.')
        for name in ('compose.qa.yml', 'compose.https.yml', 'Caddyfile'):
            result[name] = digest(read(self.store.runtime / name))
            if result[name] != result['helper/' + name]:
                raise ValueError('Reviewed overlay mismatch.')
        images = read(self.store.runtime / 'compose.images.json')
        if json.loads(images) != json.loads(read(self.source / 'images.qa.lock.json')):
            raise ValueError('Runtime images differ from reviewed lock.')
        result['compose.images.json'] = digest(images)
        template = read(self.store.runtime / 'volumes/api/envoy/lds.template.yaml')
        if digest(template) != GATEWAY_TEMPLATE_SHA256:
            raise ValueError('Gateway template differs from reviewed source.')
        lines = template.decode().splitlines(keepends=True)
        indexes = [i for i, line in enumerate(lines) if 'inline_string:' in line and '%REQ(X-ENVOY-ORIGINAL-PATH?:PATH)%' in line]
        if len(indexes) != 1:
            raise ValueError('Gateway logging anchor changed.')
        lines[indexes[0]] = '                        inline_string: "%RESPONSE_CODE% %BYTES_RECEIVED% %BYTES_SENT% %DURATION%\\n"\n'
        derived = read(self.store.runtime / 'volumes/api/envoy/lds.qa.yaml')
        if derived != ''.join(lines).encode():
            raise ValueError('Derived gateway source mismatch; do not regenerate during rotation.')
        result['lds.qa.yaml'] = digest(derived)
        return result

    def configuration(self, username, password, gateway_id=None):
        value = json.loads(self.call(self.compose + ['--profile', '*', 'config', '--format', 'json']))
        validate(value)
        services = value['services']
        for name, service in services.items():
            if not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', service['image']):
                raise ValueError('Mutable image refused.')
            env = service.get('environment', {})
            if name != 'api-gw' and any(k.startswith('DASHBOARD_') for k in env):
                raise ValueError('Unexpected dashboard credential consumer.')
        gateway = services['api-gw']
        if (gateway['environment'].get('DASHBOARD_USERNAME') != username.decode()
                or gateway['environment'].get('DASHBOARD_PASSWORD') != password.decode()
                or gateway.get('restart') != 'unless-stopped'
                or gateway.get('container_name') != 'supabase-envoy'
                or gateway.get('entrypoint') != ['/bin/sh', '/docker-entrypoint.sh']):
            raise ValueError('Gateway consumer differs from reviewed contract.')
        if gateway_id is not None:
            defaults = json.loads(self.call(self.base + ['image', 'inspect', '--format',
                                                        '{{json .Config.Env}}', gateway['image']]))
            expected = self.parse_environment(defaults or [])
            for key, env_value in gateway['environment'].items():
                if env_value is None:
                    expected.pop(key, None)
                else:
                    expected[key] = env_value
            if self.gateway_environment(gateway_id) != expected:
                raise ValueError('Running composition has unrelated environment drift.')
        public = copy.deepcopy(value)
        del public['services']['api-gw']['environment']['DASHBOARD_PASSWORD']
        # This is a hash of private configuration, not a publication artifact.
        return digest(json.dumps(public, sort_keys=True).encode())

    def inventory(self, check_gateway=True):
        ids = self.call(self.base + ['ps', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=supabase']).decode().split()
        if not ids or any(not re.fullmatch(r'[a-f0-9]{64}', value) for value in ids):
            raise ValueError('Invalid runtime inventory.')
        result = {}
        projection = ('{"id":{{json .Id}},"name":{{json .Name}},'
                      '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                      '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                      '"image":{{json .Config.Image}},"running":{{json .State.Running}},'
                      '"started":{{json .State.StartedAt}},"restart":{{json .HostConfig.RestartPolicy.Name}},'
                      '"ports":{{json .HostConfig.PortBindings}}}')
        for identifier in ids:
            item = json.loads(self.call(self.base + ['inspect', '--format', projection, identifier]))
            service = item['service']
            if (not service or service in result or item['project'] != 'supabase'
                    or item['id'] != identifier):
                raise ValueError('Ambiguous service identity.')
            result[service] = item
        if check_gateway:
            self.gateway(result)
        return result

    def gateway(self, inventory):
        item = inventory['api-gw']
        locked = json.loads(read(self.source / 'images.qa.lock.json'))['services']['api-gw']['image']
        if (item['name'] != '/supabase-envoy' or item['image'] != locked
                or item['restart'] != 'unless-stopped'
                or item['ports'] != {'8000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '8000'}]}):
            raise ValueError('Unexpected live gateway identity or exposure.')
        return item

    def gateway_environment(self, identifier):
        values = json.loads(self.call(self.base + ['inspect', '--format', '{{json .Config.Env}}', identifier]))
        return self.parse_environment(values)

    @staticmethod
    def parse_environment(values):
        parsed = [value.split('=', 1) for value in values]
        if any(len(pair) != 2 for pair in parsed) or len({p[0] for p in parsed}) != len(parsed):
            raise ValueError('Ambiguous gateway environment.')
        return dict(parsed)

    def require_stopped(self, inventory, password):
        item = self.gateway(inventory)
        if item['running'] or self.gateway_environment(item['id']).get('DASHBOARD_PASSWORD') != password.decode():
            raise ValueError('Stop the bound old-credential gateway before preparing rotation.')

    def require_dependencies(self, original):
        current = self.inventory()
        if {k: v for k, v in current.items() if k != 'api-gw'} != {k: v for k, v in original.items() if k != 'api-gw'}:
            raise ValueError('A dependency changed during maintenance.')

    def recreate(self):
        self.call(self.compose + ['up', '-d', '--no-deps', '--force-recreate', '--pull', 'never',
                                  '--no-build', '--wait', '--wait-timeout', '240', 'api-gw'])

    def stop(self):
        # Failed exposure/image checks must not prevent containment. Bind only
        # the intended identity, then stop that exact ID without rendering Compose.
        item = self.inventory(check_gateway=False)['api-gw']
        if (item['name'] != '/supabase-envoy' or item['project'] != 'supabase'
                or item['service'] != 'api-gw' or not re.fullmatch(r'[a-f0-9]{64}', item['id'])):
            raise ValueError('Gateway identity ambiguous; private containment required.')
        self.call(self.base + ['stop', '--time', '30', item['id']])
        if json.loads(self.call(self.base + ['inspect', '--format', '{{json .State.Running}}', item['id']])) is not False:
            raise ValueError('Gateway stop not confirmed.')

    def status(self, username=None, password=None):
        request = Request('http://127.0.0.1:8000/project/default')
        if username is not None:
            request.add_header('Authorization', 'Basic ' + base64.b64encode(username + b':' + password).decode())
        opener = build_opener(ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=10) as response:
                return response.status
        except HTTPError as error:
            code = error.code
            error.close()
            return code

    def verify(self, username, password, old, original):
        self.require_dependencies(original)
        item = self.gateway(self.inventory())
        env = self.gateway_environment(item['id'])
        if (not item['running'] or item['id'] == original['api-gw']['id']
                or env.get('DASHBOARD_USERNAME') != username.decode()
                or env.get('DASHBOARD_PASSWORD') != password.decode()):
            raise ValueError('New gateway credential not active.')
        if (self.status() != 401 or (old is not None and self.status(username, old) != 401)
                or self.status(username, password) != 200):
            raise ValueError('Private dashboard acceptance failed.')

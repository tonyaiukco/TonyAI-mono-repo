#!/usr/bin/env python3
"""Deploy one reviewed application manifest, then verify independent ARM readback."""
import argparse
import json
from pathlib import Path
import sys
from configure_oidc import az
from pooler import SafeFailure
from terraform_run import invoke, validate_release


def verify(inputs, read=az):
    foundation, release = validate_release(inputs)
    stem = foundation['prefix'] + '-' + foundation['environment']
    group_id = '/subscriptions/' + foundation['subscription_id'] + '/resourceGroups/' + foundation['resource_group']
    for kind in ('api', 'web'):
        app = read('containerapp', 'show', '--subscription', foundation['subscription_id'],
                   '-g', foundation['resource_group'], '-n', stem + '-' + kind)
        properties = app['properties']
        container = properties['template']['containers'][0]
        expected_image = foundation['registry_name'] + '.azurecr.io/tonyai/' + kind + '@' + release[kind + '_digest']
        if container.get('image') != expected_image:
            raise SafeFailure('Deployed image differs from selected release.')
        if kind == 'api':
            env = {item['name']: item for item in container.get('env', [])}
            if (env.get('DATABASE_URL') != {'name': 'DATABASE_URL', 'secretRef': 'database-url'}
                    or 'DIRECT_URL' in env):
                raise SafeFailure('API must receive only the runtime database reference.')
            expected_settings = {'STORAGE_CLEANUP_HOLD': '1' if release['storage_cleanup_hold'] else '0',
                                 'STORAGE_SWEEP_INTERVAL_SECONDS': str(release['storage_sweep_interval_seconds'])}
            if any(env.get(key, {}).get('value') != value for key, value in expected_settings.items()):
                raise SafeFailure('Storage operational settings differ from the release.')
            probes = {item['type']: item for item in container.get('probes', [])}
            for probe in ('Startup', 'Liveness', 'Readiness'):
                path = '/api/v1/health/ready' if probe == 'Readiness' else '/api/v1/health'
                if probes.get(probe, {}).get('httpGet', {}).get('path') != path:
                    raise SafeFailure('Health probes differ from the release contract.')
        configuration = properties['configuration']
        expected_fqdn = stem + '-' + kind + '.' + foundation['default_domain']
        if (configuration['ingress'].get('allowInsecure') is not False
                or configuration['ingress'].get('fqdn') != expected_fqdn
                or properties.get('latestReadyRevisionName') != stem + '-' + kind + '--' + release['release_id']):
            raise SafeFailure('Selected HTTPS revision is not ready at the expected origin.')
        actual = {item['name']: item for item in configuration.get('secrets', [])}
        expected = {} if kind == 'web' else {
            'database-url': release['database_secret_version'],
            'supabase-service-role-key': release['backend_secret_version'],
        }
        if set(actual) != set(expected):
            raise SafeFailure('Unexpected runtime secret set.')
        for name, version in expected.items():
            identity = group_id + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + stem + '-api'
            uri = 'https://' + foundation['vault_name'] + '.vault.azure.net/secrets/' + name + '/' + version
            if actual[name].get('keyVaultUrl') != uri or actual[name].get('identity') != identity or actual[name].get('value'):
                raise SafeFailure('Runtime secret does not match the exact reference and identity.')
    print('PASS: both ready revisions, image digests, HTTPS origins and exact secret references match the release.')


def check_hold_transition(inputs, acknowledge=False, read=az):
    """Refuse an implicit restore-hold release before any plan/apply."""
    foundation, release = validate_release(inputs)
    if release['storage_cleanup_hold']:
        return
    name = foundation['prefix'] + '-' + foundation['environment'] + '-api'
    app = read('containerapp', 'show', '--subscription', foundation['subscription_id'],
               '-g', foundation['resource_group'], '-n', name, '--query',
               '{name:name,containers:properties.template.containers}')
    if not isinstance(app, dict) or app.get('name') != name:
        raise SafeFailure('Cannot determine the live cleanup hold; deployment refused.')
    containers = app['containers']
    holds = [item.get('value') for container in containers for item in container.get('env', [])
             if item['name'] == 'STORAGE_CLEANUP_HOLD']
    if holds != ['0'] and not acknowledge:
        raise SafeFailure('Live cleanup hold is on or unknown. Read the restore reports before using --ack-clear-storage-hold.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--ack-clear-storage-hold', action='store_true',
                        help='Acknowledge reviewed restore reports before clearing an existing cleanup hold.')
    parser.add_argument('--approved-apply', action='store_true',
                        help='Apply a saved application plan after protected environment approval.')
    args = parser.parse_args()
    inputs = json.loads(Path(args.inputs).read_text())
    validate_release(inputs)
    if not args.verify_only:
        check_hold_transition(inputs, args.ack_clear_storage_hold)
        if args.approved_apply:
            invoke('application', args.backend, args.inputs, 'approved-apply')
        else:
            invoke('application', args.backend, args.inputs, 'plan')
            invoke('application', args.backend, args.inputs, 'apply')
    verify(inputs)


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except Exception:
        sys.exit('FAIL: deployment/readback failed; details withheld. Inspect release status before retrying.')

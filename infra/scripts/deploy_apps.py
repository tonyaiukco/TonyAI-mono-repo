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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', required=True)
    parser.add_argument('--inputs', required=True)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    inputs = json.loads(Path(args.inputs).read_text())
    validate_release(inputs)
    if not args.verify_only:
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

#!/usr/bin/env python3
"""Owner-run, create-or-resume recorded Entra federation; no cloud passwords are created."""
import argparse
import hashlib
import json
import re
import sys
from cloud_ops import command
from pooler import SafeFailure
from github_environment import verify_environment


def az(*args):
    return json.loads(command(['az', *args, '--output', 'json', '--only-show-errors']))


def validate_owners(kind, identity, operator):
    owners = az('ad', kind, 'owner', 'list', '--id', identity)
    if not isinstance(owners, list) or any(owner.get('id') != operator for owner in owners):
        raise SafeFailure('Entra owners must be empty or only the signed-in project owner.')


def configure(subscription, group, repo):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise SafeFailure('Invalid GitHub repository.')
    resource = az('group', 'show', '--subscription', subscription, '-n', group)
    if resource.get('tags', {}).get('environment') != 'staging':
        raise SafeFailure('Refusing a resource group not tagged staging.')
    if resource.get('tags', {}).get('githubRepository') != repo:
        raise SafeFailure('Repository differs from the foundation githubRepository tag.')
    verify_environment(repo)
    name = 'tonyai-staging-github-' + hashlib.sha256(resource['id'].lower().encode()).hexdigest()[:12]
    # Exact display name is deterministic per subscription/RG; ambiguity fails closed.
    apps = az('ad', 'app', 'list', '--display-name', name)
    apps = [app for app in apps if app['displayName'] == name]
    if len(apps) > 1:
        raise SafeFailure('Multiple matching Entra apps; resolve duplicates in the portal.')
    operator = az('ad', 'signed-in-user', 'show').get('id')
    if not isinstance(operator, str) or not operator:
        raise SafeFailure('A signed-in project owner is required.')
    saved = resource.get('tags', {}).get('githubClientId')
    if saved:
        app = az('ad', 'app', 'show', '--id', saved)
    else:
        if apps:
            raise SafeFailure('Unrecorded Entra app already uses the staging name; refusing adoption.')
        app = az('ad', 'app', 'create', '--display-name', name, '--sign-in-audience', 'AzureADMyOrg')
    client = app['appId']
    if (app['displayName'] != name or (saved and client != saved)
            or any(match['appId'] != client for match in apps)):
        raise SafeFailure('Saved Entra app does not match the dedicated staging application.')
    if app.get('passwordCredentials') or app.get('keyCredentials'):
        raise SafeFailure('Existing Entra app has password/certificate credentials; review before federation.')
    validate_owners('app', client, operator)
    # Record the validated app before service-principal creation (which may need a retry).
    az('group', 'update', '--subscription', subscription, '-n', group, '--set', 'tags.githubClientId=' + client)
    principals = az('ad', 'sp', 'list', '--filter', "appId eq '" + client + "'")
    if len(principals) > 1:
        raise SafeFailure('Ambiguous service principal.')
    principal = principals[0] if principals else az('ad', 'sp', 'create', '--id', client)
    # Read credential metadata from the object itself, not the list/create response.
    principal = az('ad', 'sp', 'show', '--id', principal['id'])
    if (principal.get('appId') != client
            or resource.get('tags', {}).get('githubPrincipalId', principal['id']) != principal['id']):
        raise SafeFailure('Saved service principal does not match the dedicated application.')
    if principal.get('passwordCredentials') != [] or principal.get('keyCredentials') != []:
        raise SafeFailure('Service principal credentials must be explicitly empty; review before federation.')
    validate_owners('sp', principal['id'], operator)
    # Save the validated pair, including when later federation operations fail.
    az('group', 'update', '--subscription', subscription, '-n', group, '--set',
       'tags.githubClientId=' + client, 'tags.githubPrincipalId=' + principal['id'])
    credentials = az('ad', 'app', 'federated-credential', 'list', '--id', client)
    if any(item['name'] != 'github-staging' for item in credentials):
        raise SafeFailure('Unexpected federation on the deployment app; review before reuse.')
    desired = {'name': 'github-staging', 'issuer': 'https://token.actions.githubusercontent.com',
               'subject': 'repo:' + repo + ':environment:staging', 'audiences': ['api://AzureADTokenExchange']}
    existing = next(iter(credentials), None)
    if existing and any(existing.get(key) != value for key, value in desired.items()):
        raise SafeFailure('Existing federation differs; owner must reconcile it explicitly in Entra.')
    if not existing:
        # Nonsecret JSON only, passed as an argument rather than a persistent file.
        az('ad', 'app', 'federated-credential', 'create', '--id', client, '--parameters', json.dumps(desired))
    print('PASS: recorded staging app/principal have trusted owners, no password/certificate credentials, and exact federation.')
    print('Client ID: ' + client + '; principal object ID: ' + principal['id'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subscription', required=True)
    parser.add_argument('--group', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--environment-protection-verified', required=True, action='store_true')
    args = parser.parse_args()
    try:
        configure(args.subscription, args.group, args.repo)
    except SafeFailure as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('FAIL: identity configuration failed; sensitive details withheld.', file=sys.stderr)
        sys.exit(1)

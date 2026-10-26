#!/usr/bin/env python3
"""Verify public ARM projections against a bound QA release; never reads secrets."""
import argparse
from qa_contract import GROUP, SUBNET, load, origins, release, require
from qa_expected import body, canonical, identity


def runtime_shape(expected, actual):
    """Refuse additional execution surfaces, allowing only inert ARM defaults."""
    template = actual['properties']['template']
    wanted = expected['properties']['template']
    for key in set(template) - set(wanted):
        require(key in ('initContainers', 'volumes', 'serviceBinds') and template[key] in (None, []))
    for container in template['containers']:
        for key in set(container) - set(wanted['containers'][0]):
            require(key in ('command', 'args', 'volumeMounts') and container[key] in (None, []))
    ingress = actual['properties']['configuration']['ingress']
    defaults = {'fqdn': ingress.get('fqdn'), 'exposedPort': 0, 'clientCertificateMode': 'ignore',
                'customDomains': [], 'ipSecurityRestrictions': [], 'corsPolicy': None,
                'additionalPortMappings': [], 'stickySessions': None,
                'traffic': [{'latestRevision': True, 'weight': 100}]}
    for key in set(ingress) - set(expected['properties']['configuration']['ingress']):
        require(key in defaults and (ingress[key] == defaults[key] or ingress[key] is None))
    config = actual['properties']['configuration']
    for key in ('dapr', 'service'):
        require(config.get(key) is None)


def subset(expected, actual):
    """Allow ARM's default object fields, but no extra containers/env/secrets."""
    if isinstance(expected, dict):
        require(isinstance(actual, dict))
        for key, value in expected.items():
            require(key in actual)
            subset(value, actual[key])
    elif isinstance(expected, list):
        require(isinstance(actual, list) and len(expected) == len(actual))
        for left, right in zip(canonical(expected), canonical(actual)):
            subset(left, right)
    else:
        require(expected == actual)


def verify(inputs, environment, apps, revisions):
    require(environment['id'] == GROUP + '/providers/Microsoft.App/managedEnvironments/tonyai-staging-env')
    require(environment['location'] == 'swedencentral')
    subset({'vnetConfiguration': {'infrastructureSubnetId': SUBNET, 'internal': False},
            'workloadProfiles': [{'name': 'Consumption', 'workloadProfileType': 'Consumption'}],
            'defaultDomain': inputs['foundation']['default_domain']}, environment['properties'])
    require(set(apps) == {'api', 'web'} and set(revisions) == {'api', 'web'})
    for kind, app in apps.items():
        require(app['id'] == GROUP + '/providers/Microsoft.App/containerApps/tonyai-staging-' + kind)
        require(app['location'] == 'swedencentral')
        require(app['identity']['type'] == 'UserAssigned' and set(app['identity']['userAssignedIdentities']) == {identity(kind)})
        expected = body(inputs, kind)
        runtime_shape(expected, app)
        subset(expected, app)
        props = app['properties']
        require(props['provisioningState'] == 'Succeeded')
        require(props['configuration']['ingress']['fqdn'] == origins(inputs['foundation'])[kind].removeprefix('https://'))
        intended = f"tonyai-staging-{kind}--{inputs['release']['release_id']}"
        require(props['latestReadyRevisionName'] == intended)
        require([r['name'] for r in revisions[kind] if r['properties']['active']] == [intended])
        for container in props['template']['containers']:
            for item in container['env']:
                require(not (item.get('value') and item.get('secretRef')))
        require(all(not s.get('value') for s in props['configuration'].get('secrets', [])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('inputs', 'candidate', 'environment', 'apps', 'revisions'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        inputs = release(load(args.inputs), load(args.candidate))
        verify(inputs, load(args.environment), load(args.apps), load(args.revisions))
    except Exception:
        raise SystemExit('FAIL: QA ARM readback refused; keep acceptance open.') from None
    print('PASS: public QA ARM projection matches the release; TLS, login and tenant acceptance remain separate.')

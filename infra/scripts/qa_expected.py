"""Independent application-plan/readback oracle; never uses Terraform outputs."""
from qa_contract import GROUP, origins
from runtime_limits import validate_limits


def identity(kind):
    return GROUP + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/tonyai-staging-' + kind


def body(inputs, kind):
    foundation, rel = inputs['foundation'], inputs['release']
    api = kind == 'api'
    port = 3001 if api else 3000
    limits = validate_limits(rel['runtime_limits'])
    versions = {'database-url': rel['database_secret_version'], 'supabase-service-role-key': rel['backend_secret_version']}
    if 'mail' in rel:
        versions['smtp-password'] = rel['mail']['password_secret_version']
    values = {'NODE_ENV': 'production', 'PORT': str(port)}
    references = {}
    if api:
        values.update({
            'NODE_OPTIONS': '--max-old-space-size=768', 'PROXY_MODE': 'azure', 'AZURE_INGRESS_ONLY': 'true',
            'STORAGE_CLEANUP_HOLD': '1' if rel['storage_cleanup_hold'] else '0',
            'STORAGE_SWEEP_INTERVAL_SECONDS': str(rel['storage_sweep_interval_seconds']),
            'LOG_FORMAT': 'json', 'SUPABASE_URL': rel['supabase_origin'],
            'SUPABASE_JWT_SCHEME': 'jwks', 'SUPABASE_JWT_ISSUER': rel['jwt_issuer'],
            'APP_URL': origins(foundation)['web'], 'WEB_ORIGIN': origins(foundation)['web'],
            **{key: str(value) for key, value in limits.items()},
        })
        references = {'DATABASE_URL': 'database-url', 'SUPABASE_SERVICE_ROLE_KEY': 'supabase-service-role-key'}
        if 'mail' in rel:
            mail = rel['mail']
            values.update({'SMTP_HOST': mail['host'], 'SMTP_PORT': str(mail['port']),
                           'SMTP_SECURE': str(mail['secure']).lower(), 'SMTP_USER': mail['user'], 'MAIL_FROM': mail['from']})
            references['SMTP_PASSWORD'] = 'smtp-password'
    else:
        values.update({'HOSTNAME': '0.0.0.0', 'SUPABASE_URL_INTERNAL': rel['supabase_origin']})
    env = [{'name': name, 'value': value} for name, value in values.items()]
    env += [{'name': name, 'secretRef': value} for name, value in references.items()]
    registry = foundation['registry_name'] + '.azurecr.io'
    return {'properties': {
        'environmentId': GROUP + '/providers/Microsoft.App/managedEnvironments/tonyai-staging-env',
        'workloadProfileName': 'Consumption',
        'configuration': {
            'activeRevisionsMode': 'Single',
            'ingress': {'external': True, 'allowInsecure': False, 'targetPort': port, 'transport': 'auto'},
            'registries': [{'server': registry, 'identity': identity(kind)}],
            'secrets': [{'name': name, 'keyVaultUrl': f"https://{foundation['vault_name']}.vault.azure.net/secrets/{name}/{version}",
                         'identity': identity('api')} for name, version in versions.items()] if api else [],
        },
        'template': {
            'terminationGracePeriodSeconds': (limits['SHUTDOWN_GRACE_MS'] + 999) // 1000 if api else 30,
            'revisionSuffix': rel['release_id'],
            'containers': [{'name': kind, 'image': f"{registry}/tonyai/{kind}@{rel[kind + '_digest']}",
                            'env': env, 'resources': {'cpu': 1 if api else 0.5, 'memory': '2Gi' if api else '1Gi'},
                            'probes': [{'type': probe, 'httpGet': {
                                'path': ('/api/v1/health/ready' if probe == 'Readiness' else '/api/v1/health') if api else '/login',
                                'port': port, 'scheme': 'HTTP'},
                                'periodSeconds': 5 if probe == 'Startup' else 10, 'timeoutSeconds': 5,
                                'failureThreshold': 60 if probe == 'Startup' else 3}
                                for probe in ('Startup', 'Liveness', 'Readiness')]}],
            'scale': {'minReplicas': 1 if api else 0, 'maxReplicas': 1 if api else 2,
                      'rules': [] if api else [{'name': 'http', 'http': {'metadata': {'concurrentRequests': '10'}}}]},
        },
    }}


def canonical(value):
    """ARM named arrays are order-insensitive; retain duplicates and all fields."""
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()}
    if isinstance(value, list):
        items = [canonical(v) for v in value]
        if items and all(isinstance(v, dict) and ('name' in v or 'type' in v) for v in items):
            return sorted(items, key=lambda v: v.get('name', v.get('type')))
        return items
    return value

"""Sweden smoke bindings. Public documents prove consistency, never authorization."""
from cloud_smoke import target_for as legacy_target
from qa_contract import fields, match, origins, require
from qa_deployment_contract import accepted_history
from qa_discovery import digest


def bind(evidence, accepted_sha256, *, now=None):
    match(r'[a-f0-9]{64}', accepted_sha256)
    require(digest(evidence) == accepted_sha256)
    return accepted_history(evidence, now=now)


def target_for(inputs, tenants=None):
    rel = inputs['release']
    urls = origins(inputs['foundation'])
    if tenants is None:
        tenants = legacy_target(dict(source_sha=rel['source_sha'], supabase_project_ref='',
                                     web_origin=urls['web'], api_origin=urls['api']))['tenants']
    return dict(mode='qa-sweden', sourceSha=rel['source_sha'], releaseId=rel['release_id'],
                apiDigest=rel['api_digest'], webDigest=rel['web_digest'],
                dbCaSha256=rel['db_ca_sha256'], web=urls['web'], api=urls['api'] + '/api/v1',
                supabase=rel['supabase_origin'], tenants=tenants)


def validate_target(target, inputs):
    fields(target, 'mode sourceSha releaseId apiDigest webDigest dbCaSha256 web api supabase tenants')
    require(target == target_for(inputs, target['tenants']))
    tenants = target['tenants']
    require(isinstance(tenants, list) and len(tenants) == 2)
    identifiers = []
    for tenant in tenants:
        fields(tenant, 'userId organisationId subsidiaryId email name')
        for key in ('userId', 'organisationId', 'subsidiaryId'):
            match(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', tenant[key])
            identifiers.append(tenant[key])
        require(tenant['email'] == 'lp2-smoke-' + tenant['userId'] + '@tonyai.test'
                and tenant['name'] == 'LP2 smoke ' + tenant['organisationId'])
    require(len(set(identifiers)) == 6)


def validate_journal(journal, expected_hash, evidence, inputs):
    match(r'[a-f0-9]{64}', expected_hash)
    fields(journal, 'schema evidence_sha256 target')
    require(type(journal['schema']) is int and journal['schema'] == 1
            and digest(journal) == expected_hash and journal['evidence_sha256'] == digest(evidence))
    validate_target(journal['target'], inputs)
    return journal['target']

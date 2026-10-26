"""Application plan envelope and AzAPI request options, independent of plan outputs."""
from qa_discovery import timestamp
from qa_contract import has_unknown, require
from qa_foundation_plan import DEFAULT_OPTIONS, EMPTY_OPTIONS


def tags(inputs):
    return dict(application='TonyAI', environment='staging', task='LP2-01',
                release=inputs['release']['release_id'], source=inputs['release']['source_sha'])


def envelope(plan, inputs):
    timestamp(plan.get('timestamp'))
    require(plan.get('terraform_version') == '1.13.3' and plan.get('format_version') in ('1.0', '1.1', '1.2'))
    require(plan.get('complete') is True and plan.get('errored') is False and plan.get('applyable') is True)
    require(not plan.get('resource_drift') and not plan.get('deferred_changes'))
    require(all(c.get('status') == 'pass' for c in plan.get('checks', [])))
    outputs = plan.get('output_changes', {})
    require(set(outputs) == {'reviewed_inputs'})
    output = outputs['reviewed_inputs']
    normalized = {**inputs, 'release': {**inputs['release'], 'mail': inputs['release'].get('mail')}}
    require(output.get('after') == normalized and not has_unknown(output.get('after_unknown', False))
            and not has_unknown(output.get('after_sensitive', False)))
    require(output.get('actions') in (['create'], ['update'], ['no-op']))


def resource_options(row, inputs, source_bound):
    require(row.get('provider_name') == 'registry.terraform.io/azure/azapi')
    require(not any(row.get(k) for k in ('module_address', 'previous_address', 'deposed')))
    change = row['change']
    require(not any(change.get(k) for k in ('importing', 'generated_config', 'replace_paths')))
    require(not has_unknown(change.get('after_sensitive', False)))
    after, unknown = change['after'], dict(change.get('after_unknown', {}))
    request_fields = {'body', 'identity', 'location', 'name', 'parent_id', 'response_export_values', 'tags', 'type'}
    require(set(after) <= request_fields | set(DEFAULT_OPTIONS) | set(EMPTY_OPTIONS) | {'id', 'output'})
    require(after.get('tags') == tags(inputs))
    # Only provider computed outputs and identity outputs may be unknown. The
    # four defaults are unknown in real mocked creates; source binding is required.
    for key in ('id', 'output'):
        unknown.pop(key, None)
    identity_mask = unknown.pop('identity', [{}])
    require(isinstance(identity_mask, list) and len(identity_mask) == 1 and isinstance(identity_mask[0], dict))
    mask = dict(identity_mask[0])
    for key in ('principal_id', 'tenant_id'):
        mask.pop(key, None)
    require(set(mask) <= {'type', 'identity_ids'} and not has_unknown(mask))
    for key, expected in DEFAULT_OPTIONS.items():
        if unknown.pop(key, False) is True:
            require(source_bound and after.get(key) is None)
        else:
            require(type(after.get(key)) is bool and after[key] == expected)
    for key in EMPTY_OPTIONS:
        require(after.get(key) is None and not has_unknown(unknown.pop(key, False)))
    require(set(unknown) <= request_fields and not has_unknown(unknown))
    if change['actions'] == ['create']:
        require(change.get('before') is None)
    if change['actions'] == ['no-op']:
        require(change.get('before') == after)

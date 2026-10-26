"""Revalidate the inspector's public report before correlating fresh readbacks."""
from pathlib import Path
from qa_contract import ROOT, fields, match, require, sha256
from qa_discovery import digest, timestamp
from qa_foundation import QA_ROOT, CONFIG_FILES
from qa_foundation_inputs import UUID
from qa_foundation_expected import expected
from qa_runtime_contract import grants
from qa_oidc_contract import predecessor
from qa_oidc_expected import additions, resource_id


def validate(request, evidence, report, *, now=None, source_root=ROOT):
    before, after, _, principals = predecessor(request,evidence,now=now)
    fields(report, 'resource_count actions resources additions principals release_principal_id oidc_client_id '
        'computed_references_require_post_apply_readback source_tag_change source_sha previous_source_sha saved_plan_path '
        'terraform_path terraform_version terraform_binary_sha256 plan_created_at plan_sha256 request_sha256 '
        'predecessor_sha256 previous_plan_sha256 previous_readback_sha256 previous_owner_acceptance_sha256 '
        'before_inputs_sha256 after_inputs_sha256 provider_lock_sha256 deployment_policy_sha256 configuration_sha256', 'file_sha256')
    require(report['source_sha']==after['release_sha'] and report['previous_source_sha']==before['release_sha']
        and report['request_sha256']==digest(request) and report['predecessor_sha256']==digest(evidence)
        and report['before_inputs_sha256']==digest(before) and report['after_inputs_sha256']==digest(after)
        and report['previous_plan_sha256']==evidence['saved_plan']['plan_sha256']
        and report['previous_readback_sha256']==digest(evidence['after_receipt'])
        and report['previous_owner_acceptance_sha256']==evidence['owner_acceptance_sha256']
        and report['terraform_version']=='1.13.3' and report['principals']==principals)
    for key,value in report.items():
        if key.endswith('_sha256') and key!='file_sha256': match(r'[a-f0-9]{64}',value)
    for value in report.get('file_sha256',{}).values(): match(r'[a-f0-9]{64}',value)
    for key in ('saved_plan_path','terraform_path'): require(Path(report[key]).is_absolute())
    require(report['provider_lock_sha256']==sha256((source_root/'infra/terraform/foundation/qa/.terraform.lock.hcl').read_bytes())
        and report['deployment_policy_sha256']==sha256((source_root/'infra/config/deployment-policy.json').read_bytes())
        and report['configuration_sha256']==digest({n:sha256((source_root/'infra/terraform/foundation/qa'/n).read_bytes()) for n in sorted(CONFIG_FILES)}))
    require(timestamp(evidence['after_receipt']['completed_at']) <= timestamp(report['plan_created_at']))
    principal,client=report['release_principal_id'],report['oidc_client_id']
    require((principal is None)==(client is None))
    if principal is not None:
        for value in (principal,client): match(UUID,value)
        require(len({principal,client,before['owner_object_id'],*principals.values()})==5)
    new=additions(after,principal)
    changed=before['release_sha']!=after['release_sha']
    resources={**expected(after,principals),**grants(after,principals),**new}
    require(report['resource_count']==24 and report['actions']=={'create':7,'update':int(changed),'no-op':17-int(changed)}
        and report['additions']==new and report['computed_references_require_post_apply_readback'] is True
        and report['source_tag_change']==({'before':before['release_sha'],'after':after['release_sha']} if changed else None))
    require(report['resources']==[{'address':k,'id':resource_id(v),'actions':
        ['create'] if k in new else ['update'] if k=='azapi_resource.group' and changed else ['no-op']}
        for k,v in sorted(resources.items())])
    return report


def correlate_identity(report, snapshot, *, after):
    ids={v[key] for v in snapshot['identities'].values() for key in ('principal_id','client_id')
         if v['principal_id']!=snapshot['release_principal_id']}
    for key in ('release_principal_id','oidc_client_id'):
        value=report[key]
        if value is not None:
            require(value not in ids)
            if after: require(snapshot[key]==value)

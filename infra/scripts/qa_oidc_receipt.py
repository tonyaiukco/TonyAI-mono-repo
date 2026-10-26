"""Full public Unit 5 snapshots. Local consistency never proves effective access."""
from datetime import datetime, timezone
import re
from qa_contract import ROOT, SUBSCRIPTION, GROUP, fields, require, match
from qa_discovery import digest, timestamp, verify_record
from qa_foundation_inputs import UUID
from qa_foundation_expected import expected
from qa_foundation_readback import manifest as initial_manifest, canonical
from qa_foundation_plan import compare
from qa_runtime_contract import grants
from qa_oidc_contract import predecessor
from qa_oidc_expected import additions, resource_id, role_rows, DEPLOYER, FEDERATION


def normalized(value):
    if isinstance(value, dict): return {k:normalized(v) for k,v in value.items()}
    if isinstance(value, list): return [normalized(v) for v in value]
    if isinstance(value,str) and (re.fullmatch(UUID,value.lower()) or value.lower().startswith('/subscriptions/')):
        return value.lower()
    return value


def get(path, version, query, paginated=False):
    return dict(argv=['az','rest','--method','GET','--url','https://management.azure.com'+path+'?api-version='+version,
        '--query',query,'--subscription',SUBSCRIPTION,'--only-show-errors','--output','json'],pagination='arm' if paginated else 'single')


def manifest(request, evidence, plan_hash, phase):
    before, after, _, _ = predecessor(request,evidence)
    require(phase in ('before','after')); match(r'[a-f0-9]{64}',plan_hash)
    config = before if phase=='before' else after
    initial = {'config':{**config,'oidc_enabled':False,'runtime_secrets_ready':False}}
    commands = initial_manifest(initial)['commands']
    commands['account'] = dict(argv=['az','account','show','--subscription',SUBSCRIPTION,'--query',
        '{subscription_id:id,tenant_id:tenantId}','--only-show-errors','--output','json'],pagination='single')
    commands['resources'] = get('/subscriptions/'+SUBSCRIPTION+'/resources','2021-04-01',
        '{items:value[].{id:id,type:type,location:location,tags:tags},next_link:nextLink}',True)
    commands['identities'] = get(GROUP+'/providers/Microsoft.ManagedIdentity/userAssignedIdentities','2023-01-31',
        '{items:value[].{id:id,location:location,tags:tags,principal_id:properties.principalId,client_id:properties.clientId,tenant_id:properties.tenantId},next_link:nextLink}',True)
    old = expected(config)
    parents = {kind: resource_id(old[f'azapi_resource.identity["{kind}"]']) for kind in ('api','web')}
    if phase == 'after': parents['release'] = resource_id(additions(config)[DEPLOYER])
    for kind,parent in parents.items():
        commands['federation-'+kind] = get(parent+'/federatedIdentityCredentials','2023-01-31',
            '{items:value[].{id:id,name:name,issuer:properties.issuer,subject:properties.subject,audiences:properties.audiences},next_link:nextLink}',True)
    return dict(schema=1,source_sha=after['release_sha'],request_sha256=digest(request),predecessor_sha256=digest(evidence),
                plan_sha256=plan_hash,phase=phase,commands=commands)


def indexed(rows, keys):
    require(isinstance(rows,list))
    for row in rows: fields(row,keys)
    result = {r['id'].lower():normalized(r) for r in rows}
    require(len(result)==len(rows))
    return result


def check_roles(rows, resources, protected):
    result = indexed(rows,'id scope principalId principalType roleDefinitionId condition conditionVersion delegated')
    for row in result.values():
        match(UUID,row['principalId'])
        match(r'/subscriptions/'+SUBSCRIPTION+r'(?:/[^\s]+)?',row['scope'])
        prefix = row['scope']+'/providers/microsoft.authorization/roleassignments/'
        require(row['id'].startswith(prefix)); match(UUID,row['id'][len(prefix):])
        require(isinstance(row['roleDefinitionId'],str))
    wanted = {k.lower():normalized(v) for k,v in role_rows(resources).items()}
    require(all(result.get(k)==v for k,v in wanted.items()))
    require(all(r['principalId'] not in protected or k in wanted for k,r in result.items()))
    return result


def verify(request, evidence, plan_hash, receipt, phase, *, not_before, now=None):
    before, after, historical, principals = predecessor(request,evidence,now=now)
    spec = manifest(request,evidence,plan_hash,phase)
    fields(receipt,'source_sha request_sha256 predecessor_sha256 plan_sha256 phase manifest_sha256 started_at completed_at records')
    require(all(receipt[k]==spec[k] for k in ('source_sha','request_sha256','predecessor_sha256','plan_sha256','phase'))
            and receipt['manifest_sha256']==digest(spec))
    start,end=timestamp(receipt['started_at']),timestamp(receipt['completed_at']);now=now or datetime.now(timezone.utc)
    require(timestamp(evidence['after_receipt']['completed_at']) <= timestamp(not_before) <= start <= end <= now
            and (now-start).total_seconds()<=3600 and (end-start).total_seconds()<=1800)
    records={r['key']:r for r in receipt['records']}
    require(len(records)==len(receipt['records']) and set(records)==set(spec['commands']))
    data={k:verify_record(records[k],v,start,end) for k,v in spec['commands'].items()}
    snapshot = check_snapshot(before if phase=='before' else after, historical, principals, data, phase)
    return dict(receipt_sha256=digest(receipt),manifest_sha256=digest(spec),started_at=receipt['started_at'],
                completed_at=receipt['completed_at'], **snapshot)


def check_snapshot(config, historical, principals, data, phase):
    """Pure Unit 5 public snapshot oracle, shared without changing its policy."""
    require(normalized(data['account'])=={'subscription_id':SUBSCRIPTION,'tenant_id':config['tenant_id']})
    resources={**expected(config,principals),**grants(config,principals)}
    for address,wanted in expected(config,principals).items():
        if address.startswith('azapi_resource.grant['): continue
        row=data[address]
        extra='principal_id' if address.startswith('azapi_resource.identity[') else 'default_domain' if address=='azapi_resource.environment' else ''
        fields(row,'id location tags body provisioning_state '+extra)
        require(row['id'].lower()==resource_id(wanted).lower())
        require(row['location']==wanted['location'] if wanted['location'] else row['location'] in (None,''))
        require(row['tags']==wanted['tags'] if wanted['tags'] else row['tags'] in (None,{}))
        compare(canonical(normalized(wanted['body'])),canonical(normalized(row['body'])),False)
        require(row['provisioning_state']=='Succeeded' if address in ('azapi_resource.group','azapi_resource.registry','azapi_resource.logs',
                'azapi_resource.environment','azapi_resource.vault','azapi_resource.dns','azapi_resource.dns_link') else row['provisioning_state'] in (None,'Succeeded'))
        if extra=='principal_id': require(row[extra].lower()==principals['api' if '"api"' in address else 'web'])
        if extra=='default_domain': require(row[extra]==historical[address][extra])
    identities=indexed(data['identities'],'id location tags principal_id client_id tenant_id')
    ids={kind:resource_id(resources[f'azapi_resource.identity["{kind}"]']).lower() for kind in ('api','web')}
    if phase=='after': ids['release']=resource_id(additions(config)[DEPLOYER]).lower()
    require(set(identities)==set(ids.values()))  # Before proves the release identity absent, not a 403/404.
    all_uuids=[config['owner_object_id']]
    for kind,identity_id in ids.items():
        row=identities[identity_id]
        for key in ('principal_id','client_id'): match(UUID,row[key]);all_uuids.append(row[key])
        require(row['tenant_id']==config['tenant_id'] and row['location']=='swedencentral')
        require(row['tags'] in (None,{}) if kind=='release' else row['tags']==resources[f'azapi_resource.identity["{kind}"]']['tags'])
        if kind!='release': require(row['principal_id']==principals[kind])
    require(len(set(all_uuids))==len(all_uuids))
    principal=identities[ids['release']]['principal_id'] if phase=='after' else None
    if phase=='after': resources.update(additions(config,principal))
    roles=check_roles(data['roles'],resources,{*principals.values(),*([principal] if principal else [])})
    require(data['federation-api']==[] and data['federation-web']==[])
    if phase=='after':
        fed=resources[FEDERATION]
        require(normalized(data['federation-release'])==[normalized(dict(id=resource_id(fed),name=fed['name'],**fed['body']['properties']))])
    inventory=indexed(data['resources'],'id type location tags')
    require(all(k.startswith('/subscriptions/'+SUBSCRIPTION+'/') for k in inventory))
    release_id=resource_id(additions(config)[DEPLOYER]).lower()
    require((release_id in inventory)==(phase=='after'))
    for address in ('registry','logs','environment','vault','identity["api"]','identity["web"]','dns'):
        wanted=resources['azapi_resource.'+address]; key=resource_id(wanted).lower()
        row=inventory[key]
        require(row['type'].lower()==wanted['type'].split('@')[0].lower() and row['location']==wanted['location']
                and (row['tags']==wanted['tags'] if wanted['tags'] else row['tags'] in (None,{})))
    for kind,identity_id in ids.items():
        row=inventory[identity_id]
        require(row['type'].lower()=='microsoft.managedidentity/userassignedidentities' and row['location']=='swedencentral'
                and (row['tags'] in (None,{}) if kind=='release' else row['tags']==identities[identity_id]['tags']))
    return dict(roles=roles,resources=inventory,identities=identities,release_principal_id=principal,
                oidc_client_id=identities[ids['release']]['client_id'] if phase=='after' else None)


def verify_after(request,evidence,report,before_receipt,after_receipt,*,plan_completed_at,apply_started_at,apply_completed_at,now=None,source_root=ROOT):
    from qa_oidc_report import validate, correlate_identity
    validate(request,evidence,report,now=now,source_root=source_root)
    plan_hash=report['plan_sha256']
    require(timestamp(report['plan_created_at']) <= timestamp(plan_completed_at))
    before=verify(request,evidence,plan_hash,before_receipt,'before',not_before=plan_completed_at,now=now)
    require(timestamp(before['completed_at']) <= timestamp(apply_started_at) <= timestamp(apply_completed_at))
    after=verify(request,evidence,plan_hash,after_receipt,'after',not_before=apply_completed_at,now=now)
    correlate_identity(report,before,after=False)
    correlate_identity(report,after,after=True)
    old,config,_,_=predecessor(request,evidence,now=now)
    added=additions(config,after['release_principal_id'])
    roles={k.lower():normalized(v) for k,v in role_rows(added).items()}
    require(not set(before['roles']) & set(roles) and after['roles']=={**before['roles'],**roles})
    require(all(after['identities'][k]==v for k,v in before['identities'].items()))
    inventory=dict(before['resources'])
    # The only permitted metadata delta is the explicitly requested releaseSha.
    if old['release_sha']!=config['release_sha'] and GROUP.lower() in inventory:
        inventory[GROUP.lower()]={**inventory[GROUP.lower()], 'tags':{**inventory[GROUP.lower()]['tags'],'releaseSha':config['release_sha']}}
    release=added[DEPLOYER];key=resource_id(release).lower()
    inventory[key]=dict(id=key,type=release['type'].split('@')[0],location=release['location'],tags=after['resources'][key]['tags'])
    require(after['resources']==inventory)
    return dict(status='OFFLINE_READBACK_CONSISTENCY_ONLY',authorization=False,authenticated_azure_provenance=False,
        effective_permissions_proven=False,before_receipt_sha256=before['receipt_sha256'],after_receipt_sha256=after['receipt_sha256'],
        release_principal_id=after['release_principal_id'],oidc_client_id=after['oidc_client_id'],added_assignment_ids=sorted(roles),
        federation_id=resource_id(added[FEDERATION]))


def main():
    import argparse
    import json
    from qa_contract import load
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=('manifest','verify'))
    for name in ('request','predecessor','plan-sha256'): parser.add_argument('--'+name,required=True)
    parser.add_argument('--packet',help='Unit 5 inspector packet; its binding is revalidated, never authorization')
    parser.add_argument('--phase',choices=('before','after'))
    for name in ('before','after','plan-created-at','plan-completed-at','apply-started-at','apply-completed-at'): parser.add_argument('--'+name)
    args=parser.parse_args()
    try:
        request,evidence=load(args.request),load(args.predecessor)
        if args.operation=='manifest': result=manifest(request,evidence,args.plan_sha256,args.phase)
        else:
            require(timestamp(evidence['after_receipt']['completed_at']) <= timestamp(args.plan_created_at) <= timestamp(args.plan_completed_at))
            report=load(args.packet)['binding']
            require(report['plan_sha256']==args.plan_sha256 and report['plan_created_at']==args.plan_created_at)
            result=verify_after(request,evidence,report,load(args.before),load(args.after),plan_completed_at=args.plan_completed_at,
                                apply_started_at=args.apply_started_at,apply_completed_at=args.apply_completed_at)
    except Exception:
        raise SystemExit('FAIL: QA Unit 5 public readback refused; details withheld.') from None
    print(json.dumps(result,indent=2,sort_keys=True))


if __name__=='__main__': main()

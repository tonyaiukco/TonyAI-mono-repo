"""Secret-free offline admin projection contract. Never calls GitHub or authorizes."""
from datetime import datetime, timezone
from urllib.parse import urlsplit, parse_qs
from qa_contract import fields, require, match
from qa_discovery import digest, timestamp
from qa_oidc_contract import transition
from github_environment import verify_environment_data

REPO = 'tonyaiukco/TonyAI-mono-repo'
BASE = 'repos/' + REPO
PROJECTIONS = {
    'environment': '{name,can_admins_bypass,deployment_branch_policy,protection_rules:[.protection_rules[]|select(.type=="required_reviewers")|{type,prevent_self_review,reviewers:[.reviewers[]|{type,reviewer:{id:.reviewer.id}}]}]}',
    'policies': '{total_count,branch_policies:[.branch_policies[]|{name,type}]}',
    'rulesets': '[.[]|{id,name}]',
    'ruleset': '{id,name,target,enforcement,bypass_actors,conditions,rules:[.rules[]|{type,parameters}]}',
    'mode': '{name,value}', 'approval': '{approval_policy}',
}


def manifest(request, plan_hash, ruleset_id, *, transition_validator=transition):
    _, config = transition_validator(request)
    match(r'[a-f0-9]{64}', plan_hash)
    require(type(ruleset_id) is int and ruleset_id > 0)
    paths = dict(environment=BASE+'/environments/staging', policies=BASE+'/environments/staging/deployment-branch-policies?per_page=100',
        rulesets=BASE+'/rulesets?per_page=100', ruleset=BASE+'/rulesets/'+str(ruleset_id),
        mode=BASE+'/actions/variables/STAGING_RUNNER_MODE', approval=BASE+'/actions/permissions/fork-pr-contributor-approval')
    return dict(schema=1, source_sha=config['release_sha'], request_sha256=digest(request), plan_sha256=plan_hash,
        ruleset_id=ruleset_id, commands={k: dict(argv=['gh','api','--hostname','github.com','-H',
        'X-GitHub-Api-Version: 2022-11-28','--include',path], projection=PROJECTIONS[k],
        pagination='github-link' if k in ('rulesets','policies') else 'single') for k,path in paths.items()})


def validate_projection(key, value):
    if key == 'environment':
        fields(value, 'name can_admins_bypass deployment_branch_policy protection_rules')
        for rule in value['protection_rules']:
            fields(rule, 'type prevent_self_review reviewers')
            for reviewer in rule['reviewers']:
                fields(reviewer, 'type reviewer'); fields(reviewer['reviewer'], 'id')
    elif key == 'rulesets':
        require(isinstance(value, list))
        for row in value:
            fields(row, 'id name'); require(type(row['id']) is int and row['id'] > 0)
    elif key == 'policies':
        fields(value, 'total_count branch_policies')
        for row in value['branch_policies']: fields(row, 'name type')
    elif key == 'ruleset':
        fields(value, 'id name target enforcement bypass_actors conditions rules')
        require(len({r['type'] for r in value['rules']}) == len(value['rules']))
        for row in value['rules']: fields(row, 'type parameters')
    else:
        fields(value, 'name value' if key == 'mode' else 'approval_policy')


def verify(request, plan_hash, receipt, *, not_before, now=None, transition_validator=transition):
    fields(receipt, 'source_sha request_sha256 plan_sha256 ruleset_id manifest_sha256 started_at completed_at records')
    spec = manifest(request, plan_hash, receipt['ruleset_id'], transition_validator=transition_validator)
    require(all(receipt[k] == spec[k] for k in ('source_sha','request_sha256','plan_sha256'))
            and receipt['manifest_sha256'] == digest(spec))
    start, end = timestamp(receipt['started_at']), timestamp(receipt['completed_at'])
    now = now or datetime.now(timezone.utc)
    require(timestamp(not_before) <= start <= end <= now and (now-start).total_seconds() <= 3600 and (end-start).total_seconds() <= 1800)
    records = {r['key']:r for r in receipt['records']}
    require(len(records) == len(receipt['records']) and set(records) == set(spec['commands']))
    data = {}
    for key, command in spec['commands'].items():
        row = records[key]; fields(row, 'key complete pages')
        require(row['complete'] is True and 1 <= len(row['pages']) <= 100)
        argv = command['argv']; values = []; seen = set()
        for index, page in enumerate(row['pages']):
            fields(page, 'argv_sha256 projection_sha256 exit_code http_status started_at completed_at result result_sha256 next_link')
            require(page['argv_sha256'] == digest(argv) and page['projection_sha256'] == digest(command['projection'])
                    and type(page['exit_code']) is int and page['exit_code'] == 0 and page['http_status'] == 200
                    and start <= timestamp(page['started_at']) <= timestamp(page['completed_at']) <= end
                    and page['result_sha256'] == digest(page['result']))
            validate_projection(key, page['result']); values.append(page['result'])
            link = page['next_link']
            if index == len(row['pages'])-1:
                require(link is None)
            else:
                require(command['pagination'] == 'github-link' and isinstance(link,str) and link not in seen)
                seen.add(link); url = urlsplit(link); base = urlsplit('https://api.github.com/'+command['argv'][-1])
                query = parse_qs(url.query,strict_parsing=True)
                require(url.scheme=='https' and url.netloc=='api.github.com' and url.path==base.path and not url.fragment
                        and query=={'per_page':['100'],'page':[str(index+2)]})
                argv = [*command['argv'][:-1],url.path.lstrip('/')+'?'+url.query]
        if key == 'rulesets':
            data[key] = [v for page in values for v in page]
            require(len({v['id'] for v in data[key]}) == len(data[key]))
        else:
            require(len(values)==1);data[key]=values[0]
    require(data['ruleset']['id']==receipt['ruleset_id'] and data['ruleset']['name']=='tonyai-main-release'
            and data['mode']['name']=='STAGING_RUNNER_MODE')
    by_path={v['argv'][-1]:data[k] for k,v in spec['commands'].items()}
    verify_environment_data(REPO, lambda path: by_path[path])
    return dict(status='OFFLINE_GITHUB_CONSISTENCY_ONLY', authorization=False, authenticated_github_provenance=False,
        independent_human_approver_proven=False, fresh_jit_host_proven=False, receipt_sha256=digest(receipt), manifest_sha256=digest(spec))


def main():
    import argparse
    import json
    from qa_contract import load
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=('manifest','verify'))
    for name in ('request','plan-sha256'): parser.add_argument('--'+name,required=True)
    parser.add_argument('--ruleset-id',type=int)
    parser.add_argument('--receipt');parser.add_argument('--not-before')
    args=parser.parse_args()
    try:
        req=load(args.request)
        result=manifest(req,args.plan_sha256,args.ruleset_id) if args.operation=='manifest' else verify(req,args.plan_sha256,load(args.receipt),not_before=args.not_before)
    except Exception:
        raise SystemExit('FAIL: QA Unit 5 GitHub prerequisites refused; details withheld.') from None
    print(json.dumps(result,indent=2,sort_keys=True))


if __name__=='__main__': main()

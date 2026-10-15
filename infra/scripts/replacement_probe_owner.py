#!/usr/bin/env python3
"""Run approved credential probes via exact old escrow and strict new-host SSH; no secret output."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import Request, build_opener, ProxyHandler
from selfhost_escrow import validate_contract as legacy_contract, NoRedirect
from replacement_host import validate_contract
from replacement_bundle import private_read, write_new, encoded, digest
from replacement_probe import HTTP_CASES, DB_ROLES


def capture(command, data=None):
    result=subprocess.run(command,input=data,capture_output=True,timeout=600)
    if result.returncode:
        raise ValueError('Private probe command failed; output withheld.')
    return result.stdout


def save_probe_report(result, destination, contract, old_version):
    # Exit 1 is the reviewed probe's partial/failure report, not an SSH success.
    # Transport failures (including 255) and arbitrary remote output are refused.
    if result.returncode not in (0, 1) or len(result.stdout) > 12000:
        raise ValueError('Probe transport failed; diagnostics withheld.')
    report=json.loads(result.stdout)
    allowed=set(HTTP_CASES)|{'db-'+role for role in DB_ROLES}|{'storage-s3'}|{
        consumer+'-'+algorithm+'-'+role for consumer in ('rest-service','storage-service','realtime-admin')
        for algorithm in ('HS256','ES256') for role in ('anon','service_role')}
    expected_binding={key:contract[key] for key in ('vm_id','vm_uuid','source_sha256')}
    if (set(report)!={'format','generation','pd3','results','remaining','binding'} or report['format']!=1
            or report['generation']!='r02' or report['pd3']!='OPEN' or set(report['results'])!=allowed
            or report['binding']!=expected_binding or not re.fullmatch('[a-f0-9]{32}',old_version)
            or any(v not in ('PASS','FAIL_OLD_ACCEPTED','INCONCLUSIVE') for v in report['results'].values())):
        raise ValueError('Unreviewed probe report; output withheld.')
    incomplete=any(value!='PASS' for value in report['results'].values())
    if result.returncode != int(incomplete):
        raise ValueError('Probe status disagrees with its report.')
    # Never copy remote free text or stderr into the saved report.
    safe={key:report[key] for key in ('format','generation','pd3','results','binding')}
    safe.update(old_version=old_version,new_contract_sha256=digest(encoded(contract)))
    write_new(destination,encoded(safe))
    return incomplete


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for key in ('old-contract','old-version','new-contract','key','known-hosts','report'):
        parser.add_argument('--'+key,required=True)
    args=parser.parse_args()
    old=json.loads(private_read(args.old_contract));old_origin=legacy_contract(old)
    new=validate_contract(json.loads(private_read(args.new_contract)))
    if any(old[key]!=new[key] for key in ('subscription_id','tenant_id')) or not re.fullmatch('[a-f0-9]{32}',args.old_version):
        raise ValueError('Exact old/new account and immutable old version required.')
    account=json.loads(capture(['az','account','show','-o','json']))
    if account['id']!=new['subscription_id'] or account['tenantId']!=new['tenant_id']:
        raise ValueError('Wrong CLI account.')
    token=json.loads(capture(['az','account','get-access-token','--resource','https://vault.azure.net','-o','json']))['accessToken']
    url=old_origin+'/secrets/supabase-runtime-env/'+args.old_version
    request=Request(url+'?api-version=7.4',headers={'Authorization':'Bearer '+token})
    with build_opener(ProxyHandler({}),NoRedirect()).open(request,timeout=30) as response:
        record=json.load(response)
    if record.get('id')!=url or record.get('attributes',{}).get('enabled') is not True:
        raise ValueError('Old forensic escrow version unavailable; never fall back to latest.')
    payload=record['value'].encode()
    if not payload or len(payload)>25000:
        raise ValueError('Unexpected old escrow payload.')
    command=['ssh','-F','/dev/null','-i',args.key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes',
        '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(Path(args.known_hosts).resolve()),
        'tonyaiops@'+new['public_hostname'],
        'sudo /usr/bin/python3 -I -B /usr/local/lib/tonyai/replacement_probe.py --old-runtime-stdin']
    result=subprocess.run(command,input=payload,capture_output=True,timeout=600)
    if save_probe_report(result,args.report,new,args.old_version):
        print('INCOMPLETE: bounded private probe report saved; PD-3 remains OPEN.')
        return 1
    print('PASS: bounded probe subset saved; complete coverage and PD-3 remain open.')
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except Exception:sys.exit('FAIL: acceptance refused or incomplete; no credentials or remote diagnostics returned.')

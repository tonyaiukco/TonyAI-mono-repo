#!/usr/bin/env python3
"""Check exact create policy against the backendless Terraform mock's real plan shape."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from replacement_plan import CREATE, validate_create

events=[json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
summary=[event['test_summary'] for event in events if event.get('type')=='test_summary']
if len(summary)!=1 or summary[0]['status']!='pass':
    raise ValueError('Successful backendless test evidence required.')
plans=[event['test_plan'] for event in events if event.get('type')=='test_plan' and event.get('@testrun')=='isolated_additive_r02']
if len(plans)!=1:
    raise ValueError('Exact r02 mock scenario required.')
# These are deliberately synthetic inputs from security.tftest.hcl, never live inputs.
inputs={'config':dict(subscription_id='00000000-0000-0000-0000-000000000001',tenant_id='00000000-0000-0000-0000-000000000002',
    environment='staging',operator_ipv4='8.8.8.8/32',ssh_public_key='ssh-rsa c3ludGhldGlj',image_version='24.04.202601010',
    vm_size='Standard_D2as_v7',recovery_owner_object_id='00000000-0000-0000-0000-000000000003',https_enabled=False),
    'containment':True,'replacement':dict(generation='r02',recovery_vault_name='tonyai-qa-r02-12345678',ssh_public_key='ssh-rsa cmVwbGFjZW1lbnQ=')}
changes={item['address']:item['change'] for item in plans[0]['resource_changes'] if item['address'] in CREATE}
if set(changes)!=CREATE:
    raise ValueError('Missing replacement create request.')
for address,change in changes.items():
    if change['actions']!=['create']:
        raise ValueError('Unexpected action in fresh mock.')
    validate_create(address,change,inputs)
print('PASS: all 10 Terraform replacement create requests match the reviewed exact policy.')

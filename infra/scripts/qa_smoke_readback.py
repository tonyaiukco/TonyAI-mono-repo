"""Collect only Unit 7 public ARM projections; no deployment or discovery writer."""
from datetime import datetime, timezone
import json
import subprocess
from qa_application_receipt import manifest, verify_receipt
from qa_contract import require
from qa_discovery import digest
from qa_deployment_history import app_identities
from qa_expected import canonical


def stamp():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def command(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60, check=False)
    require(result.returncode == 0)
    return json.loads(result.stdout)


def stable(context, data):
    # Starting the browser can wake the accepted web revision (minReplicas=0).
    # Membership of its replicas is not a release/configuration change. The
    # receipt oracle still requires every outgoing revision inactive and empty.
    current = {'replicas:tonyai-staging-' + kind + '--' + context['inputs']['release']['release_id']
               for kind in ('api', 'web')}
    return canonical({k: v for k, v in data.items() if k not in current})


def collect(evidence, context):
    unit = evidence['unit7']
    inputs, names = context['inputs'], context['revision_names']
    spec = manifest(inputs, unit['saved_plan']['plan_sha256'], names, 'after')
    start = stamp()
    records, data = [], {}
    for key, request in spec['commands'].items():
        begin = stamp()
        value = command(request['argv'])
        data[key] = value
        records.append(dict(key=key, complete=True, pages=[dict(argv_sha256=digest(request['argv']),
            exit_code=0, started_at=begin, completed_at=stamp(), result=value, result_sha256=digest(value))]))
    receipt = {k: spec[k] for k in ('source_sha', 'release_id', 'inputs_sha256', 'plan_sha256', 'phase', 'revision_names')}
    receipt.update(manifest_sha256=digest(spec), started_at=start, completed_at=stamp(), records=records)
    verify_receipt(inputs, spec['plan_sha256'], receipt, names, 'after', not_before=start,
                   outgoing=unit['outgoing_revisions'])
    app_identities({k: data[k + '_app'] for k in ('api', 'web')}, context['snapshot'])
    return data

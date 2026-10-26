"""Owner-review preparation only, never an executable approval or live executor."""
import shlex
from pathlib import Path
from qa_contract import fields, require
from qa_discovery import digest, timestamp
from qa_runtime_contract import predecessor
from qa_runtime_receipt import manifest, verify


def prepare(request, evidence, report, args, observations=None, *, now=None):
    before, after, _, _ = predecessor(request, evidence, now=now)
    require(report['request_sha256'] == digest(request) and report['predecessor_sha256'] == digest(evidence)
            and report['source_sha'] == after['release_sha'] and report['before_inputs_sha256'] == digest(before)
            and report['after_inputs_sha256'] == digest(after))
    require(str(Path(args.saved_plan).resolve()) == report['saved_plan_path']
            and str(Path(args.terraform).resolve()) == report['terraform_path'])
    observed = None
    if observations is not None:
        fields(observations, 'plan_completed_at receipt')
        require(timestamp(report['plan_created_at']) <= timestamp(observations['plan_completed_at']))
        checked = verify(request, evidence, report['plan_sha256'], observations['receipt'], 'before',
                         not_before=observations['plan_completed_at'], now=now)
        observed = {k: checked[k] for k in ('receipt_sha256', 'manifest_sha256', 'started_at', 'completed_at', 'secret_metadata')}
    q = lambda p: shlex.quote(str(Path(p).resolve()))
    manifests = {phase: manifest(request, evidence, report['plan_sha256'], phase) for phase in ('before', 'after')}
    recheck = list(dict.fromkeys([args.request, args.predecessor, *report.get('file_sha256', {}),
                                 report['saved_plan_path'], report['terraform_path']]))
    return {
        'schema': 1, 'unit': 4, 'status': 'BLOCKED_DRAFT', 'authorization': False, 'live_acceptance': False,
        'authenticated_azure_provenance': False, 'effective_permissions_proven': False,
        'binding': report, 'before_observation': observed, 'secret_versions': request['secret_versions'],
        'readback_manifest_sha256': {phase: digest(spec) for phase, spec in manifests.items()},
        'scope_semantics': 'RBAC scopes are secret names, not versions. Version IDs bind release metadata only.',
        'command_templates': {
            'hash_recheck': 'shasum -a 256 ' + ' '.join(q(p) for p in recheck),
            'saved_plan_apply': f'{shlex.quote(report["terraform_path"])} -chdir=infra/terraform/foundation/qa apply -input=false -lock-timeout=60s {shlex.quote(report["saved_plan_path"])}',
            'verify_readback': 'python3 infra/scripts/qa_runtime_receipt.py verify '
                f'--request {q(args.request)} --predecessor {q(args.predecessor)} --plan-sha256 {report["plan_sha256"]} '
                f'--plan-created-at {shlex.quote(report["plan_created_at"])} '
                '--plan-completed-at "$QA_PLAN_COMPLETED_AT" --apply-started-at "$QA_APPLY_STARTED_AT" '
                '--apply-completed-at "$QA_APPLY_COMPLETED_AT" --before "$QA_DIR/runtime-before.json" --after "$QA_DIR/runtime-after.json"',
            'readback_manifests': manifests,
        },
        'blocking_requirements': [
            'Authenticate and accept the exact historical initial plan/input/readback and owner decision; local hashes do not authenticate Azure provenance.',
            'Owner acceptance of R3, full R4/PD-3 and Units 0-3 remains external. No foundation apply, image build or deployment is implied.',
            'Collect fresh complete before metadata after this plan; prove both exact secret versions exist, are enabled and valid without reading values.',
            'Authenticate the backend/state lineage, default workspace, account tenant/subscription, installed tool/provider and absence of competing writers.',
            'Bind private paths, all file/tool/config/lock/plan/receipt/manifest hashes and UTC operation boundaries in a separate exact owner approval.',
            'Review inherited/effective permissions separately. A subscription assignment snapshot is not proof of all effective access.',
            'This package remains BLOCKED_DRAFT even with complete offline receipts; fixtures or caller JSON can never authorize execution.'
        ],
        'execution_conditions': [
            'Recheck source, input, predecessor, tool, lock, configuration and binary hashes immediately before use; apply only this saved binary.',
            'Only the two named API Secrets User grants may be created; only the exact source tag may update. Preserve all existing assignments.',
            'Record apply start/completion boundaries; collect the after manifest and verify_after with both receipts and this plan hash.',
            'A refused, failed, partial or interrupted live attempt consumes approval. Stop; no automatic retry, re-plan or continuation.'
        ],
        'failure_and_recovery': [
            'Preserve private evidence and state; partial creation is not success and does not authorize the second grant.',
            'New read approval is required to inspect an uncertain attempt. Recovery needs a fresh exact plan and separate owner approval.',
            'Do not automatically revoke grants, transfer/rotate secrets, alter state, destroy resources, enable OIDC/SMTP/apps or deploy.'
        ],
    }

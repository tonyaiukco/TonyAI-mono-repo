"""Owner-review preparation only, never an executable approval or live executor."""
import shlex
from pathlib import Path
from qa_contract import fields, require
from qa_discovery import digest, timestamp
from qa_oidc_contract import predecessor
from qa_oidc_receipt import manifest, verify


def prepare(request, evidence, report, args, observations=None, *, now=None):
    from qa_oidc_report import validate, correlate_identity
    validate(request,evidence,report,now=now)
    before, after, _, _ = predecessor(request, evidence, now=now)
    require(report['request_sha256'] == digest(request) and report['predecessor_sha256'] == digest(evidence)
            and report['source_sha'] == after['release_sha'] and report['before_inputs_sha256'] == digest(before)
            and report['after_inputs_sha256'] == digest(after))
    require(str(Path(args.saved_plan).resolve()) == report['saved_plan_path']
            and str(Path(args.terraform).resolve()) == report['terraform_path'])
    from qa_oidc_github import manifest as github_manifest, verify as github_verify
    github_spec = github_manifest(request, report['plan_sha256'], args.ruleset_id)
    github_checked = None
    observed = None
    if observations is not None:
        fields(observations, 'plan_completed_at receipt github_receipt')
        require(observations['github_receipt']['ruleset_id'] == args.ruleset_id)
        github_checked = github_verify(request, report['plan_sha256'], observations['github_receipt'],
            not_before=observations['plan_completed_at'], now=now)
        require(timestamp(report['plan_created_at']) <= timestamp(observations['plan_completed_at']))
        checked = verify(request, evidence, report['plan_sha256'], observations['receipt'], 'before',
                         not_before=observations['plan_completed_at'], now=now)
        correlate_identity(report,checked,after=False)
        observed = {k: checked[k] for k in ('receipt_sha256', 'manifest_sha256', 'started_at', 'completed_at', 'release_principal_id', 'oidc_client_id')}
    q = lambda p: shlex.quote(str(Path(p).resolve()))
    manifests = {phase: manifest(request, evidence, report['plan_sha256'], phase) for phase in ('before', 'after')}
    recheck = list(dict.fromkeys([args.request, args.predecessor, *report.get('file_sha256', {}),
                                 report['saved_plan_path'], report['terraform_path']]))
    return {
        'schema': 1, 'unit': 5, 'status': 'BLOCKED_DRAFT', 'authorization': False, 'live_acceptance': False,
        'authenticated_azure_provenance': False, 'effective_permissions_proven': False,
        'binding': report, 'before_observation': observed, 'github_prerequisite': github_checked,
        'readback_manifest_sha256': {phase: digest(spec) for phase, spec in manifests.items()},
        'authenticated_github_provenance': False,
        'github_manifest': github_spec, 'github_manifest_sha256': digest(github_spec),
        'scope_semantics': 'Five deployment grants only; no vault, secret, application or general deployment permission.',
        'command_templates': {
            'hash_recheck': 'shasum -a 256 ' + ' '.join(q(p) for p in recheck),
            'saved_plan_apply': f'{shlex.quote(report["terraform_path"])} -chdir=infra/terraform/foundation/qa apply -input=false -lock-timeout=60s {shlex.quote(report["saved_plan_path"])}',
            'verify_readback': 'python3 infra/scripts/qa_oidc_receipt.py verify '
                f'--request {q(args.request)} --predecessor {q(args.predecessor)} --plan-sha256 {report["plan_sha256"]} '
                f'--plan-created-at {shlex.quote(report["plan_created_at"])} '
                '--packet "$QA_DIR/oidc-owner-draft.json" '
                '--plan-completed-at "$QA_PLAN_COMPLETED_AT" --apply-started-at "$QA_APPLY_STARTED_AT" '
                '--apply-completed-at "$QA_APPLY_COMPLETED_AT" --before "$QA_DIR/oidc-before.json" --after "$QA_DIR/oidc-after.json"',
            'readback_manifests': manifests,
        },
        'blocking_requirements': [
            'Authenticate and accept the exact historical Unit 4 request, initial predecessor, saved plan, both readbacks, times and separate owner decision; local hashes do not authenticate Azure provenance.',
            'Owner acceptance of R3, full R4/PD-3 and Units 0-3 remains external. No foundation apply, image build or deployment is implied.',
            'Collect fresh complete before metadata after this plan; prove the complete resource/assignment inventory and release identity absence without reading secrets.',
            'The environment OIDC subject does not restrict main. Authenticate fresh GitHub admin projections; workflow GITHUB_TOKEN is not admin preflight.',
            'Arrange an independent human reviewer and separately prove fresh JIT host provisioning and destruction. Agent reviews, labels, mode variables and REST are insufficient.',
            'Authenticate the backend/state lineage, default workspace, account tenant/subscription, installed tool/provider and absence of competing writers.',
            'Bind private paths, all file/tool/config/lock/plan/receipt/manifest hashes and UTC operation boundaries in a separate exact owner approval.',
            'Review inherited/effective permissions separately. A subscription assignment snapshot is not proof of all effective access.',
            'This package remains BLOCKED_DRAFT even with complete offline receipts; fixtures or caller JSON can never authorize execution.'
        ],
        'execution_conditions': [
            'Recheck source, input, predecessor, tool, lock, configuration and binary hashes immediately before use; apply only this saved binary.',
            'Only the release identity, exact staging federation and five enumerated narrow grants may be created; only the exact releaseSha tag may update. Preserve all 17 existing resources and every assignment.',
            'Record apply start/completion boundaries; collect the after manifest and verify_after with both receipts and this plan hash.',
            'A refused, failed, partial or interrupted live attempt consumes approval. Stop; no automatic retry, re-plan or continuation.'
        ],
        'failure_and_recovery': [
            'Preserve private evidence and state; partial identity/federation/grant creation is not success and does not authorize continuation.',
            'New read approval is required to inspect an uncertain attempt. Recovery needs a fresh exact plan and separate owner approval.',
            'Do not automatically delete federation, revoke grants, transfer/rotate secrets, alter state, destroy resources, enable SMTP/apps or deploy.'
        ],
    }

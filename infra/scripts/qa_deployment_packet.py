"""Unit 8 owner draft; no input can turn this module into an executor or approval."""
from pathlib import Path
import shlex
from qa_contract import fields, require
from qa_discovery import digest
from qa_deployment_contract import transition
from qa_deployment_report import validate
from qa_deployment_receipt import manifests, verify
from qa_oidc_github import manifest as github_manifest, verify as github_verify


def prepare(request, evidence, report, args, observations=None, *, now=None):
    context = validate(request, evidence, report, now=now)
    require(str(Path(args.saved_plan).resolve()) == report['saved_plan_path']
            and str(Path(args.terraform).resolve()) == report['terraform_path'])
    specs = manifests(request, evidence, report, now=now)
    github = github_manifest(request, report['plan_sha256'], args.ruleset_id, transition_validator=transition)
    checked, github_checked = None, None
    if observations is not None:
        fields(observations, 'plan_completed_at receipt github_receipt')
        require(observations['github_receipt']['ruleset_id'] == args.ruleset_id)
        github_checked = github_verify(request, report['plan_sha256'], observations['github_receipt'],
            not_before=observations['plan_completed_at'], now=now, transition_validator=transition)
        result = verify(request, evidence, report, observations['receipt'], 'before',
                        not_before=observations['plan_completed_at'], now=now)
        checked = {k: result[k] for k in ('receipt_sha256', 'manifest_sha256', 'started_at', 'completed_at')}
    q = lambda p: shlex.quote(str(Path(p).resolve()))
    paths = list(dict.fromkeys([args.request, args.predecessor, *report.get('file_sha256', {}),
                               report['saved_plan_path'], report['terraform_path']]))
    if getattr(args, 'observations', None): paths.append(args.observations)
    return dict(schema=1, unit=8, status='BLOCKED_DRAFT', authorization=False, live_acceptance=False,
        authenticated_azure_provenance=False, authenticated_github_provenance=False, effective_permissions_proven=False,
        binding=report, before_observation=checked, github_prerequisite=github_checked,
        github_manifest=github, github_manifest_sha256=digest(github),
        readback_manifest_sha256={k: digest(v) for k, v in specs.items()},
        application_ownership=dict(root='infra/terraform/application/qa', inputs_sha256=digest(context['inputs']),
            source_sha=context['inputs']['release']['source_sha'], release_id=context['inputs']['release']['release_id'],
            owner_acceptance_reference=evidence['unit7']['owner_acceptance'],
            revision_names=context['revision_names'],
            image_digests={k: context['inputs']['release'][k+'_digest'] for k in ('api', 'web')}),
        scope_semantics='Container Apps Contributor can change API code and thereby indirectly access runtime secrets. '
            'No direct vault grant does not mean no secret access. Exactly two existing app scopes only.',
        command_templates=dict(
            hash_recheck='shasum -a 256 ' + ' '.join(q(p) for p in paths),
            saved_plan_apply=f'{shlex.quote(report["terraform_path"])} -chdir=infra/terraform/foundation/qa apply -input=false -lock-timeout=60s {shlex.quote(report["saved_plan_path"])}',
            readback_manifests=specs,
            verify_readback='python3 infra/scripts/qa_deployment_receipt.py verify '
                f'--request {q(args.request)} --predecessor {q(args.predecessor)} '
                '--packet "$QA_DIR/deployment-owner-draft.json" --before "$QA_DIR/deployment-before.json" '
                '--after "$QA_DIR/deployment-after.json" --plan-completed-at "$QA_PLAN_COMPLETED_AT" '
                '--apply-started-at "$QA_APPLY_STARTED_AT" --apply-completed-at "$QA_APPLY_COMPLETED_AT"'),
        blocking_requirements=[
            'Authenticate separate Unit 5 and Unit 7 owner acceptances and all historical source/input/config/lock/candidate/report/receipt bindings. A caller acceptance hash is not authenticated provenance.',
            'Authenticate fresh complete Azure and GitHub admin receipts; 403/404, caller JSON and workflow GITHUB_TOKEN cannot establish prerequisites.',
            'Arrange an independent human reviewer and prove fresh JIT host provisioning/destruction externally. Agent reviews, labels, mode variables and REST snapshots are insufficient.',
            'R3, full R4/PD-3, startup/login/TLS/tenant isolation and effective/inherited permission acceptance remain external. Unit 7 readback alone proves none of them.',
            'Verify backend/state lineage, default workspace, trusted installed tools/providers and absence of competing writers; bind all file/manifest hashes and operation times in a separate owner approval.',
            'BLOCKED_DRAFT remains permanent even with complete synthetic evidence. This package enables no automatic deployment workflow or executor.'],
        execution_conditions=[
            'Recheck canonical binary/tool paths and every bound hash immediately before the separately approved attempt. Apply only this saved binary; no re-plan.',
            'Preserve all 24 foundation resources, application_contract and oidc_client_id; create only the two enumerated assignments. Only the explicit RG tags.releaseSha change is permitted.',
            'Both apps must remain successful with identical public body, image, revision, traffic and replica/drain observations across the attempt.',
            'A refused, failed, partial or interrupted live attempt consumes approval. Stop immediately; no automatic retry, re-plan, grant revoke or recovery.'],
        failure_and_recovery=[
            'Preserve private evidence and state. Partial grants are not acceptance and do not authorize deployment or continuation.',
            'Inspect uncertain state only under a new read approval. Obtain a separate exact recovery approval; never automatically revoke grants, destroy resources or alter remote state.',
            'No runtime-secret transfer, federation, SMTP, image build/push, deployment, migration or production readiness is implied.'])

"""Secret-free owner review draft. This module cannot grant execution authority."""
import shlex
from pathlib import Path
from qa_contract import fields, match, release, require
from qa_discovery import digest, timestamp
from qa_application_receipt import verify_receipt
from runtime_limits import validate_limits


def rollback_evidence(inputs, evidence, mode):
    if evidence is None:
        return {'status': 'NO_PREDECESSOR' if mode == 'first_deployment' else 'BLOCKED_MISSING_PREDECESSOR',
                'target': None}
    require(mode == 'existing_revision_update')
    fields(evidence, 'inputs candidate accepted_readback_sha256 compatibility_review_sha256')
    prior = release(evidence['inputs'], evidence['candidate'])
    require(prior['foundation'] == inputs['foundation'] and prior['release']['release_id'] != inputs['release']['release_id'])
    for key in ('accepted_readback_sha256', 'compatibility_review_sha256'):
        match(r'[a-f0-9]{64}', evidence[key])
    # release() requires the exact current migration fingerprint. It deliberately
    # refuses a changed chain; equal hashes still do not establish live compatibility.
    return {'status': 'BLOCKED_OWNER_AUTHENTICATION_AND_COMPATIBILITY_REVIEW',
            'source_sha': prior['release']['source_sha'], 'candidate_sha256': digest(evidence['candidate']),
            'inputs_sha256': digest(prior), 'accepted_readback_sha256': evidence['accepted_readback_sha256'],
            'compatibility_review_sha256': evidence['compatibility_review_sha256'],
            'target': 'Proposed predecessor only; verify in its own clean source checkout and use a fresh release_id.'}


def commands(inputs, report, args, names):
    # These are review strings, never executed here. Shell-quote all external paths.
    q = lambda path: shlex.quote(str(Path(path).resolve()))
    input_path, candidate_path, binary = q(args.inputs), q(args.candidate), q(args.saved_plan)
    grace = validate_limits(inputs['release']['runtime_limits'])['SHUTDOWN_GRACE_MS']
    drain_code = ('import sys; from qa_contract import load; from drain_api import drain; '
                  "v=load(sys.argv[1]); drain(v['foundation'], v['release']['release_id'], "
                  f'attempts={(grace + 31999) // 2000}, expected_revision_names={names["api"]!r})')
    root = str(Path(__file__).resolve().parents[2])
    prefix = f'cd {shlex.quote(root)} && '
    outgoing_path = q(Path(args.inputs).resolve().parent / 'approved-outgoing-revisions.json')
    def receipt_command(phase, boundary):
        return (prefix + f'python3 infra/scripts/qa_application_receipt.py verify --inputs {input_path} --candidate {candidate_path} '
                f'--plan-sha256 {report["plan_sha256"]} --phase {phase} '
                f'--revision-names {outgoing_path} --revision-names-sha256 {digest(names)} '
                f'--receipt "$QA_DIR/application-{phase}.json" --not-before "${boundary}"')
    return {
        'hash_recheck': prefix + f'shasum -a 256 {input_path} {candidate_path} {binary} {q(args.terraform)}',
        'drain': prefix + 'PYTHONPATH=infra/scripts python3 -c ' + shlex.quote(drain_code) + ' ' + input_path,
        'saved_plan_apply': prefix + f'{q(args.terraform)} -chdir=infra/terraform/application/qa apply -input=false -lock-timeout=60s {binary}',
        'drained_receipt': receipt_command('drained', 'QA_PLAN_COMPLETED_AT'),
        'readback': receipt_command('after', 'QA_APPLY_COMPLETED_AT'),
    }


def prepare(inputs, report, provenance, args, observations=None, predecessor=None):
    require(report['source_sha'] == inputs['release']['source_sha'] and report['release_id'] == inputs['release']['release_id']
            and report['normalized_inputs_sha256'] == digest(inputs))
    names, mode, observed = {'api': [], 'web': []}, 'UNRESOLVED', None
    if observations is not None:
        fields(observations, 'plan_completed_at revision_names receipt')
        require(timestamp(report['plan_created_at']) <= timestamp(observations['plan_completed_at']))
        names = observations['revision_names']
        observed = verify_receipt(inputs, report['plan_sha256'], observations['receipt'], names, 'before',
                                  not_before=observations['plan_completed_at'])
        mode = observed['mode']
        creates = [r['actions'] == ['create'] for r in report['resources']]
        require(all(creates) if mode == 'first_deployment' else not any(creates))
    rollback = rollback_evidence(inputs, predecessor, mode)
    rel = inputs['release']
    after_names = {kind: sorted(set(names[kind]) | {f'tonyai-staging-{kind}--{rel["release_id"]}'}) for kind in names}
    return {
        'schema': 1, 'status': 'BLOCKED_DRAFT', 'authorization': False, 'live_acceptance': False,
        'authenticated_azure_provenance': False, 'binding': report, 'candidate_provenance': provenance,
        'deployment_mode': mode, 'before_observation': observed,
        'approved_outgoing_revision_names': names if observations else None,
        'approved_outgoing_revision_names_sha256': digest(names) if observations else None,
        'required_after_revision_names': after_names if observations else None,
        'release': {key: rel[key] for key in ('source_sha', 'release_id', 'api_digest', 'web_digest',
                    'database_secret_version', 'backend_secret_version', 'storage_cleanup_hold')},
        'smtp_secret_version': rel.get('mail', {}).get('password_secret_version'),
        'rollback': rollback,
        'command_templates': commands(inputs, report, args, names) if observations else None,
        'blocking_requirements': [
            'Owner acceptance of R3 and full R4/PD-3; Units 0-6 and exact-image TLS/schema acceptance remain external.',
            'Authenticate the candidate using --github-run-id; local JSON/fixture evidence is never authenticated provenance.',
            'Owner-authenticated fresh complete Azure observations, exact outgoing set, backend/state lineage and no competing writer.',
            'Bind final private file paths, collection manifests, UTC operation boundaries and all command hashes in one owner approval.',
            'Review predecessor existence and compatibility for an update; first deployment has no rollback target.',
            'A cleared storage cleanup hold requires separate reconciliation evidence and owner approval; a CLI acknowledgement is not approval.',
            'This draft never promotes itself to an executable approval, including when all offline checks pass.'
        ],
        'execution_conditions': [
            'Compare every input/candidate/tool/plan hash immediately before use. Never re-plan under this approval.',
            'Before drain, authenticate a fresh complete observation of the approved API and web revision sets. Any change consumes the attempt and stops it.',
            'Drain only the exact approved API set using the existing helper. Verify its complete inactive set and zero replicas before apply.',
            'First deployment needs successful full group inventory proving both apps absent; failed/forbidden/network reads never prove absence.',
            'After apply, collect the exact after manifest and verify source, release, plan, timestamps, all revisions and zero outgoing replicas.',
            'Any refused, failed, interrupted or partial live attempt consumes approval. No implicit retry; obtain a new exact approval.'
        ],
        'failure_and_recovery': [
            'Stop immediately, preserve private evidence and state, keep acceptance open. Do not continue to later commands.',
            'Drain can leave the API in maintenance. A failure does not prove maintenance ended or restore service.',
            'Inspect failed/partial app and revision state under a new read approval; do not reactivate an unreviewed revision.',
            'Request separate recovery approval for a verified compatible predecessor with a fresh release_id, new saved plan, drain and readback.',
            'Without a predecessor, repair forward under a new approval. Never invent a rollback target or destroy shared infrastructure.',
            'Image rollback cannot reverse schema, data, Auth or secret changes. Preserve storage_cleanup_hold during recovery.'
        ],
    }

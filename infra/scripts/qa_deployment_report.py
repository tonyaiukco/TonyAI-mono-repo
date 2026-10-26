"""Rebind Unit 8 public reports before fresh readback or owner-draft preparation."""
from pathlib import Path
from qa_contract import ROOT, fields, match, require
from qa_discovery import digest, timestamp
from qa_deployment_contract import predecessor
from qa_deployment_plan import summary
from qa_deployment_source import bind_report


def bindings(request, evidence, context):
    return dict(request_sha256=digest(request), predecessor_sha256=digest(evidence),
        before_inputs_sha256=digest(context['before']), after_inputs_sha256=digest(context['after']),
        **{f'unit{unit}_{name}_sha256': digest(evidence[f'unit{unit}'][key])
           for unit in (5, 7) for name, key in (('report', 'saved_plan'), ('readback', 'after_receipt'), ('acceptance', 'owner_acceptance'))},
        application_inputs_sha256=digest(context['inputs']), candidate_sha256=digest(evidence['unit7']['candidate']),
        candidate_provenance_sha256=digest(evidence['unit7']['candidate_provenance']))


def validate(request, evidence, report, *, now=None):
    context = predecessor(request, evidence, now=now)
    expected = summary(context)
    expected.update(bindings(request, evidence, context), source_sha=context['after']['release_sha'],
                    previous_source_sha=context['before']['release_sha'],
                    application_source_sha=context['inputs']['release']['source_sha'], terraform_version='1.13.3')
    fields(report, ' '.join(expected) + ' saved_plan_path terraform_path terraform_binary_sha256 plan_created_at '
           'plan_sha256 provider_lock_sha256 deployment_policy_sha256 configuration_sha256', 'file_sha256')
    require(all(report[k] == v for k, v in expected.items()))
    for key, value in report.items():
        if key.endswith('_sha256') and key != 'file_sha256': match(r'[a-f0-9]{64}', value)
    require(isinstance(report.get('file_sha256', {}), dict))
    for path, value in report.get('file_sha256', {}).items():
        require(isinstance(path, str) and bool(path)); match(r'[a-f0-9]{64}', value)
    for key in ('saved_plan_path', 'terraform_path'): require(Path(report[key]).is_absolute())
    require(timestamp(context['accepted_at']) <= timestamp(report['plan_created_at']))
    bind_report(report, ROOT)
    return context

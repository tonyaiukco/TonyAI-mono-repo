"""Project creation with a durable intent and no automatic retry of ambiguous POSTs."""
import re
import secrets
from pooler import SafeFailure


def validate_project(project, target):
    ref = project.get('ref') or project.get('id', '')
    if (not re.fullmatch(r'[a-z]{20}', ref) or project.get('name') != target['name']
            or project.get('organization_id') != target['organization_id']
            or project.get('region') != 'eu-central-1'):
        raise SafeFailure('Project identity, organization or Frankfurt region does not match.')
    return ref


def ensure_project(api, vault, journal):
    target = journal.data['target']
    matches = [p for p in api('/v1/projects') if p.get('name') == target['name']
               and p.get('organization_id') == target['organization_id']]
    saved = journal.data.get('project_ref')
    if saved:
        project = api('/v1/projects/' + saved)
        if validate_project(project, target) != saved:
            raise SafeFailure('Saved project identity changed.')
        return saved
    if len(matches) > 1:
        raise SafeFailure('Ambiguous projects; owner must reconcile before resuming.')
    if matches:
        if not journal.data.get('project_pending'):
            raise SafeFailure('Unrecorded project already exists; refusing adoption.')
        ref = validate_project(matches[0], target)
        journal.set(project_ref=ref)
        return ref
    if journal.data.get('project_pending'):
        raise SafeFailure('Creation outcome unknown. Do not retry POST; reconcile the existing request with Supabase.')
    password = vault.get('bootstrap-db-password')
    if password is None:
        vault.put('bootstrap-db-password', secrets.token_urlsafe(36), {'purpose': 'project-bootstrap'})
        password = vault.get('bootstrap-db-password')
    if not password or not password.get('value'):
        raise SafeFailure('Bootstrap password could not be recovered from Key Vault.')
    journal.set(project_pending=True)  # Persist BEFORE the non-idempotent request.
    project = api('/v1/projects', 'POST', {
        'name': target['name'], 'organization_slug': target['organization_slug'],
        'region_selection': {'type': 'specific', 'code': 'eu-central-1'},
        'db_pass': password['value'],
    })
    ref = validate_project(project, target)
    journal.set(project_ref=ref)
    return ref

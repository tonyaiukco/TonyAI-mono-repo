"""A maintenance rollout for process-local limits: stop old replicas before apply."""
import time
from configure_oidc import az
from pooler import SafeFailure


def revisions(foundation, read=az, allow_absent=False):
    name = foundation['prefix'] + '-' + foundation['environment'] + '-api'
    scope = ('--subscription', foundation['subscription_id'], '-g', foundation['resource_group'], '-n', name)
    try:
        rows = read('containerapp', 'revision', 'list', '--all', *scope)
    except SafeFailure:
        if not allow_absent:
            raise
        # First creation is owner-run. Only a successful group inventory can
        # establish absence; permission/network errors never mean zero replicas.
        names = read('containerapp', 'list', '--subscription', foundation['subscription_id'],
                     '-g', foundation['resource_group'], '--query', '[].name')
        if not isinstance(names, list) or any(not isinstance(n, str) for n in names) or name in names:
            raise SafeFailure('Cannot establish that the API is absent; rollout refused.')
        rows = []
    if not isinstance(rows, list) or any(
        not isinstance(row, dict) or not isinstance(row.get('name'), str)
        or not row['name'].startswith(name + '--')
        or type(row.get('properties', {}).get('active')) is not bool for row in rows
    ):
        raise SafeFailure('Cannot establish the API revision set; rollout refused.')
    return rows, scope


def drain(foundation, release_id, read=az, sleep=time.sleep, attempts=75):
    rows, scope = revisions(foundation, read, allow_absent=True)
    if not rows:
        return
    intended = foundation['prefix'] + '-' + foundation['environment'] + '-api--' + release_id
    target = next((row for row in rows if row['name'] == intended), None)
    if target:
        if not target['properties']['active']:
            raise SafeFailure('Intended revision already exists but is inactive. Review failed deployment and use a new manifest with a fresh release_id.')
        for row in rows:
            if row['name'] == intended:
                continue
            replicas = read('containerapp', 'replica', 'list', *scope, '--revision', row['name'])
            if row['properties']['active'] or not isinstance(replicas, list) or replicas:
                raise SafeFailure('Intended revision overlaps another revision. Review and recover explicitly.')
        # Same release (including a web-only change): a no-op apply cannot
        # reactivate a revision. Leave the already serving revision active.
        return
    for row in rows:
        if row['properties']['active']:
            read('containerapp', 'revision', 'deactivate', *scope, '--revision', row['name'])
    for _ in range(attempts):
        current, _ = revisions(foundation, read)
        empty = True
        for row in current:
            replicas = read('containerapp', 'replica', 'list', *scope, '--revision', row['name'])
            if not isinstance(replicas, list):
                raise SafeFailure('Cannot establish outgoing replica count; rollout refused.')
            empty = empty and not row['properties']['active'] and not replicas
        if empty:
            return
        sleep(2)
    raise SafeFailure('Outgoing API replicas remain. Apply refused; maintenance may still be active.')

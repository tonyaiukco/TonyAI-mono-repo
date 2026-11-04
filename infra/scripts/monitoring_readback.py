#!/usr/bin/env python3
"""Hosted QA monitoring readback: is the log -> alert -> operator chain wired? Read-only.

Reads, through `az rest` GETs at pinned API versions, the resources infra/terraform/foundation
creates (main.tf, monitoring.tf), and counts rows with bounded Log Analytics queries. Prints
one PASS/FAIL line per link with counts only: never log lines, receiver addresses or secret
references. Exit 1 when any link fails. It proposes and applies nothing; a FAIL is fixed by
an owner-reviewed foundation apply (runbook 06, runbook 11).

Environment: the same QA variables as deploy-qa.yml (AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID,
RESOURCE_GROUP, PREFIX, ACR_NAME, VAULT_NAME, ACA_DEFAULT_DOMAIN) after `az login`.
"""
import argparse
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pooler import SafeFailure  # noqa: E402
from qa_autodeploy import foundation_from_env, run_az, stem  # noqa: E402

VERSIONS = {'Microsoft.App/managedEnvironments': '2025-01-01', 'Microsoft.App/containerApps': '2025-01-01',
            'Microsoft.App/jobs': '2025-01-01', 'Microsoft.OperationalInsights/workspaces': '2023-09-01',
            'Microsoft.Insights/diagnosticSettings': '2021-05-01-preview',
            'Microsoft.Insights/scheduledQueryRules': '2023-12-01', 'Microsoft.Insights/metricAlerts': '2018-03-01',
            'Microsoft.Insights/actionGroups': '2023-01-01'}
LOG_API = 'https://api.loganalytics.io'
TABLES = ('ContainerAppConsoleLogs', 'ContainerAppSystemLogs')
SHARED_TABLE_QUERY = 'AzureDiagnostics | summarize rows=count()'


class Reader:
    """GETs on ARM and POSTed queries to the Log Analytics query API; nothing else."""

    def __init__(self, foundation, call=run_az):
        self.foundation, self.call = foundation, call
        self.group = '/subscriptions/' + foundation['subscription_id'] + '/resourceGroups/' + foundation['resource_group']

    def arm(self, kind, name, child=None):
        path = self.group + '/providers/' + kind + '/' + name
        version = VERSIONS[kind]
        if child:
            path, version = path + '/providers/' + child, VERSIONS[child.rsplit('/', 1)[0]]
        argv = ['az', 'rest', '--method', 'get', '--only-show-errors', '--output', 'json',
                '--url', 'https://management.azure.com' + path + '?api-version=' + version]
        try:
            return json.loads(self.call(argv))
        except SafeFailure:
            return None  # absent or unreadable: the link reports FAIL

    def count(self, workspace_id, query, hours):
        """Row count of a query ending in `summarize rows=count()`; None unless the answer is unambiguous.

        Exactly one integer and no partial error: 0 can mean "clean" to a caller, so an empty or
        partial answer must never read as 0. An absent table is a query error, hence None.
        """
        body = json.dumps({'query': query, 'timespan': 'PT' + str(hours) + 'H'})
        argv = ['az', 'rest', '--method', 'post', '--only-show-errors', '--output', 'json',
                '--resource', LOG_API, '--headers', 'Content-Type=application/json',
                '--url', LOG_API + '/v1/workspaces/' + workspace_id + '/query', '--body', body]
        try:
            result = json.loads(self.call(argv))
            rows = result['tables'][0]['rows']
            if result.get('error') or len(rows) != 1 or len(rows[0]) != 1 or type(rows[0][0]) is not int:
                return None
            return rows[0][0]
        except (SafeFailure, KeyError, IndexError, TypeError, ValueError):
            return None


def same(a, b):
    return isinstance(a, str) and isinstance(b, str) and a.lower() == b.lower()


def readback(foundation, reader, hours=26):
    """[(status, link, detail)] for every link of the chain, in order."""
    s, results = stem(foundation), []
    def check(link, ok, detail):
        results.append(('PASS' if ok else 'FAIL', link, detail))
        return ok

    env = reader.arm('Microsoft.App/managedEnvironments', s + '-env') or {}
    destination = ((env.get('properties') or {}).get('appLogsConfiguration') or {}).get('destination')
    check('environment log destination', destination == 'azure-monitor', 'destination=' + str(destination))

    logs = reader.arm('Microsoft.OperationalInsights/workspaces', s + '-logs') or {}
    workspace = (logs.get('properties') or {}).get('customerId')
    check('log analytics workspace', bool(logs.get('id')) and isinstance(workspace, str),
          'present' if logs.get('id') else 'absent')

    setting = reader.arm('Microsoft.App/managedEnvironments', s + '-env',
                         'Microsoft.Insights/diagnosticSettings/container-logs') or {}
    properties = setting.get('properties') or {}
    enabled = {row.get('category') for row in properties.get('logs') or [] if row.get('enabled') is True}
    table_rows = {table: reader.count(workspace, table + ' | summarize rows=count()', hours) if workspace else None
                  for table in TABLES}
    # ARM reads this field back as null although the foundation requests Dedicated (runbook 01).
    # Null therefore passes only on measured routing in the window: rows in both dedicated tables and
    # none in the shared table. A workspace without that table fails closed (count() returns None).
    shared_rows = reader.count(workspace, SHARED_TABLE_QUERY, hours) if workspace else None
    declared = properties.get('logAnalyticsDestinationType')
    routed_to_tables = declared == 'Dedicated' or (declared is None and shared_rows == 0 and all(table_rows.values()))
    check('diagnostic setting container-logs',
          same(properties.get('workspaceId'), logs.get('id')) and routed_to_tables and set(TABLES) <= enabled,
          'absent or unreadable' if not setting else 'workspace ' + ('matches' if same(properties.get('workspaceId'), logs.get('id')) else 'differs')
          + ', categories ' + (','.join(sorted(enabled & set(TABLES))) or 'none')
          + ', destination type ' + str(declared) + ', AzureDiagnostics rows ' + str(shared_rows))

    for table, rows in table_rows.items():
        check(table + ' rows in ' + str(hours) + 'h', bool(rows),
              'table absent or unreadable' if rows is None else str(rows) + ' row(s)')
    verify_query = ('ContainerAppConsoleLogs | where JobName startswith "' + s + '-storage-verify"'
                    ' | extend result = parse_json(Log) | where tostring(result.event) == "storage_verify"'
                    ' | summarize rows=count()')
    results_seen = reader.count(workspace, verify_query, hours) if workspace else None
    check('storage_verify results in ' + str(hours) + 'h', bool(results_seen),
          'unreadable' if results_seen is None else str(results_seen) + ' result(s)')

    job = reader.arm('Microsoft.App/jobs', s + '-storage-verify') or {}
    api = reader.arm('Microsoft.App/containerApps', s + '-api') or {}
    def image(resource):
        containers = ((resource.get('properties') or {}).get('template') or {}).get('containers') or [{}]
        return containers[0].get('image')
    check('storage-verify job image is the live API image', image(job) is not None and image(job) == image(api),
          'job absent' if not job else ('matches' if image(job) == image(api) else 'differs (re-pin the foundation)'))

    group = reader.arm('Microsoft.Insights/actionGroups', s + '-operator') or {}
    group_properties = group.get('properties') or {}
    receivers = len(group_properties.get('emailReceivers') or [])
    check('operator action group', group_properties.get('enabled') is True and receivers >= 1,
          'absent or unreadable' if not group else str(receivers) + ' email receiver(s)')

    rule = reader.arm('Microsoft.Insights/scheduledQueryRules', s + '-storage-verify') or {}
    rule_properties = rule.get('properties') or {}
    routed = any(same(g, group.get('id')) for g in (rule_properties.get('actions') or {}).get('actionGroups') or [])
    check('storage-verify log alert', rule_properties.get('enabled') is True and routed
          and any(same(scope, logs.get('id')) for scope in rule_properties.get('scopes') or []),
          'absent or unreadable' if not rule else 'enabled=' + str(rule_properties.get('enabled')) + ', routed=' + str(routed))

    for suffix in ('http-5xx', 'restarts'):
        alert = reader.arm('Microsoft.Insights/metricAlerts', s + '-api-' + suffix) or {}
        alert_properties = alert.get('properties') or {}
        routed = any(same(a.get('actionGroupId'), group.get('id')) for a in alert_properties.get('actions') or [])
        check('API ' + suffix + ' metric alert', alert_properties.get('enabled') is True and routed
              and any(same(scope, api.get('id')) for scope in alert_properties.get('scopes') or []),
              'absent or unreadable' if not alert else 'enabled=' + str(alert_properties.get('enabled')) + ', routed=' + str(routed))
    return results


def main(argv=None, env=None):
    import os
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--hours', type=int, default=26, help='row-count window (1-72, default 26 as the alert)')
    args = parser.parse_args(argv)
    if not 1 <= args.hours <= 72:
        raise SafeFailure('The window must be 1 to 72 hours.')
    foundation = foundation_from_env(env if env is not None else os.environ)
    results = readback(foundation, Reader(foundation), args.hours)
    for status, link, detail in results:
        print(status + ': ' + link + ': ' + detail)
    failed = [link for status, link, _ in results if status == 'FAIL']
    print(('FAIL: ' + str(len(failed)) + ' link(s) need an owner-reviewed foundation fix.') if failed
          else 'PASS: every link of the log-to-alert chain is wired.')
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))

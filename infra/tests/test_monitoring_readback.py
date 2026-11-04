"""Monitoring readback: every link of the log -> alert -> operator chain, read-only, counts only.

Offline: `az` is a fake that serves recorded ARM shapes and Log Analytics answers.
"""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import monitoring_readback as mr
from pooler import SafeFailure

ENV = {'AZURE_SUBSCRIPTION_ID': 'cb7efc2f-37a7-4672-b62c-93c207bcd33d',
       'AZURE_TENANT_ID': '00000000-0000-0000-0000-000000000002',
       'RESOURCE_GROUP': 'tonyai-qatmp-apps', 'PREFIX': 'tonyaiqt', 'ACR_NAME': 'tonyaiqtacr',
       'VAULT_NAME': 'tonyaiqt-kv', 'ACA_DEFAULT_DOMAIN': 'qa.swedencentral.azurecontainerapps.io'}
FOUNDATION = mr.foundation_from_env(ENV)
GROUP = '/subscriptions/' + ENV['AZURE_SUBSCRIPTION_ID'] + '/resourceGroups/tonyai-qatmp-apps/providers/'
S = 'tonyaiqt-staging'
LOGS = GROUP + 'Microsoft.OperationalInsights/workspaces/' + S + '-logs'
API = GROUP + 'Microsoft.App/containerApps/' + S + '-api'
OPERATOR = GROUP + 'Microsoft.Insights/actionGroups/' + S + '-operator'
IMAGE = 'tonyaiqtacr.azurecr.io/tonyai/api@sha256:' + '1' * 64
WORKSPACE = '11111111-2222-3333-4444-555555555555'


def wired():
    """ARM path -> resource, as the foundation creates it."""
    env_path = GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env'
    return {
        env_path: {'properties': {'appLogsConfiguration': {'destination': 'azure-monitor'}}},
        LOGS: {'id': LOGS, 'properties': {'customerId': WORKSPACE}},
        env_path + '/providers/Microsoft.Insights/diagnosticSettings/container-logs': {'properties': {
            'workspaceId': LOGS.upper(), 'logAnalyticsDestinationType': 'Dedicated',
            'logs': [{'category': 'ContainerAppConsoleLogs', 'enabled': True},
                     {'category': 'ContainerAppSystemLogs', 'enabled': True},
                     {'category': 'ContainerAppHTTPLogs', 'enabled': False}]}},
        GROUP + 'Microsoft.App/jobs/' + S + '-storage-verify': {'properties': {'template': {'containers': [{'image': IMAGE}]}}},
        API: {'id': API, 'properties': {'template': {'containers': [{'image': IMAGE}]}}},
        OPERATOR: {'id': OPERATOR, 'properties': {'enabled': True, 'emailReceivers': [
            {'name': 'Operator', 'emailAddress': 'operator@example.com'}]}},
        GROUP + 'Microsoft.Insights/scheduledQueryRules/' + S + '-storage-verify': {'properties': {
            'enabled': True, 'scopes': [LOGS], 'actions': {'actionGroups': [OPERATOR]}}},
        **{GROUP + 'Microsoft.Insights/metricAlerts/' + S + '-api-' + suffix: {'properties': {
            'enabled': True, 'scopes': [API], 'actions': [{'actionGroupId': OPERATOR}]}} for suffix in ('http-5xx', 'restarts')},
    }


class FakeAz:
    def __init__(self, resources=None, counts=None):
        self.resources = wired() if resources is None else resources
        self.counts = {'ContainerAppConsoleLogs |': 40, 'ContainerAppSystemLogs |': 12, 'storage_verify': 1, 'AzureDiagnostics': 0, **(counts or {})}
        self.calls = []

    def __call__(self, argv):
        self.calls.append(argv)
        method, url = argv[argv.index('--method') + 1], argv[argv.index('--url') + 1]
        if method == 'get':
            path = url.split('https://management.azure.com', 1)[1].split('?')[0]
            if path not in self.resources:
                raise SafeFailure('Azure call failed; raw output withheld.')
            return json.dumps(self.resources[path])
        assert method == 'post' and url == mr.LOG_API + '/v1/workspaces/' + WORKSPACE + '/query', argv
        query = json.loads(argv[argv.index('--body') + 1])['query']
        key = next(k for k in ('storage_verify', 'AzureDiagnostics', 'ContainerAppConsoleLogs |', 'ContainerAppSystemLogs |') if k in query)
        if self.counts[key] is None:
            raise SafeFailure("Azure call failed; raw output withheld.")  # table absent: semantic error
        if isinstance(self.counts[key], dict):
            return json.dumps(self.counts[key])  # a recorded raw answer
        return json.dumps({'tables': [{'rows': [[self.counts[key]]]}]})


def run(resources=None, counts=None):
    az = FakeAz(resources, counts)
    return {link: (status, detail) for status, link, detail in mr.readback(FOUNDATION, mr.Reader(FOUNDATION, az))}, az


class ReadbackTests(unittest.TestCase):
    def test_wired_chain_passes_every_link_with_counts_only(self):
        results, az = run()
        self.assertTrue(all(status == 'PASS' for status, _ in results.values()), results)
        self.assertEqual(len(results), 11)
        self.assertEqual(results['ContainerAppConsoleLogs rows in 26h'], ('PASS', '40 row(s)'))
        self.assertEqual(results['operator action group'], ('PASS', '1 email receiver(s)'))
        text = json.dumps(results)
        for private in ('operator@example.com', 'emailAddress', WORKSPACE, 'parse_json'):
            self.assertNotIn(private, text)

    def test_null_destination_fails_and_names_the_link(self):
        resources = wired()
        resources[GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env'] = {'properties': {'appLogsConfiguration': {'destination': None}}}
        results, _ = run(resources)
        self.assertEqual(results['environment log destination'], ('FAIL', 'destination=None'))
        resources[GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env'] = {'properties': {'appLogsConfiguration': None}}
        self.assertEqual(run(resources)[0]['environment log destination'], ('FAIL', 'destination=None'))

    def test_missing_or_misrouted_diagnostic_setting_fails(self):
        path = GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env/providers/Microsoft.Insights/diagnosticSettings/container-logs'
        resources = wired(); del resources[path]
        self.assertEqual(run(resources)[0]['diagnostic setting container-logs'], ('FAIL', 'absent or unreadable'))
        resources = wired(); resources[path]['properties']['workspaceId'] = GROUP + 'Microsoft.OperationalInsights/workspaces/other'
        self.assertEqual(run(resources)[0]['diagnostic setting container-logs'][0], 'FAIL')
        resources = wired(); resources[path]['properties']['logs'][1]['enabled'] = False
        self.assertEqual(run(resources)[0]['diagnostic setting container-logs'][0], 'FAIL')

    def test_null_destination_type_passes_only_on_measured_routing(self):
        path = GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env/providers/Microsoft.Insights/diagnosticSettings/container-logs'
        link = 'diagnostic setting container-logs'
        resources = wired(); resources[path]['properties']['logAnalyticsDestinationType'] = None
        status, detail = run(resources)[0][link]
        self.assertEqual(status, 'PASS')
        self.assertIn('destination type None, AzureDiagnostics rows 0', detail)
        for counts in ({'AzureDiagnostics': 5}, {'AzureDiagnostics': None},
                       {'ContainerAppConsoleLogs |': 0}, {'ContainerAppSystemLogs |': 0},
                       {'ContainerAppConsoleLogs |': None}, {'ContainerAppSystemLogs |': None}):
            self.assertEqual(run(resources, counts)[0][link][0], 'FAIL', counts)
        del resources[path]['properties']['logAnalyticsDestinationType']
        self.assertEqual(run(resources)[0][link][0], 'PASS')

    def test_ambiguous_shared_table_answer_never_reads_as_clean(self):
        path = GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env/providers/Microsoft.Insights/diagnosticSettings/container-logs'
        link = 'diagnostic setting container-logs'
        resources = wired(); resources[path]['properties']['logAnalyticsDestinationType'] = None
        partial = {'code': 'PartialError'}
        for answer in ({'tables': [{'rows': []}]}, {'tables': [{'rows': None}]}, {'tables': []}, {},
                       {'tables': [{'rows': [[0]]}], 'error': partial}, {'tables': [{'rows': []}], 'error': partial},
                       {'tables': [{'rows': [[False]]}]}, {'tables': [{'rows': [[0.9]]}]}, {'tables': [{'rows': [['0']]}]},
                       {'tables': [{'rows': [[0], [0]]}]}, {'tables': [{'rows': [[0, 0]]}]}):
            status, detail = run(resources, {'AzureDiagnostics': answer})[0][link]
            self.assertEqual(status, 'FAIL', answer)
            self.assertIn('AzureDiagnostics rows None', detail, answer)
        self.assertEqual(run(resources, {'AzureDiagnostics': {'tables': [{'rows': [[0]]}]}})[0][link][0], 'PASS')

    def test_row_links_fail_on_an_empty_answer(self):
        results, _ = run(counts={'ContainerAppConsoleLogs |': {'tables': [{'rows': []}]}})
        self.assertEqual(results['ContainerAppConsoleLogs rows in 26h'], ('FAIL', 'table absent or unreadable'))

    def test_queries_and_window_are_exact(self):
        az = FakeAz()
        mr.readback(FOUNDATION, mr.Reader(FOUNDATION, az), 26)
        bodies = [json.loads(argv[argv.index('--body') + 1]) for argv in az.calls if argv[argv.index('--method') + 1] == 'post']
        self.assertEqual(sorted(body['query'] for body in bodies[:3]), ['AzureDiagnostics | summarize rows=count()',
                         'ContainerAppConsoleLogs | summarize rows=count()', 'ContainerAppSystemLogs | summarize rows=count()'])
        self.assertTrue(all(body['timespan'] == 'PT26H' for body in bodies))
        az = FakeAz()
        mr.readback(FOUNDATION, mr.Reader(FOUNDATION, az), 3)
        self.assertTrue(all(json.loads(argv[argv.index('--body') + 1])['timespan'] == 'PT3H' for argv in az.calls
                            if argv[argv.index('--method') + 1] == 'post'))

    def test_other_destination_type_fails_even_with_clean_rows(self):
        path = GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env/providers/Microsoft.Insights/diagnosticSettings/container-logs'
        resources = wired(); resources[path]['properties']['logAnalyticsDestinationType'] = 'AzureDiagnostics'
        status, detail = run(resources)[0]['diagnostic setting container-logs']
        self.assertEqual(status, 'FAIL')
        self.assertIn('destination type AzureDiagnostics', detail)

    def test_explicit_dedicated_keeps_the_workspace_and_category_checks(self):
        path = GROUP + 'Microsoft.App/managedEnvironments/' + S + '-env/providers/Microsoft.Insights/diagnosticSettings/container-logs'
        for field, value in (('workspaceId', GROUP + 'Microsoft.OperationalInsights/workspaces/other'), ('logs', [])):
            for declared in ('Dedicated', None):
                resources = wired()
                resources[path]['properties'][field] = value
                resources[path]['properties']['logAnalyticsDestinationType'] = declared
                self.assertEqual(run(resources)[0]['diagnostic setting container-logs'][0], 'FAIL', (field, declared))

    def test_absent_table_or_zero_rows_fail(self):
        results, _ = run(counts={'ContainerAppConsoleLogs |': None, 'ContainerAppSystemLogs |': 0, 'storage_verify': 0})
        self.assertEqual(results['ContainerAppConsoleLogs rows in 26h'], ('FAIL', 'table absent or unreadable'))
        self.assertEqual(results['ContainerAppSystemLogs rows in 26h'], ('FAIL', '0 row(s)'))
        self.assertEqual(results['storage_verify results in 26h'], ('FAIL', '0 result(s)'))

    def test_job_pinned_to_an_old_image_fails(self):
        resources = wired()
        resources[GROUP + 'Microsoft.App/jobs/' + S + '-storage-verify']['properties']['template']['containers'][0]['image'] = IMAGE.replace('1' * 64, '9' * 64)
        self.assertEqual(run(resources)[0]['storage-verify job image is the live API image'], ('FAIL', 'differs (re-pin the foundation)'))

    def test_disabled_or_unrouted_alerts_fail(self):
        resources = wired()
        resources[GROUP + 'Microsoft.Insights/scheduledQueryRules/' + S + '-storage-verify']['properties']['enabled'] = False
        resources[GROUP + 'Microsoft.Insights/metricAlerts/' + S + '-api-restarts']['properties']['actions'] = []
        resources[OPERATOR]['properties']['emailReceivers'] = []
        results, _ = run(resources)
        for link in ('storage-verify log alert', 'API restarts metric alert', 'operator action group'):
            self.assertEqual(results[link][0], 'FAIL', link)
        self.assertEqual(results['API http-5xx metric alert'][0], 'PASS')

    def test_only_reads(self):
        _, az = run()
        for argv in az.calls:
            method, url = argv[argv.index('--method') + 1], argv[argv.index('--url') + 1]
            self.assertTrue(method == 'get' or (method == 'post' and url.startswith(mr.LOG_API + '/v1/workspaces/')
                                                and url.endswith('/query')), argv)
            self.assertTrue(url.startswith(('https://management.azure.com' + GROUP[:-len('/providers/')], mr.LOG_API)), url)
        self.assertEqual(sum(1 for argv in az.calls if argv[argv.index('--method') + 1] == 'post'), 4)

    def test_main_bounds_the_window(self):
        with self.assertRaises(SafeFailure):
            mr.main(['--hours', '0'], ENV)
        with self.assertRaises(SafeFailure):
            mr.main(['--hours', '73'], ENV)


if __name__ == '__main__':
    unittest.main()

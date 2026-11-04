"""Hosted QA auto-deploy: decision, live binding, rollout, verification, smoke and rollback.

Offline only: Azure, git, HTTP, Docker, GitHub and Key Vault are injected fakes.
"""
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import candidate as candidate_module
import qa_autodeploy as qa
from pooler import SafeFailure

SHA, OLD = 'b' * 40, 'a' * 40
QA_ENV = {'AZURE_SUBSCRIPTION_ID': 'cb7efc2f-37a7-4672-b62c-93c207bcd33d',
          'AZURE_TENANT_ID': '00000000-0000-0000-0000-000000000002',
          'RESOURCE_GROUP': 'tonyai-qatmp-apps', 'PREFIX': 'tonyaiqt', 'ACR_NAME': 'tonyaiqtacr',
          'VAULT_NAME': 'tonyaiqt-kv', 'ACA_DEFAULT_DOMAIN': 'qa.swedencentral.azurecontainerapps.io',
          'GITHUB_RUN_NUMBER': '42', 'GITHUB_RUN_ATTEMPT': '1'}
FOUNDATION = qa.foundation_from_env(QA_ENV)
STEM = 'tonyaiqt-staging'
PROJECT = 'abcdefghijklmnopqrst'
CANDIDATE = {'api_digest': 'sha256:' + '1' * 64, 'web_digest': 'sha256:' + '2' * 64}
OLD_DIGEST = {'api': 'sha256:' + '3' * 64, 'web': 'sha256:' + '4' * 64}
IMAGE = {k: 'tonyaiqtacr.azurecr.io/tonyai/' + k + '@' + CANDIDATE[k + '_digest'] for k in ('api', 'web')}
GROUP = '/subscriptions/' + QA_ENV['AZURE_SUBSCRIPTION_ID'] + '/resourceGroups/tonyai-qatmp-apps'
APPS = GROUP + '/providers/Microsoft.App/containerApps'


def live_app(kind, suffix='r004', source=OLD):
    secrets = [{'name': n, 'identity': GROUP + '/providers/Microsoft.ManagedIdentity/userAssignedIdentities/' + STEM + '-api',
                'keyVaultUrl': 'https://tonyaiqt-kv.vault.azure.net/secrets/' + n + '/' + v * 32}
               for n, v in (('database-url', 'c'), ('supabase-service-role-key', 'd'))] if kind == 'api' else None
    env = ([{'name': 'STORAGE_CLEANUP_HOLD', 'value': '1'}, {'name': 'STORAGE_SWEEP_INTERVAL_SECONDS', 'value': '300'},
            {'name': 'DATABASE_URL', 'secretRef': 'database-url'}] if kind == 'api' else [{'name': 'PORT', 'value': '3000'}])
    return {'id': APPS + '/' + STEM + '-' + kind,
            'name': STEM + '-' + kind, 'tags': {'application': 'TonyAI', 'release': suffix, 'source': source},
            'identity': {'type': 'UserAssigned'},
            'properties': {'provisioningState': 'Succeeded',
                           'latestReadyRevisionName': STEM + '-' + kind + '--' + suffix,
                           'configuration': {'activeRevisionsMode': 'Single', 'secrets': secrets},
                           'template': {'revisionSuffix': suffix, 'terminationGracePeriodSeconds': 120,
                                        'containers': [{'name': kind, 'env': env,
                                                        'image': 'tonyaiqtacr.azurecr.io/tonyai/' + kind + '@' + OLD_DIGEST[kind]}]}}}


class FakeAzure:
    """Container Apps whose PATCH creates a ready revision; optional faults."""
    def __init__(self, fail_ready=(), drift=False, broken_rollback=()):
        self.apps = {k: live_app(k) for k in ('api', 'web')}
        self.api_revisions = [{'name': STEM + '-api--r004', 'properties': {'active': True}}]
        self.fail_ready, self.drift, self.broken_rollback = set(fail_ready), drift, set(broken_rollback)
        self.patches, self.calls = [], []

    def read(self, *args):
        self.calls.append(args[:3])
        if args[:2] == ('containerapp', 'show'):
            return copy.deepcopy(self.apps[args[args.index('-n') + 1].rsplit('-', 1)[1]])
        if args[:3] == ('containerapp', 'revision', 'list'):
            return copy.deepcopy(self.api_revisions)
        if args[:3] == ('containerapp', 'revision', 'deactivate'):
            name = args[args.index('--revision') + 1]
            for row in self.api_revisions:
                if row['name'] == name: row['properties']['active'] = False
            return {}
        if args[:3] == ('containerapp', 'replica', 'list'):
            name = args[args.index('--revision') + 1]
            return [{}] if any(r['name'] == name and r['properties']['active'] for r in self.api_revisions) else []
        raise AssertionError(args)

    def patch(self, app, body):
        kind = app['name'].rsplit('-', 1)[1]
        suffix = body['properties']['template']['revisionSuffix']
        self.patches.append((kind, body))
        self.calls.append(('PATCH', kind))
        if suffix.endswith('-rb') and kind in self.broken_rollback:
            raise SafeFailure('rollback PATCH refused')
        current = self.apps[kind]
        current['tags'] = body['tags']
        current['properties']['template'] = copy.deepcopy(body['properties']['template'])
        if self.drift and kind == 'web' and not suffix.endswith('-rb'):
            current['properties']['template']['containers'][0]['env'].append({'name': 'EXTRA', 'value': '1'})
        if kind in self.fail_ready and not suffix.endswith('-rb'):
            current['properties']['provisioningState'] = 'Failed'
            return
        current['properties']['provisioningState'] = 'Succeeded'
        current['properties']['latestReadyRevisionName'] = STEM + '-' + kind + '--' + suffix
        if kind == 'api':
            for row in self.api_revisions: row['properties']['active'] = False
            self.api_revisions.append({'name': STEM + '-api--' + suffix, 'properties': {'active': True}})


def statuses(overrides=None):
    table = {'/api/v1/health': 200, '/api/v1/health/ready': 200, '/api/v1/health/synthetic': 401, '/login': 200}
    table.update(overrides or {})
    return lambda url: table['/' + url.split('/', 3)[3]]


def git_fake(diff='docs/x.md\napps/api/src/a.ts\n', ancestor=0, head=SHA, seen=None):
    def run_git(*args):
        if seen is not None: seen.append(args)
        return {'ls-remote': (0, head + '\trefs/heads/main'), 'merge-base': (ancestor, ''), 'diff': (0, diff)}[args[0]]
    return run_git


class DecisionTests(unittest.TestCase):
    def test_skips_when_main_moved_on_even_if_forced(self):
        self.assertFalse(qa.decide(SHA, 'c' * 40, OLD, ['apps/web/x.tsx'], force=True)[0])

    def test_forced_dispatch_deploys_head(self):
        self.assertTrue(qa.decide(SHA, SHA, SHA, [], force=True)[0])

    def test_docs_and_infra_only_changes_skip(self):
        changed = ['docs/a.md', 'infra/scripts/x.py', 'e2e/a.spec.ts', '.github/workflows/ci.yml', 'README.md', '.claude/x']
        self.assertFalse(qa.decide(SHA, SHA, OLD, changed)[0])

    def test_image_relevant_changes_deploy(self):
        for path in ('apps/api/src/x.ts', 'packages/db/prisma/migrations/x/migration.sql', 'pnpm-lock.yaml',
                     'package.json', 'turbo.json', 'apps/web/Dockerfile', '.dockerignore',
                     'infra/certs/prod-ca-2021.crt'):
            with self.subTest(path=path):
                self.assertTrue(qa.decide(SHA, SHA, OLD, ['docs/a.md', path])[0])

    def test_openspec_only_changes_skip(self):
        changed = ['openspec/config.yaml', 'openspec/changes/x/proposal.md', 'openspec/changes/x/specs/y/spec.md']
        deploy, reason = qa.decide(SHA, SHA, OLD, changed)
        self.assertFalse(deploy)
        self.assertIn('no image-relevant change', reason)

    def test_openspec_beside_application_counts_only_the_application(self):
        self.assertEqual(qa.image_relevant(['openspec/changes/x/tasks.md', 'apps/api/src/x.ts']), ['apps/api/src/x.ts'])
        self.assertEqual(qa.decide(SHA, SHA, OLD, ['openspec/changes/x/tasks.md', 'apps/api/src/x.ts']),
                         (True, '1 image-relevant file(s) changed since the deployed source.'))

    def test_certs_keep_precedence_over_non_image_prefixes(self):
        self.assertTrue(qa.decide(SHA, SHA, OLD, ['openspec/config.yaml', 'infra/certs/prod-ca-2021.crt'])[0])

    def test_unknown_deployed_source_deploys_and_same_source_skips(self):
        self.assertTrue(qa.decide(SHA, SHA, None, None)[0])
        self.assertFalse(qa.decide(SHA, SHA, SHA, None)[0])

    def test_plan_diffs_without_rename_detection(self):
        seen = []
        # A file moved out of an app: with renames off, its old path is listed too.
        self.assertTrue(qa.plan(SHA, False, FakeAzure().read, git_fake(diff='apps/api/src/a.ts\ndocs/a.ts\n', seen=seen), QA_ENV)[0])
        self.assertIn(('diff', '--name-only', '--no-renames', OLD, SHA), seen)

    def test_plan_skips_docs_only_merge(self):
        self.assertFalse(qa.plan(SHA, False, FakeAzure().read, git_fake(diff='docs/a.md\n'), QA_ENV)[0])

    def test_plan_treats_diverged_or_mismatched_sources_as_unknown(self):
        self.assertEqual(qa.plan(SHA, False, FakeAzure().read, git_fake(ancestor=1), QA_ENV),
                         (True, 'deployed source unknown or not an ancestor; deploying.'))
        azure = FakeAzure()
        azure.apps['web']['tags'] = None  # ARM answers null tags for an untagged app
        self.assertEqual(qa.plan(SHA, False, azure.read, git_fake(diff='docs/a.md\n'), QA_ENV),
                         (True, 'deployed source unknown or not an ancestor; deploying.'))

    def test_plan_refuses_unreadable_head_and_short_sha(self):
        with self.assertRaises(SafeFailure):
            qa.plan(SHA, False, FakeAzure().read, lambda *a: (128, ''), QA_ENV)
        with self.assertRaises(SafeFailure):
            qa.plan('abc', False, FakeAzure().read, git_fake(), QA_ENV)

    def test_head_step_reports_through_github_output_without_azure(self):
        with tempfile.TemporaryDirectory() as work:
            output = Path(work) / 'out'
            for head, expected in ((SHA, 'current=true\n'), ('c' * 40, 'current=false\n')):
                output.write_text('')
                with patch.object(qa, 'main_head', return_value=head), patch.object(qa, 'Arm', side_effect=AssertionError), \
                        patch('builtins.print'):
                    qa.main(['head', '--sha', SHA], env={'GITHUB_OUTPUT': str(output)})
                self.assertEqual(output.read_text(), expected)


class ContractTests(unittest.TestCase):
    def test_only_the_hosted_qa_target_is_accepted(self):
        for key, value in (('RESOURCE_GROUP', 'tonyai-staging-apps'), ('PREFIX', 'tonyai'),
                           ('ACA_DEFAULT_DOMAIN', 'x.germanywestcentral.azurecontainerapps.io'), ('VAULT_NAME', '')):
            with self.subTest(key=key), self.assertRaises(SafeFailure):
                qa.foundation_from_env({**QA_ENV, key: value})

    def test_release_id_requires_run_identity(self):
        self.assertEqual(qa.release_id(QA_ENV), 'ci42-1')
        for env in ({}, {'GITHUB_RUN_NUMBER': '0', 'GITHUB_RUN_ATTEMPT': '1'},
                    {'GITHUB_RUN_NUMBER': '1;x', 'GITHUB_RUN_ATTEMPT': '1'}):
            with self.assertRaises(SafeFailure):
                qa.release_id(env)

    def bound_candidate(self, sha=SHA):
        """A candidate as build-images.sh would create it for this checkout and QA target."""
        with patch.object(candidate_module, 'clean_source'), \
                patch.object(candidate_module, 'fingerprint', return_value={'lockfile_sha256': 'f' * 64, 'migrations': []}):
            env = {'SUPABASE_PROJECT_REF': PROJECT, 'PREFIX': 'tonyaiqt', 'ACA_DEFAULT_DOMAIN': QA_ENV['ACA_DEFAULT_DOMAIN'],
                   'ACR_NAME': 'tonyaiqtacr', 'ACR_HOST': 'tonyaiqtacr.azurecr.io',
                   'API_ORIGIN': 'https://' + STEM + '-api.' + QA_ENV['ACA_DEFAULT_DOMAIN'],
                   'WEB_ORIGIN': 'https://' + STEM + '-web.' + QA_ENV['ACA_DEFAULT_DOMAIN']}
            return candidate_module.create(sha, CANDIDATE['api_digest'], CANDIDATE['web_digest'], env)

    def live_release(self, candidate, app=None):
        with patch.object(candidate_module, 'clean_source'), \
                patch.object(candidate_module, 'fingerprint', return_value={'lockfile_sha256': 'f' * 64, 'migrations': []}):
            return qa.live_release(FOUNDATION, app or live_app('api'), candidate, SHA, 'ci42-1', PROJECT)

    def test_live_release_reads_exact_versions_and_binds_the_real_candidate(self):
        release = self.live_release(self.bound_candidate())['release']
        self.assertEqual((release['database_secret_version'], release['backend_secret_version']), ('c' * 32, 'd' * 32))
        self.assertIs(release['storage_cleanup_hold'], True)
        self.assertEqual(release['release_id'], 'ci42-1')

    def test_live_release_refuses_candidate_provenance_mismatch(self):
        # Digests are taken from the candidate itself; everything else must match this checkout and target.
        for field, value in (('source_sha', OLD), ('lockfile_sha256', 'e' * 64),
                             ('web_origin', 'https://evil.example'), ('registry', 'evil.azurecr.io')):
            with self.subTest(field=field), self.assertRaises(SafeFailure) as caught:
                self.live_release({**self.bound_candidate(), field: value})
            self.assertIn('Candidate provenance differs', str(caught.exception))

    def test_live_release_refuses_foreign_vault_or_missing_storage_settings(self):
        foreign = live_app('api')
        # Same length as the real prefix: only the vault-name check refuses it.
        foreign['properties']['configuration']['secrets'][0]['keyVaultUrl'] = 'https://tonyaiqt-xx.vault.azure.net/secrets/database-url/' + 'c' * 32
        unset = live_app('api')
        unset['properties']['template']['containers'][0]['env'] = []
        for app in (foreign, unset):
            with self.assertRaises(SafeFailure):
                self.live_release(self.bound_candidate(), app)


class ArmTests(unittest.TestCase):
    def arm(self, responses):
        calls = []
        def call(argv):
            calls.append(argv)
            url = argv[argv.index('--url') + 1]
            return json.dumps(responses.get(url.split('?')[0], {})) if '--output' in argv and argv[argv.index('--output') + 1] == 'json' else ''
        return qa.Arm(FOUNDATION, call), calls

    def scope(self, kind='api'):
        return ('--subscription', FOUNDATION['subscription_id'], '-g', 'tonyai-qatmp-apps', '-n', STEM + '-' + kind)

    def test_maps_drain_calls_to_pinned_rest_paths(self):
        base = 'https://management.azure.com' + APPS + '/' + STEM + '-api'
        arm, calls = self.arm({base + '/revisions': {'value': [{'name': 'x'}]}, base + '/revisions/x/replicas': {'value': []}})
        self.assertEqual(arm('containerapp', 'revision', 'list', '--all', *self.scope()), [{'name': 'x'}])
        self.assertEqual(arm('containerapp', 'replica', 'list', *self.scope(), '--revision', 'x'), [])
        arm('containerapp', 'revision', 'deactivate', *self.scope(), '--revision', 'x')
        self.assertEqual(calls[2][:4], ['az', 'rest', '--method', 'post'])
        self.assertTrue(calls[2][calls[2].index('--url') + 1].endswith('/revisions/x/deactivate?api-version=' + qa.API_VERSION))
        self.assertTrue(all('?api-version=' + qa.API_VERSION in c[c.index('--url') + 1] for c in calls))

    def test_az_calls_have_a_hard_timeout(self):
        import subprocess
        with patch.object(qa.subprocess, 'run', side_effect=subprocess.TimeoutExpired('az', 1)), self.assertRaises(SafeFailure):
            qa.run_az(['az', 'rest'])

    def test_refuses_other_apps_groups_paged_lists_and_unknown_calls(self):
        arm, _ = self.arm({'https://management.azure.com' + APPS + '/' + STEM + '-api/revisions': {'value': [], 'nextLink': 'x'}})
        bad = (('containerapp', 'show', '--subscription', FOUNDATION['subscription_id'], '-g', 'tonyai-qatmp-apps', '-n', 'other-app'),
               ('containerapp', 'show', '--subscription', FOUNDATION['subscription_id'], '-g', 'tonyai-staging-apps', '-n', STEM + '-api'),
               ('containerapp', 'revision', 'list', '--all', *self.scope()),
               ('containerapp', 'delete', *self.scope()))
        for args in bad:
            with self.subTest(args=args[:3]), self.assertRaises(SafeFailure):
                arm(*args)

    def test_patch_sends_the_body_from_a_removed_file_to_the_qa_app_only(self):
        arm, calls = self.arm({})
        arm.patch(live_app('api'), {'tags': {}, 'properties': {'template': {}}})
        argv, = calls
        self.assertEqual(argv[:4], ['az', 'rest', '--method', 'patch'])
        body = argv[argv.index('--body') + 1]
        self.assertTrue(body.startswith('@'))
        self.assertFalse(Path(body[1:]).exists())
        with self.assertRaises(SafeFailure):
            arm.patch({**live_app('api'), 'id': GROUP + '/providers/Microsoft.App/containerApps/other'}, {})


class MigrationTests(unittest.TestCase):
    URL = ('postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres'
           '?sslmode=require&sslaccept=strict&sslcert=/app/infra/certs/prod-ca-2021.crt')

    def inputs(self):
        return {'foundation': FOUNDATION, 'release': {'supabase_project_ref': PROJECT}}

    def run_migrate(self, url=None, version='e' * 32, check_fails=False):
        seen = {'operations': []}
        def runner(image, bundle, engine, adjusted, operation, env=None):
            seen.update(image=image, url=adjusted)
            seen['operations'].append(operation)
            if operation == 'owner-check':
                if check_fails:
                    raise SafeFailure('Migration operation stopped; no retry.')
                return {'status': 'PRIVILEGES_CHECKED', 'platform_default_findings': 3}
            return {'status': 'MIGRATIONS_CURRENT', 'applied_count': 1}
        with tempfile.TemporaryDirectory() as work, \
                patch.object(qa, 'prepare', return_value='img@sha256:x'), patch.object(qa, 'copy_engine'):
            result = qa.migrate(self.inputs(), CANDIDATE, version, work,
                                read_secret=lambda vault, name, v: seen.update(secret=(vault, name, v)) or (url or self.URL),
                                runner=runner, inspect=lambda image: {}, pull=lambda ref: seen.update(pulled=ref),
                                engine_source=lambda path: path)
        return result, seen

    def test_migrates_then_checks_owner_privileges_with_the_exact_version(self):
        (applied, checked), seen = self.run_migrate()
        self.assertEqual(applied['applied_count'], 1)
        self.assertEqual(seen['operations'], ['migrate', 'owner-check'])
        self.assertEqual(checked.get('platform_default_findings'), 3)
        self.assertEqual(seen['secret'], ('tonyaiqt-kv', 'direct-url', 'e' * 32))
        self.assertEqual(seen['pulled'], 'img@sha256:x')
        self.assertIn('sslcert=%2Fmigration%2Fca.crt', seen['url'])

    def test_privilege_problem_stops_before_rollout(self):
        with self.assertRaises(SafeFailure):
            self.run_migrate(check_fails=True)

    def test_refuses_missing_version_and_foreign_database(self):
        with self.assertRaises(SafeFailure):
            self.run_migrate(version='')
        with self.assertRaises(SafeFailure):
            self.run_migrate(url=self.URL.replace('eu-north-1', 'us-east-1'))

    def test_refuses_ambient_database_credentials(self):
        with patch.dict('os.environ', {'DATABASE_URL': 'postgres://x'}), self.assertRaises(SafeFailure):
            self.run_migrate()

    def test_engine_download_is_checksum_bound(self):
        payload = gzip.compress(b'not the engine')
        opener = lambda url, timeout: io.BytesIO(payload)
        with tempfile.TemporaryDirectory() as work, self.assertRaises(SafeFailure):
            qa.fetch_engine(Path(work) / 'engine', opener=opener)
        with tempfile.TemporaryDirectory() as work, \
                patch.object(qa, 'ENGINE_SHA256', hashlib.sha256(b'not the engine').hexdigest()):
            target = qa.fetch_engine(Path(work) / 'engine', opener=opener)
            self.assertEqual(target.read_bytes(), b'not the engine')

    def test_engine_download_does_not_send_the_default_user_agent(self):
        # binaries.prisma.sh answers Python-urllib with Cloudflare 403 (error 1010).
        seen = []
        def opener(request, timeout):
            seen.append(request)
            return io.BytesIO(gzip.compress(b'engine'))
        with tempfile.TemporaryDirectory() as work, \
                patch.object(qa, 'ENGINE_SHA256', hashlib.sha256(b'engine').hexdigest()):
            qa.fetch_engine(Path(work) / 'engine', opener=opener)
        self.assertNotIsInstance(seen[0], str)
        self.assertEqual(seen[0].full_url, qa.ENGINE_URL)
        self.assertEqual(seen[0].get_header('User-agent'), 'tonyai-qa-deploy')

    def test_engine_download_failure_names_itself(self):
        def refused(request, timeout):
            raise HTTPError(qa.ENGINE_URL, 403, 'Forbidden', None, None)
        def unreachable(request, timeout):
            raise URLError('down')
        def truncated(request, timeout):
            return io.BytesIO(gzip.compress(b'engine')[:-4])
        def not_gzip(request, timeout):
            return io.BytesIO(b'error code: 1010')
        def outcome(opener):
            with tempfile.TemporaryDirectory() as work:
                try:
                    qa.fetch_engine(Path(work) / 'engine', opener=opener)
                except SafeFailure as error:
                    return str(error)
                except Exception as error:  # a bare traceback becomes "details withheld" in the run
                    return 'escaped: ' + type(error).__name__
            return 'no failure'
        self.assertEqual(outcome(refused), 'Schema-engine download failed: HTTP 403.')
        for opener in (unreachable, truncated, not_gzip):
            self.assertIn('Schema-engine download failed', outcome(opener))


class RolloutTests(unittest.TestCase):
    def rollout(self, azure, fetch=None, clock=None, sleep=None):
        log = []
        qa.rollout(FOUNDATION, CANDIDATE, SHA, 'ci42-1', azure.read, azure.patch, qa.Arm(FOUNDATION).owns,
                   sleep=sleep or (lambda s: None), fetch=fetch or statuses(), log=log.append,
                   clock=clock or (lambda: 0.0), shield=lambda: azure.calls.append(('SHIELD',)))
        return log

    def test_drains_api_then_updates_api_and_web_images_only(self):
        azure = FakeAzure()
        self.rollout(azure)
        self.assertEqual([k for k, _ in azure.patches], ['api', 'web'])
        self.assertIn(('containerapp', 'revision', 'deactivate'), azure.calls)
        self.assertLess(azure.calls.index(('containerapp', 'revision', 'deactivate')), azure.calls.index(('PATCH', 'api')))
        self.assertLess(azure.calls.index(('PATCH', 'api')), azure.calls.index(('PATCH', 'web')))
        for kind, body in azure.patches:
            self.assertEqual(set(body), {'tags', 'properties'})
            self.assertEqual(set(body['properties']), {'template'})
            template = body['properties']['template']
            self.assertEqual(template['containers'][0]['image'], IMAGE[kind])
            self.assertEqual(template['revisionSuffix'], 'ci42-1')
            self.assertEqual(body['tags'], {'application': 'TonyAI', 'release': 'ci42-1', 'source': SHA})
            self.assertNotIn('secrets', json.dumps(body))
        self.assertEqual([r['name'] for r in azure.api_revisions if r['properties']['active']], [STEM + '-api--ci42-1'])

    def test_smoke_failure_rolls_back_web_then_api_and_smokes_again(self):
        azure = FakeAzure()
        def fetch(url):
            # The new release leaves the guarded route open; the rolled-back one guards it again.
            rolled_back = azure.patches[-1][1]['properties']['template']['revisionSuffix'].endswith('-rb')
            return 200 if url.endswith('/synthetic') and not rolled_back else statuses()(url)
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure, fetch=fetch)
        self.assertIn('was rolled back', str(caught.exception))
        self.assertEqual([(k, b['properties']['template']['revisionSuffix']) for k, b in azure.patches],
                         [('api', 'ci42-1'), ('web', 'ci42-1'), ('web', 'ci42-1-rb'), ('api', 'ci42-1-rb')])
        for kind in ('api', 'web'):
            self.assertTrue(azure.apps[kind]['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST[kind]))
            self.assertEqual(azure.apps[kind]['tags']['source'], OLD)

    def test_failed_api_provisioning_rolls_back_api_and_never_touches_web(self):
        azure = FakeAzure(fail_ready={'api'})
        with self.assertRaises(SafeFailure):
            self.rollout(azure)
        self.assertEqual([k for k, _ in azure.patches], ['api', 'api'])
        self.assertTrue(azure.apps['api']['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST['api']))

    def test_drain_failure_before_any_patch_still_restores_the_api(self):
        azure = FakeAzure()
        original = azure.read
        failures = {'left': 1}
        def read(*args):
            if args[:3] == ('containerapp', 'revision', 'deactivate') and failures['left']:
                failures['left'] -= 1
                raise SafeFailure('deactivate refused')
            return original(*args)
        azure.read = read
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure)
        self.assertIn('was rolled back', str(caught.exception))
        self.assertEqual([(k, b['properties']['template']['revisionSuffix']) for k, b in azure.patches], [('api', 'ci42-1-rb')])

    def test_api_rollback_failure_still_rolls_back_web_and_keeps_the_reason(self):
        azure = FakeAzure(broken_rollback={'api'})
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure, fetch=statuses({'/login': 500}))
        message = str(caught.exception)
        self.assertIn('ROLLBACK INCOMPLETE for api', message)
        self.assertIn('/login returned 500', message)
        self.assertTrue(azure.apps['web']['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST['web']))

    def test_failed_smoke_after_rollback_points_at_shared_dependencies(self):
        azure = FakeAzure()
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure, fetch=statuses({'/api/v1/health/ready': 503}))
        self.assertIn('rollback applied but smoke is still failing', str(caught.exception))
        self.assertTrue(azure.apps['api']['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST['api']))

    def test_unowned_target_is_refused_before_the_api_is_drained(self):
        azure = FakeAzure()
        azure.apps['web']['id'] = GROUP + '/providers/Microsoft.App/containerApps/other'
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure)
        self.assertIn('nothing was changed', str(caught.exception))
        self.assertNotIn(('containerapp', 'revision', 'deactivate'), azure.calls)
        self.assertEqual(azure.patches, [])

    def test_group_casing_from_arm_is_still_owned(self):
        app = live_app('api')
        app['id'] = app['id'].replace('tonyai-qatmp-apps', 'TONYAI-QATMP-APPS')
        self.assertTrue(qa.Arm(FOUNDATION).owns(app))

    def test_second_signal_during_rollback_still_reports_what_is_left(self):
        azure = FakeAzure()
        original = azure.patch
        def patch(app, body):
            if body['properties']['template']['revisionSuffix'].endswith('-rb') and app['name'].endswith('-web'):
                raise KeyboardInterrupt()
            return original(app, body)
        azure.patch = patch
        with self.assertRaises(SafeFailure) as caught:
            try:
                self.rollout(azure, fetch=statuses({'/login': 500}))
            except KeyboardInterrupt:
                self.fail('a late signal hid which app was left')
        self.assertIn('ROLLBACK INCOMPLETE for web', str(caught.exception))
        self.assertIn(('SHIELD',), azure.calls)
        self.assertTrue(azure.apps['api']['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST['api']))

    def test_configuration_drift_beyond_the_image_fails_and_rolls_back(self):
        azure = FakeAzure(drift=True)
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure)
        self.assertIn('beyond its image', str(caught.exception))
        self.assertEqual(azure.patches[-2][0], 'web')
        self.assertTrue(azure.patches[-2][1]['properties']['template']['revisionSuffix'].endswith('-rb'))

    def test_exhausted_forward_budget_rolls_back_with_time_left(self):
        azure = FakeAzure()
        ticks = iter(range(0, 10 ** 6, 600))  # each clock read jumps ten minutes
        with self.assertRaises(SafeFailure) as caught:
            self.rollout(azure, clock=lambda: next(ticks), fetch=statuses({'/login': None}))
        self.assertIn('time budget', str(caught.exception))

    def test_job_cancel_interrupt_still_rolls_back(self):
        azure = FakeAzure()
        cancelled = []
        def fetch(url):
            if not cancelled:
                cancelled.append(url)
                raise KeyboardInterrupt()  # the cancel lands once, during the forward smoke
            return statuses()(url)
        with self.assertRaises(SafeFailure) as caught:
            try:
                self.rollout(azure, fetch=fetch)
            except KeyboardInterrupt:
                self.fail('a cancel escaped the rollback')
        self.assertIn('was rolled back', str(caught.exception))
        self.assertEqual([k for k, _ in azure.patches][-2:], ['web', 'api'])

    def test_unexpected_status_codes_fail_smoke(self):
        for path, code in (('/api/v1/health/ready', 503), ('/login', None), ('/api/v1/health', 500),
                           ('/api/v1/health/synthetic', 200)):
            with self.subTest(path=path), self.assertRaises(SafeFailure):
                qa.smoke(FOUNDATION, statuses({path: code}), sleep=lambda s: None, attempts=2)

    def test_smoke_targets_only_the_qa_origins(self):
        seen = []
        qa.smoke(FOUNDATION, lambda url: seen.append(url) or statuses()(url), sleep=lambda s: None)
        self.assertEqual({u.split('/')[2] for u in seen},
                         {STEM + '-api.qa.swedencentral.azurecontainerapps.io', STEM + '-web.qa.swedencentral.azurecontainerapps.io'})


def ci_run(**changes):
    run = {'head_sha': SHA, 'event': 'push', 'head_branch': 'main', 'path': '.github/workflows/ci.yml',
           'head_repository': {'full_name': qa.REPOSITORY}, 'run_number': 10, 'run_attempt': 1,
           'status': 'completed', 'conclusion': 'success'}
    run.update(changes)
    return run


class CiGateTests(unittest.TestCase):
    def state(self, *runs):
        seen = []
        result = qa.ci_state(SHA, lambda path: seen.append(path) or {'workflow_runs': list(runs)})
        self.assertIn('head_sha=' + SHA, seen[0])
        return result

    def test_success_failure_and_pending(self):
        self.assertEqual(self.state(ci_run()), 'success')
        self.assertEqual(self.state(ci_run(conclusion='failure')), 'failed')
        self.assertEqual(self.state(ci_run(conclusion='cancelled')), 'failed')
        self.assertEqual(self.state(ci_run(status='in_progress', conclusion=None)), 'pending')
        self.assertEqual(self.state(), 'pending')

    def test_latest_run_decides(self):
        self.assertEqual(self.state(ci_run(conclusion='failure'), ci_run(run_number=11)), 'success')
        self.assertEqual(self.state(ci_run(run_number=11, conclusion='failure'), ci_run()), 'failed')

    def test_runs_for_other_commits_events_branches_workflows_or_forks_are_ignored(self):
        for other in (ci_run(head_sha=OLD), ci_run(event='pull_request'), ci_run(head_branch='feature'),
                      ci_run(path='.github/workflows/e2e.yml'), ci_run(head_repository={'full_name': 'fork/TonyAI-mono-repo'})):
            with self.subTest(other=other):
                self.assertEqual(self.state(other), 'pending')

    def test_wait_polls_until_green_and_stops_on_red_or_timeout(self):
        answers = iter([{'workflow_runs': []}, {'workflow_runs': [ci_run(status='queued', conclusion=None)]},
                        {'workflow_runs': [ci_run()]}])
        sleeps = []
        qa.wait_ci(SHA, lambda path: next(answers), sleep=sleeps.append)
        self.assertEqual(sleeps, [10, 10])
        with self.assertRaises(SafeFailure):
            qa.wait_ci(SHA, lambda path: {'workflow_runs': [ci_run(conclusion='failure')]}, sleep=lambda s: None)
        with self.assertRaises(SafeFailure):
            qa.wait_ci(SHA, lambda path: {'workflow_runs': []}, sleep=lambda s: None, attempts=3)


def main_rules(ruleset_id=7, drop=(), contexts=('build', 'docker-build', 'rls-probe', 'migration-diff'), app=15368):
    """Rules as GET /repos/{repo}/rules/branches/main returns them: already resolved by GitHub."""
    rules = [{'type': t, 'ruleset_id': ruleset_id, 'parameters': {}} for t in ('deletion', 'non_fast_forward', 'pull_request')]
    rules.append({'type': 'required_status_checks', 'ruleset_id': ruleset_id, 'parameters': {
        'required_status_checks': [{'context': c, 'integration_id': app} for c in contexts]}})
    return [r for r in rules if r['type'] not in drop]


def github(rules, rulesets=None, policy=None, branches=(('main', 'branch'),)):
    rulesets = rulesets if rulesets is not None else {7: {'id': 7, 'enforcement': 'active', 'bypass_actors': []}}
    paths = []
    def read(path):
        paths.append(path)
        if path.endswith('/rules/branches/main?per_page=100'):
            return rules
        if '/rulesets/' in path:
            return rulesets[int(path.rsplit('/', 1)[1])]
        if path.endswith('/deployment-branch-policies'):
            return {'total_count': len(branches), 'branch_policies': [{'name': n, 'type': t} for n, t in branches]}
        if path.endswith('/environments/qa'):
            return {'name': 'qa', 'deployment_branch_policy': policy if policy is not None
                    else {'protected_branches': False, 'custom_branch_policies': True}}
        raise AssertionError('unexpected GitHub read: ' + path)
    read.paths = paths
    return read


class GitHubEnvironmentTests(unittest.TestCase):
    def test_accepts_main_only_with_bypass_free_rules(self):
        read = github(main_rules())
        qa.verify_qa_environment(read=read)
        # GitHub resolves which rules apply to main; ruleset conditions are never interpreted here.
        self.assertTrue(all('/rulesets?' not in path for path in read.paths))

    def test_accepts_rules_split_across_bypass_free_rulesets(self):
        rules = main_rules(7, drop=('required_status_checks',)) + main_rules(8, drop=('deletion', 'non_fast_forward', 'pull_request'))
        rulesets = {i: {'id': i, 'enforcement': 'active', 'bypass_actors': []} for i in (7, 8)}
        qa.verify_main_ruleset(read=github(rules, rulesets))

    def test_a_bypass_free_copy_of_a_rule_is_enough(self):
        rules = main_rules(7) + main_rules(9)
        rulesets = {7: {'id': 7, 'enforcement': 'active', 'bypass_actors': []},
                    9: {'id': 9, 'enforcement': 'active', 'bypass_actors': [{'actor_type': 'RepositoryRole'}]}}
        qa.verify_main_ruleset(read=github(rules, rulesets))

    def test_refuses_when_no_rule_applies_to_main(self):
        # Codex P2 (PR #268): a ruleset on the default branch that excludes main, a
        # pattern excluding it, or ~DEFAULT_BRANCH on another default branch all leave
        # GitHub with no rule on main, so the check must refuse rather than read conditions.
        with self.assertRaises(SafeFailure):
            qa.verify_qa_environment(read=github([]))

    def test_refuses_rules_that_can_be_bypassed_or_cannot_be_seen(self):
        for ruleset in ({'id': 7, 'enforcement': 'active', 'bypass_actors': [{'actor_type': 'OrganizationAdmin'}]},
                        {'id': 7, 'enforcement': 'active'},  # non-admin view: bypass actors hidden
                        {'id': 7, 'enforcement': 'evaluate', 'bypass_actors': []}):
            with self.subTest(ruleset=ruleset), self.assertRaises(SafeFailure):
                qa.verify_main_ruleset(read=github(main_rules(), {7: ruleset}))

    def test_refuses_each_missing_rule_or_ci_job(self):
        weaker = [main_rules(drop=(kind,)) for kind in ('pull_request', 'deletion', 'non_fast_forward', 'required_status_checks')]
        weaker += [main_rules(contexts=('build', 'docker-build', 'rls-probe')), main_rules(app=99999)]
        for rules in weaker:
            with self.subTest(rules=[r['type'] for r in rules]), self.assertRaises(SafeFailure):
                qa.verify_main_ruleset(read=github(rules))

    def test_refuses_truncated_or_anonymous_rule_lists(self):
        anonymous = main_rules()
        anonymous[0] = {**anonymous[0], 'ruleset_id': None}
        for rules in (main_rules() * 25, anonymous, {'message': 'Not Found'}):
            with self.subTest(size=len(rules)), self.assertRaises(SafeFailure):
                qa.verify_main_ruleset(read=github(rules))

    def test_refuses_any_other_environment_policy(self):
        custom = {'protected_branches': False, 'custom_branch_policies': True}
        for policy, branches in (({}, []), ({'protected_branches': True, 'custom_branch_policies': False}, []),
                                 (custom, []), (custom, [('main', 'branch'), ('*', 'branch')]),
                                 (custom, [('main', 'tag')]), (custom, [('ma*', 'branch')])):
            with self.subTest(policy=policy, branches=branches), self.assertRaises(SafeFailure):
                qa.verify_qa_environment(read=github(main_rules(), policy=policy, branches=branches))


# ---------------------------------------------------------------- inputs export and rollback

TARGET = 'e' * 40
MIGRATION = 'packages/db/prisma/migrations/20261001000000_init/migration.sql'
EXTRA_MIGRATION = 'packages/db/prisma/migrations/20261101000000_more/migration.sql'
TREE = {'pnpm-lock.yaml': b'lockfile', MIGRATION: b'CREATE TABLE a ();\n',
        'packages/db/prisma/migrations/migration_lock.toml': b'provider = "postgresql"\n'}


def git_objects(trees):
    """`git ls-tree` / `git show` over per-commit trees; unknown objects fail like git does."""
    def read_git(*args):
        if args[0] == 'ls-tree':
            assert args[:4] == ('ls-tree', '-r', '-z', '--name-only'), args
            if args[4] not in trees:
                raise SafeFailure('Cannot read the source commit from git; fetch full history first.')
            return '\0'.join(sorted(trees[args[4]])).encode()
        if args[0] == 'show':
            sha, path = args[1].split(':', 1)
            if path not in trees.get(sha, {}):
                raise SafeFailure('Cannot read the source commit from git; fetch full history first.')
            return trees[sha][path]
        raise AssertionError(args)
    return read_git


def candidate_for(sha, digests, tree=TREE):
    origin = 'https://' + STEM + '-{}.' + QA_ENV['ACA_DEFAULT_DOMAIN']
    return {'schema': 1, 'environment': 'staging', 'source_sha': sha,
            'api_digest': digests['api'], 'web_digest': digests['web'],
            'registry': 'tonyaiqtacr.azurecr.io', 'supabase_project_ref': PROJECT,
            'api_origin': origin.format('api'), 'web_origin': origin.format('web'),
            **qa.fingerprint_at(sha, git_objects({sha: tree}))}


def with_release_settings(app, mail=True, smtp_url=None):
    """The live API's mail and runtime-limit settings, as Terraform writes them."""
    from runtime_limits import DEFAULTS
    container = app['properties']['template']['containers'][0]
    container['env'] += [{'name': k, 'value': str(v)} for k, v in DEFAULTS.items()]
    if mail:
        container['env'] += [{'name': 'SMTP_HOST', 'value': 'smtp.azurecomm.net'}, {'name': 'SMTP_PORT', 'value': '587'},
                             {'name': 'SMTP_SECURE', 'value': 'false'}, {'name': 'SMTP_USER', 'value': 'tonyai-qa-smtp'},
                             {'name': 'SMTP_PASSWORD', 'secretRef': 'smtp-password'},
                             {'name': 'MAIL_FROM', 'value': 'DoNotReply@qa.example.azurecomm.net'},
                             {'name': 'APP_URL', 'value': 'https://' + STEM + '-web.' + QA_ENV['ACA_DEFAULT_DOMAIN']}]
        app['properties']['configuration']['secrets'].append(
            {'name': 'smtp-password', 'keyVaultUrl': smtp_url or 'https://tonyaiqt-kv.vault.azure.net/secrets/smtp-password/' + '9' * 32})
    return app


class ProvenanceTests(unittest.TestCase):
    def test_git_object_binding_equals_the_build_candidate(self):
        """bind_at must expect exactly what build-images.sh (candidate.create) records."""
        fingerprint = qa.fingerprint_at(SHA, git_objects({SHA: TREE}))
        with patch.object(candidate_module, 'clean_source'), patch.object(candidate_module, 'fingerprint', return_value=fingerprint):
            env = {'SUPABASE_PROJECT_REF': PROJECT, 'PREFIX': 'tonyaiqt', 'ACA_DEFAULT_DOMAIN': QA_ENV['ACA_DEFAULT_DOMAIN'],
                   'ACR_NAME': 'tonyaiqtacr', 'ACR_HOST': 'tonyaiqtacr.azurecr.io',
                   'API_ORIGIN': 'https://' + STEM + '-api.' + QA_ENV['ACA_DEFAULT_DOMAIN'],
                   'WEB_ORIGIN': 'https://' + STEM + '-web.' + QA_ENV['ACA_DEFAULT_DOMAIN']}
            built = candidate_module.create(SHA, CANDIDATE['api_digest'], CANDIDATE['web_digest'], env)
        release = qa.live_release_fields(FOUNDATION, live_app('api'), built, SHA, 'ci42-1', PROJECT)
        self.assertEqual(qa.bind_at(built, {'foundation': FOUNDATION, 'release': release}, SHA, git_objects({SHA: TREE})), built)

    def test_git_objects_match_the_working_tree_fingerprint_of_this_repository(self):
        import subprocess
        dirty = subprocess.run(['git', 'status', '--porcelain', '--', 'packages/db/prisma/migrations', 'pnpm-lock.yaml'],
                               cwd=qa.ROOT, capture_output=True, text=True)
        if dirty.returncode or dirty.stdout.strip():
            self.skipTest('migrations or lockfile differ from HEAD in this checkout')
        self.assertEqual(qa.fingerprint_at('HEAD'), candidate_module.fingerprint())

    def test_fingerprint_hashes_only_migration_sql_in_path_order(self):
        tree = {**TREE, EXTRA_MIGRATION: b'ALTER TABLE a ADD b int;\n'}
        names = [m['name'] for m in qa.fingerprint_at(SHA, git_objects({SHA: tree}))['migrations']]
        self.assertEqual(names, ['20261001000000_init', '20261101000000_more'])

    def test_missing_chain_or_unreadable_commit_refuses(self):
        with self.assertRaises(SafeFailure):
            qa.fingerprint_at(SHA, git_objects({SHA: {'pnpm-lock.yaml': b'x'}}))
        with self.assertRaises(SafeFailure):
            qa.fingerprint_at(SHA, git_objects({SHA: {MIGRATION: b'x'}}))


class InputsExportTests(unittest.TestCase):
    def setUp(self):
        self.azure = FakeAzure()
        for kind in ('api', 'web'):
            self.azure.apps[kind] = live_app(kind, suffix='ci4-1', source=SHA)
            self.azure.apps[kind]['properties']['template']['containers'][0]['image'] = IMAGE[kind]
        with_release_settings(self.azure.apps['api'])
        self.candidate = candidate_for(SHA, {'api': CANDIDATE['api_digest'], 'web': CANDIDATE['web_digest']})
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = str(Path(directory.name) / 'inputs.json')
        self.verified = []

    def export(self):
        return qa.export_inputs(FOUNDATION, self.candidate, PROJECT, self.out, self.azure.read,
                                verifier=lambda inputs, read: self.verified.append(inputs),
                                read_git=git_objects({SHA: TREE}))

    def test_consistent_live_state_writes_a_private_binding_the_verifier_accepted(self):
        inputs = self.export()
        self.assertEqual(self.verified, [inputs])
        written = json.loads(Path(self.out).read_text())
        self.assertEqual(written, inputs)
        self.assertEqual(Path(self.out).stat().st_mode & 0o777, 0o600)
        release = written['release']
        self.assertEqual((release['source_sha'], release['release_id']), (SHA, 'ci4-1'))
        self.assertEqual(release['mail'], {'host': 'smtp.azurecomm.net', 'port': 587, 'secure': False,
                                           'user': 'tonyai-qa-smtp', 'from': 'DoNotReply@qa.example.azurecomm.net',
                                           'password_secret_version': '9' * 32})
        self.assertEqual(release['runtime_limits'], {})
        qa.validate_release(written)

    def test_binding_satisfies_the_verifiers_mail_and_runtime_checks(self):
        from mail_settings import verify_mail_environment
        from runtime_limits import expected_env
        release = self.export()['release']
        env = self.azure.apps['api']['properties']['template']['containers'][0]['env']
        verify_mail_environment(env, FOUNDATION, release, 'api')
        live = {item['name']: item.get('value') for item in env}
        self.assertTrue(all(live.get(k) == v for k, v in expected_env(release).items()
                            if k not in ('NODE_OPTIONS', 'PROXY_MODE', 'AZURE_INGRESS_ONLY')))

    def test_binding_holds_version_identifiers_only(self):
        self.export()
        text = Path(self.out).read_text()
        for forbidden in ('vault.azure.net', 'keyVaultUrl', 'secretRef', 'postgres', 'password"'):
            self.assertNotIn(forbidden, text)

    def test_live_override_of_a_runtime_limit_is_carried(self):
        env = self.azure.apps['api']['properties']['template']['containers'][0]['env']
        next(item for item in env if item['name'] == 'RATE_IP_PER_MINUTE')['value'] = '240'
        self.assertEqual(self.export()['release']['runtime_limits'], {'RATE_IP_PER_MINUTE': 240})

    def test_api_without_mail_omits_the_block(self):
        api = live_app('api', suffix='ci4-1', source=SHA)
        api['properties']['template']['containers'][0]['image'] = IMAGE['api']
        self.azure.apps['api'] = with_release_settings(api, mail=False)
        self.assertNotIn('mail', self.export()['release'])

    def assert_refused_without_file(self, message=None):
        with self.assertRaises(SafeFailure) as caught:
            self.export()
        self.assertFalse(Path(self.out).exists())
        self.assertEqual(self.verified, [])
        if message:
            self.assertIn(message, str(caught.exception))

    def test_apps_on_different_sources_or_revisions_refuse(self):
        self.azure.apps['web']['tags']['source'] = OLD
        self.assert_refused_without_file('different sources or revisions')
        self.setUp()
        self.azure.apps['web']['properties']['template']['revisionSuffix'] = 'ci3-1'
        self.assert_refused_without_file('different sources or revisions')

    def test_candidate_of_another_release_refuses(self):
        self.candidate = candidate_for(SHA, OLD_DIGEST)
        self.assert_refused_without_file('Live images differ from the candidate')

    def test_malformed_or_foreign_smtp_reference_refuses(self):
        for url in ('https://tonyaiqt-kv.vault.azure.net/secrets/smtp-password/latest',
                    'https://tonyaiqt-xx.vault.azure.net/secrets/smtp-password/' + '9' * 32):
            with self.subTest(url=url):
                self.setUp()
                secrets = self.azure.apps['api']['properties']['configuration']['secrets']
                next(s for s in secrets if s['name'] == 'smtp-password')['keyVaultUrl'] = url
                self.assert_refused_without_file('SMTP password reference')

    def test_incomplete_mail_or_missing_runtime_limit_refuses(self):
        env = self.azure.apps['api']['properties']['template']['containers'][0]['env']
        env[:] = [item for item in env if item['name'] != 'MAIL_FROM']
        self.assert_refused_without_file('mail settings are incomplete')
        self.setUp()
        env = self.azure.apps['api']['properties']['template']['containers'][0]['env']
        env[:] = [item for item in env if item['name'] != 'SHUTDOWN_GRACE_MS']
        self.assert_refused_without_file('runtime limits')

    def test_never_overwrites_an_existing_file(self):
        Path(self.out).write_text('{}')
        with self.assertRaises(SafeFailure) as caught:
            self.export()
        self.assertIn('already exists', str(caught.exception))
        self.assertEqual(Path(self.out).read_text(), '{}')


class FetchCandidateTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = directory.name
        self.downloads = []

    def run_record(self, **over):
        return {'head_sha': TARGET, 'path': '.github/workflows/deploy-qa.yml@refs/heads/main', 'head_branch': 'main',
                'event': 'push', 'status': 'completed', 'conclusion': 'success', 'run_number': 41, 'run_attempt': 2,
                'repository': {'full_name': qa.REPOSITORY}, 'head_repository': {'full_name': qa.REPOSITORY}, **over}

    def fetch(self, record, candidate=None, run_id='41738446426'):
        def read(path):
            self.assertEqual(path, 'repos/' + qa.REPOSITORY + '/actions/runs/' + run_id)
            return record
        def download(rid, name, directory):
            self.downloads.append((rid, name))
            if candidate is not None:
                Path(directory, 'candidate.json').write_text(json.dumps(candidate))
        return qa.fetch_candidate(run_id, self.dir, read=read, download=download)

    def test_downloads_the_named_artifact_of_a_successful_main_deploy(self):
        path = self.fetch(self.run_record(), {'source_sha': TARGET})
        self.assertEqual(self.downloads, [('41738446426', 'qa-candidate-41-2')])
        self.assertEqual(json.loads(path.read_text())['source_sha'], TARGET)

    def test_refuses_runs_that_are_not_successful_main_deploys_before_download(self):
        for over in ({'path': '.github/workflows/ci.yml'}, {'head_branch': 'feature'}, {'event': 'pull_request'},
                     {'conclusion': 'failure'}, {'status': 'in_progress'}, {'head_repository': {'full_name': 'fork/x'}},
                     {'repository': {'full_name': 'fork/x'}}, {'head_sha': 'main'}, {'run_number': '41'}):
            with self.subTest(over=over), self.assertRaises(SafeFailure):
                self.fetch(self.run_record(**over), {'source_sha': TARGET})
        self.assertEqual(self.downloads, [])

    def test_refuses_non_numeric_run_ids(self):
        for run_id in ('', '0', '12;rm', '../1', None):
            with self.subTest(run_id=run_id), self.assertRaises(SafeFailure):
                qa.fetch_candidate(run_id, self.dir, read=lambda p: self.fail('read'), download=lambda *a: self.fail('download'))

    def test_refuses_a_missing_or_foreign_candidate(self):
        with self.assertRaises(SafeFailure):
            self.fetch(self.run_record(), None)
        with self.assertRaises(SafeFailure) as caught:
            self.fetch(self.run_record(), {'source_sha': OLD})
        self.assertIn('does not belong', str(caught.exception))


class RollbackTests(unittest.TestCase):
    """Live: source OLD with OLD_DIGEST images (FakeAzure). Target: an earlier/later main candidate."""
    def run_rollback(self, candidate, mode='candidate', trees=None, ancestor=0, azure=None, fetch=None, rid='rb42-1'):
        self.azure = azure or FakeAzure()
        trees = trees or {OLD: TREE, TARGET: TREE}
        self.fetched = []
        def record(url):
            self.fetched.append((len(self.azure.patches), url))
            return (fetch or statuses())(url)
        return qa.rollback(FOUNDATION, candidate, mode, rid, PROJECT, self.azure.read, self.azure.patch,
                           qa.Arm(FOUNDATION).owns, run_git=git_fake(ancestor=ancestor), read_git=git_objects(trees),
                           sleep=lambda s: None, fetch=record, log=lambda line: None,
                           clock=lambda: 0.0, shield=lambda: None)

    def assert_smoked_after(self, patch_count):
        """Every smoke URL was fetched after the first `patch_count` PATCHes."""
        paths = {url.split('/', 3)[3] for done, url in self.fetched if done >= patch_count}
        self.assertEqual(paths, {'api/v1/health', 'api/v1/health/ready', 'api/v1/health/synthetic', 'login'})

    def target(self, tree=TREE):
        return candidate_for(TARGET, {'api': CANDIDATE['api_digest'], 'web': CANDIDATE['web_digest']}, tree)

    def assert_untouched(self):
        self.assertEqual(self.azure.patches, [])
        self.assertNotIn(('containerapp', 'revision', 'deactivate'), self.azure.calls)

    def test_rollback_id_marks_the_revision(self):
        self.assertEqual(qa.rollback_id(QA_ENV), 'rb42-1')

    def test_moves_both_apps_to_the_candidate_through_rollout(self):
        self.assertEqual(self.run_rollback(self.target()), TARGET)
        self.assertEqual([k for k, _ in self.azure.patches], ['api', 'web'])
        for kind in ('api', 'web'):
            app = self.azure.apps[kind]
            self.assertEqual(app['properties']['template']['containers'][0]['image'], IMAGE[kind])
            self.assertEqual(app['tags'], {'application': 'TonyAI', 'release': 'rb42-1', 'source': TARGET})
        self.assert_smoked_after(2)

    def test_return_forward_after_a_drill_serves_the_previous_release_again(self):
        self.run_rollback(self.target())
        azure = self.azure
        self.run_rollback(candidate_for(OLD, OLD_DIGEST), azure=azure, rid='rb43-1')
        for kind in ('api', 'web'):
            app = azure.apps[kind]
            self.assertTrue(app['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST[kind]))
            self.assertEqual(app['tags'], {'application': 'TonyAI', 'release': 'rb43-1', 'source': OLD})
        self.assert_smoked_after(4)

    def test_one_source_under_different_suffixes_can_still_be_rolled_back(self):
        """After a deploy failed at the API, only the API was restored (`<rid>-rb`)."""
        azure = FakeAzure()
        azure.apps['api']['properties']['template']['revisionSuffix'] = 'ci5-1-rb'
        self.assertEqual(self.run_rollback(self.target(), azure=azure), TARGET)

    def test_candidate_not_on_main_is_refused_before_drain(self):
        with self.assertRaises(SafeFailure) as caught:
            self.run_rollback(self.target(), ancestor=1)
        self.assertIn('not on main', str(caught.exception))
        self.assert_untouched()

    def test_missing_or_malformed_candidate_is_refused_before_drain(self):
        for candidate in ({}, {**self.target(), 'source_sha': 'main'}, []):
            with self.subTest(candidate=candidate):
                with self.assertRaises(SafeFailure):
                    self.run_rollback(candidate)
                self.assert_untouched()

    def test_migration_difference_is_refused_before_drain(self):
        newer = {**TREE, EXTRA_MIGRATION: b'ALTER TABLE a ADD b int;\n'}
        for trees, target_tree in (({OLD: newer, TARGET: TREE}, TREE), ({OLD: TREE, TARGET: newer}, newer)):
            with self.subTest(live_has_extra=trees[OLD] is newer):
                with self.assertRaises(SafeFailure) as caught:
                    self.run_rollback(self.target(target_tree), trees=trees)
                self.assertIn('cross a migration', str(caught.exception))
                self.assert_untouched()

    def test_provenance_mismatch_is_refused_before_drain(self):
        with self.assertRaises(SafeFailure) as caught:
            self.run_rollback({**self.target(), 'lockfile_sha256': '0' * 64})
        self.assertIn('Candidate provenance differs', str(caught.exception))
        self.assert_untouched()

    def test_live_candidate_needs_same_image_mode(self):
        live = candidate_for(OLD, OLD_DIGEST)
        with self.assertRaises(SafeFailure) as caught:
            self.run_rollback(live)
        self.assertIn('already live', str(caught.exception))
        self.assert_untouched()

    def test_same_image_redeploys_under_a_new_suffix_only(self):
        self.assertEqual(self.run_rollback(candidate_for(OLD, OLD_DIGEST), mode='same-image'), OLD)
        for kind in ('api', 'web'):
            app = self.azure.apps[kind]
            self.assertTrue(app['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST[kind]))
            self.assertEqual(app['tags'], {'application': 'TonyAI', 'release': 'rb42-1', 'source': OLD})
            self.assertEqual(app['properties']['latestReadyRevisionName'], STEM + '-' + kind + '--rb42-1')

    def test_same_image_refuses_another_candidate(self):
        with self.assertRaises(SafeFailure) as caught:
            self.run_rollback(self.target(), mode='same-image')
        self.assertIn('needs the live release candidate', str(caught.exception))
        self.assert_untouched()

    def test_unknown_mode_is_refused(self):
        with self.assertRaises(SafeFailure):
            self.run_rollback(self.target(), mode='r004')

    def test_failure_after_drain_restores_the_previous_release(self):
        with self.assertRaises(SafeFailure) as caught:
            self.run_rollback(self.target(), azure=FakeAzure(fail_ready={'api'}))
        self.assertTrue(str(caught.exception).startswith('QA rollback to ' + TARGET + ' did not complete.'))
        self.assertIn('was rolled back', str(caught.exception))
        restored = [i for i, (_, body) in enumerate(self.azure.patches)
                    if body['properties']['template']['revisionSuffix'].endswith('-rb')]
        self.assertTrue(restored)
        self.assert_smoked_after(restored[-1] + 1)
        self.assertTrue(self.azure.apps['api']['properties']['template']['containers'][0]['image'].endswith(OLD_DIGEST['api']))
        self.assertEqual(self.azure.apps['api']['tags']['source'], OLD)
        self.assertEqual([k for k, _ in self.azure.patches if k == 'web'], [])


if __name__ == '__main__':
    unittest.main()

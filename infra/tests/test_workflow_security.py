"""Parse real workflow YAML and pin the pre-authentication release boundary."""
from pathlib import Path
import unittest
import json
import os
import subprocess
import yaml

ROOT = Path(__file__).resolve().parents[2]


def workflow(name):
    # BaseLoader preserves GitHub's YAML 1.2 `on` key and scalar strings.
    return yaml.load((ROOT / '.github/workflows' / name).read_text(), Loader=yaml.BaseLoader)


class WorkflowTests(unittest.TestCase):
    def test_oidc_only_after_environment_and_release_guards(self):
        for name in ('candidate.yml', 'deploy-staging.yml'):
            doc = workflow(name)
            self.assertEqual(set(doc['on']), {'workflow_dispatch'})
            self.assertEqual(doc['permissions'], {'contents': 'read'})
            for job in doc['jobs'].values():
                self.assertIn("github.ref == 'refs/heads/main'", job['if'])
                steps = job['steps']
                for step in steps:
                    self.assertNotIn('${{', step.get('run', ''))
                    if step.get('uses', '').startswith('actions/checkout@'):
                        self.assertEqual(step['with']['persist-credentials'], 'false')
                login = [i for i, step in enumerate(steps) if step.get('uses', '').startswith('azure/login@')]
                if job.get('permissions', {}).get('id-token') == 'write':
                    self.assertEqual(job['if'], "github.ref == 'refs/heads/main' && vars.STAGING_RUNNER_MODE == 'ephemeral-jit'")
                    self.assertEqual(job.get('environment'), 'staging')
                    self.assertEqual(job['runs-on'], 'tonyai-staging-eu')
                    self.assertEqual(len(login), 1)
                    self.assertEqual(steps[login[0]]['uses'], 'azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6')
                    checks = [i for i, step in enumerate(steps) if step.get('run') == 'python3 infra/scripts/release_checks.py']
                    self.assertEqual(len(checks), 1)
                    self.assertLess(checks[0], login[0])
                    if name == 'deploy-staging.yml':
                        binding = next(i for i, s in enumerate(steps) if s.get('run') == 'python3 infra/scripts/prepare_release.py')
                        self.assertLess(binding, login[0])
                        self.assertEqual(steps[binding]['env']['APPROVED_RELEASE_SHA256'], '${{ needs.validate.outputs.release_sha256 }}')
                else:
                    self.assertFalse(login)
                    self.assertNotIn('environment', job)
            self.assertTrue(any(j.get('permissions', {}).get('id-token') == 'write' for j in doc['jobs'].values()))

    def test_qa_deploy_reaches_oidc_only_from_main_and_waits_for_ci_before_changes(self):
        doc = workflow('deploy-qa.yml')
        self.assertEqual(set(doc['on']), {'push', 'workflow_dispatch'})
        self.assertEqual(doc['on']['push'], {'branches': ['main']})
        self.assertEqual(doc['permissions'], {'contents': 'read'})
        self.assertEqual(doc['concurrency'], {'group': 'qa-deploy', 'cancel-in-progress': 'false'})
        self.assertEqual(set(doc['jobs']), {'deploy'})
        job = doc['jobs']['deploy']
        condition = ' '.join(job['if'].split())
        for clause in ("github.repository == 'tonyaiukco/TonyAI-mono-repo'",
                       "github.ref == 'refs/heads/main'",
                       "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')"):
            self.assertIn(clause, condition)
        self.assertNotIn('||', condition.replace("(github.event_name == 'push' || github.event_name == 'workflow_dispatch')", ''))
        self.assertEqual(job.get('environment'), 'qa')
        self.assertEqual(job['runs-on'], 'ubuntu-latest')
        self.assertEqual(job['permissions'], {'contents': 'read', 'actions': 'read', 'id-token': 'write'})
        self.assertFalse(any('secrets.' in value for value in job['env'].values()))
        self.assertEqual(job['env']['SOURCE_SHA'], '${{ github.sha }}')
        steps = job['steps']
        checkout = steps[0]
        self.assertTrue(checkout['uses'].startswith('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'))
        self.assertEqual(checkout['with']['persist-credentials'], 'false')
        self.assertEqual(checkout['with']['ref'], '${{ github.sha }}')
        for step in steps:
            self.assertNotIn('${{', step.get('run', ''))
            self.assertNotIn('az extension', step.get('run', ''))
        index = {key: next(i for i, s in enumerate(steps) if predicate(s)) for key, predicate in {
            'head': lambda s: s.get('id') == 'head', 'plan': lambda s: s.get('id') == 'plan',
            'build': lambda s: 'build-images.sh' in s.get('run', ''), 'ci': lambda s: s.get('id') == 'ci',
            'migrate': lambda s: 'qa_autodeploy.py migrate' in s.get('run', ''),
            'rollout': lambda s: 'qa_autodeploy.py rollout' in s.get('run', '')}.items()}
        self.assertEqual(steps[index['head']]['run'], 'python3 infra/scripts/qa_autodeploy.py head --sha "$SOURCE_SHA"')
        self.assertEqual(steps[index['ci']]['run'], 'python3 infra/scripts/qa_autodeploy.py wait-ci --sha "$SOURCE_SHA"')
        self.assertEqual(steps[index['ci']]['env'], {'GH_TOKEN': '${{ github.token }}'})
        self.assertEqual(steps[index['build']]['env'], {'BUILD_CACHE': "${{ github.event_name == 'push' && 'registry' || '' }}"})
        self.assertEqual(list(index.values()), sorted(index.values()))
        login = [i for i, s in enumerate(steps) if s.get('uses', '').startswith('azure/login@')]
        self.assertEqual(len(login), 2)
        self.assertTrue(index['head'] < login[0] < index['plan'] and index['ci'] < login[1] < index['migrate'])
        for i in login:
            self.assertEqual(steps[i]['uses'], 'azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6')
        # Gates: head -> login/plan; plan -> buildx/build/CI wait; CI (re-checked head) -> everything that changes QA.
        expected = {i: "steps.head.outputs.current == 'true'" for i in (login[0], index['plan'])}
        expected.update({i: "steps.plan.outputs.deploy == 'true'" for i in range(index['plan'] + 1, index['ci'] + 1)})
        expected.update({i: "steps.ci.outputs.current == 'true'" for i in range(index['ci'] + 1, len(steps))})
        for i, condition in expected.items():
            self.assertEqual(steps[i].get('if'), condition, steps[i].get('name') or steps[i].get('uses'))
        # The owner secret version is visible only to the step that reads the secret.
        self.assertNotIn('DIRECT_URL_SECRET_VERSION', job['env'])
        holders = [s for s in steps if 'DIRECT_URL_SECRET_VERSION' in s.get('env', {})]
        self.assertEqual(len(holders), 1)
        self.assertIn('qa_autodeploy.py migrate', holders[0]['run'])

    def test_qa_rollback_is_owner_dispatched_from_main_and_checks_the_candidate_before_oidc(self):
        doc = workflow('rollback-qa.yml')
        self.assertEqual(set(doc['on']), {'workflow_dispatch'})
        inputs = doc['on']['workflow_dispatch']['inputs']
        self.assertEqual(set(inputs), {'candidate_run_id', 'mode'})
        self.assertEqual(inputs['mode']['type'], 'choice')
        self.assertEqual(inputs['mode']['options'], ['candidate', 'same-image'])
        self.assertEqual(doc['permissions'], {'contents': 'read'})
        # Same group as deploy-qa.yml: a rollback and a deploy never overlap.
        self.assertEqual(doc['concurrency'], {'group': 'qa-deploy', 'cancel-in-progress': 'false'})
        self.assertEqual(set(doc['jobs']), {'rollback'})
        job = doc['jobs']['rollback']
        condition = ' '.join(job['if'].split())
        self.assertEqual(condition, "github.repository == 'tonyaiukco/TonyAI-mono-repo' && "
                                    "github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch'")
        self.assertEqual(job.get('environment'), 'qa')
        self.assertEqual(job['permissions'], {'contents': 'read', 'actions': 'read', 'id-token': 'write'})
        self.assertFalse(any('secrets.' in value for value in job['env'].values()))
        self.assertNotIn('DIRECT_URL_SECRET_VERSION', json.dumps(doc))
        # Dispatch inputs reach the scripts only through env, where they are validated.
        self.assertEqual(job['env']['CANDIDATE_RUN_ID'], '${{ inputs.candidate_run_id }}')
        self.assertEqual(job['env']['MODE'], '${{ inputs.mode }}')
        steps = job['steps']
        checkout = steps[0]
        self.assertTrue(checkout['uses'].startswith('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'))
        self.assertEqual(checkout['with'], {'ref': '${{ github.sha }}', 'fetch-depth': '0', 'persist-credentials': 'false'})
        for step in steps:
            self.assertNotIn('${{', step.get('run', ''))
            self.assertFalse(step.get('uses', '').startswith('actions/download-artifact'))
        runs = [s.get('run', '') for s in steps]
        fetch = next(i for i, r in enumerate(runs) if 'qa_autodeploy.py fetch-candidate' in r)
        login = [i for i, s in enumerate(steps) if s.get('uses', '').startswith('azure/login@')]
        change = next(i for i, r in enumerate(runs) if 'qa_autodeploy.py rollback' in r)
        self.assertEqual(len(login), 1)
        self.assertTrue(fetch < login[0] < change)
        self.assertEqual(steps[login[0]]['uses'], 'azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6')
        self.assertEqual(steps[fetch]['env'], {'GH_TOKEN': '${{ github.token }}'})
        self.assertEqual(runs[change], 'python3 infra/scripts/qa_autodeploy.py rollback '
                                       '--candidate "$RUNNER_TEMP/target/candidate.json" --mode "$MODE"')
        # Only deploy-qa.yml migrates or builds; a rollback serves existing images.
        for forbidden in ('migrate', 'build-images.sh', 'rollout'):
            self.assertFalse(any(forbidden in r for r in runs), forbidden)

    def test_only_the_qa_deploy_workflow_may_use_the_qa_environment(self):
        users = set()
        for path in [*(ROOT / '.github/workflows').glob('*.yml'), *(ROOT / '.github/workflows').glob('*.yaml')]:
            for name, job in (workflow(path.name).get('jobs') or {}).items():
                environment = job.get('environment')
                self.assertNotIn('${{', json.dumps(environment), (path.name, name))
                if (environment.get('name') if isinstance(environment, dict) else environment) == 'qa':
                    users.add((path.name, name))
        self.assertEqual(users, {('deploy-qa.yml', 'deploy'), ('rollback-qa.yml', 'rollback')})

    def test_approval_waits_for_visible_manifest_and_hash(self):
        doc = workflow('deploy-staging.yml')
        validate, deploy = doc['jobs']['validate'], doc['jobs']['deploy']
        self.assertNotIn('id-token', validate['permissions'])
        self.assertNotIn('environment', validate)
        self.assertEqual(deploy.get('needs'), 'validate')
        self.assertIn('${{ needs.validate.outputs.release_sha256 }}', deploy['name'])
        self.assertEqual(validate['outputs']['release_sha256'], '${{ steps.manifest.outputs.release_sha256 }}')
        preview = next(s for s in validate['steps'] if s.get('id') == 'manifest')
        self.assertEqual(preview['run'], 'python3 infra/scripts/prepare_release.py --preview')

    def test_guard_changes_trigger_infra_and_integration_can_be_dispatched(self):
        doc = workflow('infra.yml')
        for event in ('push', 'pull_request'):
            self.assertIn('scripts/rls-probes.mjs', doc['on'][event]['paths'])
        self.assertIn('workflow_dispatch', workflow('integration.yml')['on'])

    def test_missing_or_wrong_runner_mode_fails_validate_instead_of_green_skip(self):
        steps = workflow('deploy-staging.yml')['jobs']['validate']['steps']
        guards = [step for step in steps if step.get('id') == 'runner-mode']
        self.assertEqual(len(guards), 1)
        guard = guards[0]
        self.assertEqual(guard.get('env'), {'STAGING_RUNNER_MODE': '${{ vars.STAGING_RUNNER_MODE }}'})
        self.assertEqual(steps[0], guard)
        for mode in (None, '', 'persistent', 'ephemeral-jit'):
            env = {key:value for key,value in os.environ.items() if key != 'STAGING_RUNNER_MODE'}
            if mode is not None: env['STAGING_RUNNER_MODE'] = mode
            result = subprocess.run(['bash', '-e', '-c', guard['run']], env=env, capture_output=True, text=True)
            with self.subTest(mode=mode):
                self.assertEqual(result.returncode == 0, mode == 'ephemeral-jit')
                if mode != 'ephemeral-jit': self.assertIn('::error::', result.stdout)

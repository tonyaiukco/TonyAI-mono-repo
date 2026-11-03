#!/usr/bin/env python3
"""Hosted QA auto-deploy: one main commit -> images, migrations, both Container Apps, smoke.

Runs only from .github/workflows/deploy-qa.yml (GitHub environment `qa`, OIDC login,
owner decision 2026-11-03). Terraform keeps owning every application setting; this path
changes only each app's image digest, revision suffix and release/source tags, and fails
(then rolls back to the previous images) when anything else differs afterwards or the
public smoke check fails. Credential values never reach logs, argv or files. Every
Azure read and write goes through `az rest` at one pinned ARM API version, so no
Container Apps CLI extension is needed and before/after snapshots are comparable.

Subcommands, in workflow order:
  head            before Azure login: is this commit still main's head?
  plan            decide whether this commit deploys (image-relevant change)
  wait-ci         after the images are built in parallel: CI must pass for this exact commit
  migrate         apply pending Prisma migrations, then the read-only owner privilege check
  rollout         drain API, update API then web, verify, smoke; roll back on failure
  check-github    owner preflight before federation: main ruleset + `qa` admits main only
"""
import argparse
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from candidate import bind  # noqa: E402
from cloud_ops import command, secret  # noqa: E402
from drain_api import drain, settle, revisions  # noqa: E402
from migration_binding import ENGINE_COMMIT, ENGINE_SHA256, copy_engine, prepare  # noqa: E402
from migration_runner import inspect_image, run  # noqa: E402
from pooler import SafeFailure, validate_pooler  # noqa: E402
from terraform_run import validate_release  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = 'tonyaiukco/TonyAI-mono-repo'
API_VERSION = '2025-01-01'
ENGINE_URL = ('https://binaries.prisma.sh/all_commits/' + ENGINE_COMMIT
              + '/debian-openssl-3.0.x/schema-engine.gz')
# A change confined to these paths cannot alter either image, so it does not redeploy QA.
NON_IMAGE_PREFIXES = ('docs/', 'infra/', 'e2e/', '.github/', '.claude/', '.codex/')
# ...except these, which .dockerignore admits and the API image copies.
IMAGE_INFRA_PREFIXES = ('infra/certs/',)
SMOKE = (('api', '/api/v1/health', 200), ('api', '/api/v1/health/ready', 200),
         ('api', '/api/v1/health/synthetic', 401), ('web', '/login', 200))
# Forward rollout must finish inside this budget so the step keeps time to roll back.
FORWARD_BUDGET_SECONDS = 35 * 60


def foundation_from_env(env=os.environ):
    foundation = {'subscription_id': env.get('AZURE_SUBSCRIPTION_ID', ''),
                  'tenant_id': env.get('AZURE_TENANT_ID', ''), 'environment': 'staging',
                  'resource_group': env.get('RESOURCE_GROUP', ''), 'prefix': env.get('PREFIX', ''),
                  'registry_name': env.get('ACR_NAME', ''), 'vault_name': env.get('VAULT_NAME', ''),
                  'default_domain': env.get('ACA_DEFAULT_DOMAIN', '')}
    # Same pattern + hosted-target policy as every reviewed release; placeholders only.
    probe = {'source_sha': 'a' * 40, 'release_id': 'probe', 'supabase_project_ref': 'a' * 20,
             'api_digest': 'sha256:' + 'a' * 64, 'web_digest': 'sha256:' + 'a' * 64,
             'database_secret_version': 'a' * 32, 'backend_secret_version': 'a' * 32,
             'storage_cleanup_hold': True, 'storage_sweep_interval_seconds': 300}
    validate_release({'foundation': foundation, 'release': probe})
    return foundation


def release_id(env=os.environ):
    number, attempt = env.get('GITHUB_RUN_NUMBER', ''), env.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'[1-9][0-9]{0,8}', number) or not re.fullmatch(r'[1-9][0-9]{0,2}', attempt):
        raise SafeFailure('GitHub run number and attempt are required for a unique revision.')
    return 'ci' + number + '-' + attempt


def stem(foundation):
    return foundation['prefix'] + '-' + foundation['environment']


# ---------------------------------------------------------------- ARM access

def run_az(argv, timeout=180):
    """`az` with a hard timeout, so a hung call cannot outlive the rollout budget."""
    try:
        result = subprocess.run(argv, capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise SafeFailure('Azure call timed out; outcome unknown.') from None
    if result.returncode:
        raise SafeFailure('Azure call failed; raw output withheld.')
    return result.stdout.strip()


class Arm:
    """drain_api's `read(...)` interface over `az rest` at one pinned API version.

    Only the Container Apps calls drain/settle/rollout make are mapped; anything
    else is refused rather than guessed.
    """

    def __init__(self, foundation, call=run_az):
        self.foundation, self.call = foundation, call
        self.group = ('/subscriptions/' + foundation['subscription_id'] + '/resourceGroups/'
                      + foundation['resource_group'] + '/providers/Microsoft.App/containerApps')

    def rest(self, method, path, body_file=None):
        argv = ['az', 'rest', '--method', method, '--only-show-errors',
                '--url', 'https://management.azure.com' + path + '?api-version=' + API_VERSION]
        if body_file:
            argv += ['--headers', 'Content-Type=application/json', '--body', '@' + body_file]
        if method != 'get':
            self.call(argv + ['--output', 'none'])
            return None
        return json.loads(self.call(argv + ['--output', 'json']))

    def listing(self, path):
        page = self.rest('get', path)
        rows = page.get('value') if isinstance(page, dict) else None
        if not isinstance(rows, list) or page.get('nextLink'):
            raise SafeFailure('Incomplete Container Apps listing; refused.')
        return rows

    def app_path(self, args):
        name = args[args.index('-n') + 1]
        if (args[args.index('--subscription') + 1] != self.foundation['subscription_id']
                or args[args.index('-g') + 1] != self.foundation['resource_group']
                or name not in (stem(self.foundation) + '-api', stem(self.foundation) + '-web')):
            raise SafeFailure('Container Apps call outside the QA target refused.')
        return self.group + '/' + name

    def __call__(self, *args):
        if args[:2] == ('containerapp', 'show'):
            return self.rest('get', self.app_path(args))
        if args[:3] == ('containerapp', 'revision', 'list'):
            return self.listing(self.app_path(args) + '/revisions')
        if args[:3] == ('containerapp', 'revision', 'deactivate'):
            return self.rest('post', self.app_path(args) + '/revisions/' + args[args.index('--revision') + 1] + '/deactivate')
        if args[:3] == ('containerapp', 'replica', 'list'):
            return self.listing(self.app_path(args) + '/revisions/' + args[args.index('--revision') + 1] + '/replicas')
        if args[:2] == ('containerapp', 'list'):
            return [row.get('name') for row in self.listing(self.group)]
        raise SafeFailure('Unsupported Container Apps call refused.')

    def owns(self, app):
        # ARM may echo resource-group casing differently; the path itself must match.
        names = (stem(self.foundation) + '-api', stem(self.foundation) + '-web')
        return (app.get('name') in names
                and str(app.get('id', '')).lower() == (self.group + '/' + app['name']).lower())

    def patch(self, app, body):
        if not self.owns(app):
            raise SafeFailure('PATCH target outside the QA resource group refused.')
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle:
            json.dump(body, handle)
        try:
            # JSON merge patch: only the template and tags are sent; secrets/ingress are untouched.
            self.rest('patch', app['id'], handle.name)
        finally:
            os.unlink(handle.name)


def show(foundation, kind, read):
    app = read('containerapp', 'show', '--subscription', foundation['subscription_id'],
               '-g', foundation['resource_group'], '-n', stem(foundation) + '-' + kind)
    if (not isinstance(app, dict) or app.get('name') != stem(foundation) + '-' + kind
            or not isinstance(app.get('properties'), dict)
            or len(app['properties'].get('template', {}).get('containers') or []) != 1):
        raise SafeFailure('Cannot read the live ' + kind + ' app with exactly one container.')
    return app


# ---------------------------------------------------------------- head + plan

def git(*args, root=ROOT):
    result = subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, check=False)
    return result.returncode, result.stdout.strip()


def main_head(run_git=git):
    # Anonymous read: works because the repository is public (see runbook 11).
    code, out = run_git('ls-remote', 'origin', 'refs/heads/main')
    if code or not re.fullmatch(r'[a-f0-9]{40}\trefs/heads/main', out):
        raise SafeFailure('Cannot read the current main head.')
    return out.split('\t')[0]


def image_relevant(paths):
    return [p for p in paths if p.startswith(IMAGE_INFRA_PREFIXES)
            or (not p.startswith(NON_IMAGE_PREFIXES) and not ('/' not in p and p.endswith('.md')))]


def decide(sha, head, deployed, changed, force=False):
    """Return (deploy, reason). `changed` is None when the deployed source is unknown."""
    if sha != head:
        return False, 'main has moved on; the newer commit deploys instead.'
    if force:
        return True, 'manual dispatch.'
    if deployed == sha:
        return False, 'this commit is already deployed.'
    if changed is None:
        return True, 'deployed source unknown or not an ancestor; deploying.'
    relevant = image_relevant(changed)
    if not relevant:
        return False, 'no image-relevant change since the deployed source.'
    return True, str(len(relevant)) + ' image-relevant file(s) changed since the deployed source.'


def plan(sha, force, read, run_git=git, env=os.environ):
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise SafeFailure('A full source SHA is required.')
    foundation = foundation_from_env(env)
    head = main_head(run_git)
    sources = {(show(foundation, kind, read).get('tags') or {}).get('source') for kind in ('api', 'web')}
    deployed = sources.pop() if len(sources) == 1 else None
    changed = None
    if isinstance(deployed, str) and re.fullmatch(r'[a-f0-9]{40}', deployed):
        if run_git('merge-base', '--is-ancestor', deployed, sha)[0] == 0:
            # --no-renames: a file moved out of an app must count on its old path too.
            code, out = run_git('diff', '--name-only', '--no-renames', deployed, sha)
            if code == 0:
                changed = [line for line in out.splitlines() if line]
    return decide(sha, head, deployed, changed, force)


# ---------------------------------------------------------------- release binding

def live_release(foundation, api, candidate, sha, rid, project):
    """Release fields for candidate/migration binding, read from the live API app."""
    secrets = {item.get('name'): item.get('keyVaultUrl', '')
               for item in api['properties'].get('configuration', {}).get('secrets') or []}
    versions = {}
    for name, field in (('database-url', 'database_secret_version'),
                        ('supabase-service-role-key', 'backend_secret_version')):
        prefix = 'https://' + foundation['vault_name'] + '.vault.azure.net/secrets/' + name + '/'
        url = secrets.get(name, '')
        if not url.startswith(prefix) or not re.fullmatch(r'[a-f0-9]{32}', url[len(prefix):]):
            raise SafeFailure('Live API secret references differ from the vault contract.')
        versions[field] = url[len(prefix):]
    env = {item.get('name'): item.get('value') for item in api['properties']['template']['containers'][0].get('env', [])}
    hold, interval = env.get('STORAGE_CLEANUP_HOLD'), env.get('STORAGE_SWEEP_INTERVAL_SECONDS')
    if hold not in ('0', '1') or not re.fullmatch(r'[1-9][0-9]{0,4}', interval or ''):
        raise SafeFailure('Live storage settings are missing or malformed.')
    release = {'source_sha': sha, 'release_id': rid, 'supabase_project_ref': project,
               'api_digest': candidate.get('api_digest'), 'web_digest': candidate.get('web_digest'),
               **versions, 'storage_cleanup_hold': hold == '1',
               'storage_sweep_interval_seconds': int(interval)}
    inputs = {'foundation': foundation, 'release': release}
    validate_release(inputs)
    # Candidate must be this exact commit, its migrations/lockfile and the QA origins.
    bind(candidate, inputs, sha)
    return inputs


# ---------------------------------------------------------------- migrate

def fetch_engine(destination, opener=urlopen):
    with opener(ENGINE_URL, timeout=120) as response:
        data = gzip.decompress(response.read())
    if hashlib.sha256(data).hexdigest() != ENGINE_SHA256:
        raise SafeFailure('Downloaded schema-engine checksum differs from the reviewed Prisma build.')
    Path(destination).write_bytes(data)
    return destination


def migrate(inputs, candidate, direct_version, work, read_secret=secret, runner=run,
            inspect=inspect_image, pull=None, engine_source=fetch_engine):
    """hosted_migrate.py's transport without the owner's local journal (QA CI identity).

    After `migrate`, the same owner URL runs runbook 03's read-only `owner-check`:
    any privilege problem, PUBLIC exposure or factor-library notice stops the deploy
    before rollout. Platform-default findings are reported for owner review only.
    """
    if not re.fullmatch(r'[a-f0-9]{32}', direct_version or ''):
        raise SafeFailure('An exact direct-url secret version is required.')
    if any(os.environ.get(k) for k in ('DATABASE_URL', 'DIRECT_URL', 'NODE_OPTIONS', 'DEBUG')):
        raise SafeFailure('Ambient database credentials or debug overrides are refused.')
    work = Path(work)
    bundle, engine = work / 'bundle', work / 'engine'
    bundle.mkdir(mode=0o755)
    engine.mkdir(mode=0o755)
    image = prepare(ROOT, inputs, candidate, bundle)
    copy_engine(engine_source(work / 'schema-engine.download'), engine)
    for path in bundle.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o444)
    (pull or (lambda ref: command(['docker', 'pull', '--platform', 'linux/amd64', ref])))(image)
    docker_env = inspect(image)
    project = inputs['release']['supabase_project_ref']
    direct = read_secret(inputs['foundation']['vault_name'], 'direct-url', direct_version)
    validate_pooler(direct, project, 5432)
    parsed = urlparse(direct)
    query = parse_qs(parsed.query, keep_blank_values=True)
    query['sslcert'] = ['/migration/ca.crt']
    adjusted = parsed._replace(query=urlencode(query, doseq=True)).geturl()
    applied = runner(image, bundle, engine, adjusted, 'migrate', env=docker_env)
    checked = runner(image, bundle, engine, adjusted, 'owner-check', env=docker_env)
    return applied, checked


# ---------------------------------------------------------------- rollout

def patch_body(app, image, rid, sha):
    template = copy.deepcopy(app['properties']['template'])
    template['containers'][0]['image'] = image
    template['revisionSuffix'] = rid
    tags = dict(app.get('tags') or {})
    tags.update(release=rid, source=sha)
    return {'tags': tags, 'properties': {'template': template}}


def wait_ready(foundation, kind, rid, read, sleep=time.sleep, attempts=100):
    expected = stem(foundation) + '-' + kind + '--' + rid
    for _ in range(attempts):
        app = show(foundation, kind, read)
        properties = app['properties']
        if properties.get('provisioningState') == 'Failed':
            raise SafeFailure('The ' + kind + ' app update failed to provision.')
        if properties.get('provisioningState') == 'Succeeded' and properties.get('latestReadyRevisionName') == expected:
            return app
        sleep(5)
    raise SafeFailure('The ' + kind + ' revision did not become ready in time.')


def comparable(app):
    properties = copy.deepcopy(app['properties'])
    template = properties.get('template', {})
    template['containers'][0].pop('image', None)
    template.pop('revisionSuffix', None)
    return {'identity': app.get('identity'), 'template': template,
            'configuration': properties.get('configuration')}


def verify(foundation, kind, before, after, image, rid, read):
    if after['properties']['template']['containers'][0].get('image') != image:
        raise SafeFailure('Deployed ' + kind + ' image differs from the built digest.')
    if after['properties'].get('latestReadyRevisionName') != stem(foundation) + '-' + kind + '--' + rid:
        raise SafeFailure('The ' + kind + ' app is not serving the new revision.')
    if comparable(before) != comparable(after):
        raise SafeFailure('The ' + kind + ' app changed beyond its image; Terraform owns configuration.')
    if kind == 'api':
        rows, _ = revisions(foundation, read)
        if [r['name'] for r in rows if r['properties']['active']] != [stem(foundation) + '-api--' + rid]:
            raise SafeFailure('Unexpected active API revisions after rollout.')


def fetch_status(url, opener=urlopen):
    try:
        with opener(Request(url, headers={'User-Agent': 'tonyai-qa-deploy'}), timeout=10) as response:
            return response.status
    except HTTPError as error:
        return error.code
    except (URLError, OSError):
        return None


def smoke(foundation, fetch=fetch_status, sleep=time.sleep, attempts=12):
    origins = {kind: 'https://' + stem(foundation) + '-' + kind + '.' + foundation['default_domain']
               for kind in ('api', 'web')}
    for kind, path, expected in SMOKE:
        for attempt in range(attempts):
            status = fetch(origins[kind] + path)
            if status == expected:
                break
            if attempt == attempts - 1:
                raise SafeFailure('Smoke failed: ' + kind + ' ' + path + ' returned ' + str(status)
                                  + ', expected ' + str(expected) + '.')
            sleep(5)


def grace_attempts(api):
    grace = api['properties']['template'].get('terminationGracePeriodSeconds')
    if type(grace) is not int or not 1 <= grace <= 3600:
        raise SafeFailure('Live API termination grace is missing or out of range.')
    return (grace * 1000 + 30000 + 1999) // 2000


def update(foundation, kind, app, image, rid, sha, read, patch, sleep, attempts):
    if kind == 'api':
        # Process-local quotas require one API process: stop the old one first (QA accepts the gap).
        drain(foundation, rid, read=read, sleep=sleep, attempts=attempts)
    patch(app, patch_body(app, image, rid, sha))
    after = wait_ready(foundation, kind, rid, read, sleep)
    if kind == 'api':
        settle(foundation, rid, read=read, sleep=sleep, attempts=attempts)
    return after


def budgeted(sleep, clock, deadline):
    def wait(seconds):
        if clock() > deadline:
            raise SafeFailure('Rollout exceeded its time budget.')
        sleep(seconds)
    return wait


def rollout(foundation, candidate, sha, rid, read, patch, owns, sleep=time.sleep,
            fetch=fetch_status, log=print, clock=time.monotonic, budget=FORWARD_BUDGET_SECONDS,
            shield=lambda: None):
    registry = foundation['registry_name'] + '.azurecr.io/tonyai/'
    before = {kind: show(foundation, kind, read) for kind in ('api', 'web')}
    # Refuse an unpatchable target before the API is drained, never after.
    if not all(owns(before[kind]) for kind in ('api', 'web')):
        raise SafeFailure('Live app identifiers differ from the QA target; nothing was changed.')
    attempts = grace_attempts(before['api'])
    images = {kind: registry + kind + '@' + candidate[kind + '_digest'] for kind in ('api', 'web')}
    forward = budgeted(sleep, clock, clock() + budget)
    touched = []
    try:
        for kind in ('api', 'web'):
            touched.append(kind)
            after = update(foundation, kind, before[kind], images[kind], rid, sha, read, patch, forward, attempts)
            verify(foundation, kind, before[kind], after, images[kind], rid, read)
            log('PASS: ' + kind + ' serves ' + images[kind].rsplit('@', 1)[1])
        smoke(foundation, fetch, forward)
        log('PASS: smoke (health, readiness, guarded route, login page).')
    except BaseException as error:  # including a job cancel's KeyboardInterrupt
        shield()  # a second cancel signal must not interrupt the rollback itself
        reason = str(error) if isinstance(error, SafeFailure) else 'rollout failed; details withheld.'
        log('FAIL: ' + reason + ' Rolling back to the previous images.')
        incomplete = []
        # Reverse order: web never depends on the API rollback succeeding.
        for kind in reversed(touched):
            try:
                previous = before[kind]['properties']['template']['containers'][0]['image']
                source = (before[kind].get('tags') or {}).get('source', '')
                update(foundation, kind, before[kind], previous, rid + '-rb', source, read, patch, sleep, attempts)
                log('ROLLED BACK: ' + kind)
            except BaseException:  # a late signal must not hide which app is left
                incomplete.append(kind)
        if incomplete:
            raise SafeFailure('Deploy failed (' + reason + ') and ROLLBACK INCOMPLETE for '
                              + ', '.join(incomplete) + '; re-run QA deploy from main or recover manually.') from None
        try:
            smoke(foundation, fetch, sleep, attempts=6)
            log('PASS: smoke after rollback.')
        except SafeFailure:
            raise SafeFailure('Deploy failed (' + reason + '); rollback applied but smoke is still failing, '
                              'so check shared dependencies such as Supabase.') from None
        raise SafeFailure('Deploy failed and was rolled back: ' + reason) from None


# ---------------------------------------------------------------- CI gate

def ci_state(sha, read):
    """'success' | 'failed' | 'pending' for CI's latest push run of `sha` on main."""
    data = read('repos/' + REPOSITORY + '/actions/workflows/ci.yml/runs?head_sha=' + sha
                + '&event=push&branch=main&per_page=20')
    runs = [run for run in data.get('workflow_runs') or []
            if run.get('head_sha') == sha and run.get('event') == 'push' and run.get('head_branch') == 'main'
            and str(run.get('path', '')).split('@')[0] == '.github/workflows/ci.yml'
            and (run.get('head_repository') or {}).get('full_name') == REPOSITORY]
    if not runs:
        return 'pending'
    latest = max(runs, key=lambda run: (run.get('run_number', 0), run.get('run_attempt', 0)))
    if latest.get('status') != 'completed':
        return 'pending'
    return 'success' if latest.get('conclusion') == 'success' else 'failed'


def wait_ci(sha, read, sleep=time.sleep, attempts=270):
    """Nothing reaches the database or the apps until CI is green for this exact commit."""
    for _ in range(attempts):
        state = ci_state(sha, read)
        if state == 'success':
            return
        if state == 'failed':
            raise SafeFailure('CI failed for this commit; QA is not deployed.')
        sleep(10)
    raise SafeFailure('CI did not finish in time; QA is not deployed.')


# ---------------------------------------------------------------- owner preflight

def gh_api(path):
    return json.loads(command(['gh', 'api', '-H', 'X-GitHub-Api-Version: 2022-11-28', path]))


# CI is the only gate between main and QA, so main must only change through a PR with these jobs green.
REQUIRED_CI_JOBS = {'build', 'docker-build', 'rls-probe', 'migration-diff'}


def verify_main_ruleset(repo=REPOSITORY, read=gh_api):
    base = 'repos/' + repo
    for summary in read(base + '/rulesets?per_page=100'):
        if summary.get('target') != 'branch' or summary.get('enforcement') != 'active':
            continue
        ruleset = read(base + '/rulesets/' + str(summary['id']))
        include = set(ruleset.get('conditions', {}).get('ref_name', {}).get('include', []))
        if ruleset.get('enforcement') != 'active' or ruleset.get('bypass_actors') != [] \
                or not include & {'refs/heads/main', '~DEFAULT_BRANCH'}:
            continue
        rules = {rule.get('type'): rule.get('parameters') or {} for rule in ruleset.get('rules', [])}
        contexts = {check.get('context') for check in rules.get('required_status_checks', {}).get('required_status_checks', [])
                    if check.get('integration_id') == 15368}  # GitHub Actions
        if {'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'} <= rules.keys() \
                and REQUIRED_CI_JOBS <= contexts:
            return
    raise SafeFailure('Main needs an active ruleset with no bypass actors that requires a pull request, '
                      'the CI jobs ' + ', '.join(sorted(REQUIRED_CI_JOBS)) + ', and forbids deletion and force pushes.')


def verify_qa_environment(repo=REPOSITORY, read=gh_api):
    """Before the federated credential exists: `qa` must admit deployments from main only."""
    verify_main_ruleset(repo, read)
    environment = read('repos/' + repo + '/environments/qa')
    if environment.get('deployment_branch_policy') != {'protected_branches': False, 'custom_branch_policies': True}:
        raise SafeFailure('Environment qa must use a custom deployment-branch policy.')
    policies = read('repos/' + repo + '/environments/qa/deployment-branch-policies')
    rows = [(p.get('name'), p.get('type', 'branch')) for p in policies.get('branch_policies', [])]
    if policies.get('total_count') != 1 or rows != [('main', 'branch')]:
        raise SafeFailure('Environment qa must admit exactly the main branch.')


# ---------------------------------------------------------------- CLI

def write_output(name, value, env=os.environ):
    path = env.get('GITHUB_OUTPUT')
    if path:
        with open(path, 'a') as handle:
            handle.write(name + '=' + value + '\n')


def interrupted(signum, frame):
    raise KeyboardInterrupt()


def main(argv=None, env=os.environ):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('operation', choices=['head', 'plan', 'wait-ci', 'migrate', 'rollout', 'check-github'])
    parser.add_argument('--sha')
    parser.add_argument('--candidate')
    parser.add_argument('--force', action='store_true')
    args = parser.parse_args(argv)
    if args.operation == 'check-github':
        verify_qa_environment()
        print('PASS: main is ruleset-protected and environment qa admits deployments from main only.')
        return
    if not re.fullmatch(r'[a-f0-9]{40}', args.sha or ''):
        raise SafeFailure('A full source SHA is required.')
    if args.operation == 'head':
        current = main_head() == args.sha
        write_output('current', 'true' if current else 'false', env)
        print('CURRENT: deploying candidate.' if current else 'SKIP: main has moved on; the newer commit deploys instead.')
        return
    if args.operation == 'wait-ci':
        wait_ci(args.sha, gh_api)
        # Re-check: a newer merge may have landed while this one waited; it deploys instead.
        current = main_head() == args.sha
        write_output('current', 'true' if current else 'false', env)
        print('PASS: CI succeeded for this commit.' if current else 'SKIP: CI passed, but main has moved on.')
        return
    foundation = foundation_from_env(env)
    arm = Arm(foundation)
    if args.operation == 'plan':
        deploy, reason = plan(args.sha, args.force, arm, env=env)
        write_output('deploy', 'true' if deploy else 'false', env)
        print(('DEPLOY: ' if deploy else 'SKIP: ') + reason)
        return
    candidate = json.loads(Path(args.candidate).read_text())
    rid = release_id(env)
    inputs = live_release(foundation, show(foundation, 'api', arm), candidate, args.sha, rid,
                          env.get('SUPABASE_PROJECT_REF', ''))
    if args.operation == 'migrate':
        with tempfile.TemporaryDirectory(prefix='tonyai-qa-migration-') as work:
            applied, checked = migrate(inputs, candidate, env.get('DIRECT_URL_SECRET_VERSION', ''), work)
        print('PASS: ' + applied['status'] + ', applied ' + str(applied['applied_count']) + ' migration(s).')
        print('PASS: owner privilege check; platform-default findings for owner review: '
              + str(checked['platform_default_findings']) + '.')
        return
    signal.signal(signal.SIGTERM, interrupted)
    def shield():
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    rollout(foundation, candidate, args.sha, rid, arm, arm.patch, arm.owns, shield=shield)
    print('PASS: QA serves ' + args.sha + ' as revision suffix ' + rid + '.')


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except BaseException:
        sys.exit('FAIL: QA deploy step failed; details withheld.')

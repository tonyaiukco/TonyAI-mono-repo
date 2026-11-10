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

On demand (owner):
  inputs          read-only: write the live release binding (--candidate of the live release,
                  --out new 0600 file) for the hosted smoke/storage/backup probes
  fetch-candidate download the candidate a successful QA deploy run on main published
                  (--run-id, --out directory) and check it belongs to that run
  rollback        from .github/workflows/rollback-qa.yml only: move QA to an earlier main
                  candidate (--mode candidate) or redeploy the live one (--mode same-image)
                  through `rollout`; refused when it would cross a migration
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
import zlib
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from candidate import bind  # noqa: E402
from cloud_ops import command, secret  # noqa: E402
from drain_api import drain, settle, revisions  # noqa: E402
from migration_binding import ENGINE_COMMIT, ENGINE_SHA256, copy_engine, prepare  # noqa: E402
from migration_runner import inspect_image, run  # noqa: E402
from public_hosts import hosts_from_env, public_origins  # noqa: E402
from pooler import SafeFailure, validate_pooler  # noqa: E402
from terraform_run import validate_release  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = 'tonyaiukco/TonyAI-mono-repo'
API_VERSION = '2025-01-01'
# An ARM listing longer than this is refused rather than read in part. Azure
# pages Container Apps revisions at 20, and keeps at most 100 inactive ones.
MAX_LISTING_PAGES = 20
# The query keys an ARM nextLink of a Container Apps listing may carry, lowercased.
NEXT_LINK_KEYS = {'api-version', 'skiptoken', '$skiptoken', 'pagesize'}
ENGINE_URL = ('https://binaries.prisma.sh/all_commits/' + ENGINE_COMMIT
              + '/debian-openssl-3.0.x/schema-engine.gz')
# binaries.prisma.sh refuses urllib's default User-Agent (Cloudflare 403, error 1010).
USER_AGENT = 'tonyai-qa-deploy'
# A change confined to these paths cannot alter either image, so it does not redeploy QA.
# `e2e/` and `openspec/` reach the builder stage's context but never a final image, which
# copies only build outputs (apps/*/Dockerfile).
NON_IMAGE_PREFIXES = ('docs/', 'infra/', 'e2e/', 'openspec/', '.github/', '.claude/', '.codex/')
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
    hosts = hosts_from_env(env)
    if hosts:
        foundation['public_hosts'] = hosts
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


def next_page(path, link):
    """`link` if it is the next page of the ARM listing at `path`, else a refusal.

    Never an arbitrary origin, path, filter or API version (the rule
    qa_discovery.next_command applies): https on management.azure.com, the
    listing's own path (ARM may change its casing), this script's pinned
    api-version, a skip token, and at most a numeric page size.
    """
    if not isinstance(link, str):
        raise SafeFailure('Unexpected Container Apps nextLink; refused.')
    url = urlparse(link)
    try:
        query = parse_qs(url.query, strict_parsing=True, keep_blank_values=True)
    except ValueError:
        query = None
    keys = {key.lower() for key in query} if query else set()
    if (url.scheme != 'https' or url.netloc != 'management.azure.com'
            or url.path.lower() != path.lower() or url.params or url.fragment
            or query is None or len(keys) != len(query) or not keys <= NEXT_LINK_KEYS
            or any(len(values) != 1 or not values[0] for values in query.values())
            or query.get('api-version') != [API_VERSION]
            or not keys & {'skiptoken', '$skiptoken'}
            or any(key.lower() == 'pagesize' and not values[0].isdigit() for key, values in query.items())):
        raise SafeFailure('Unexpected Container Apps nextLink; refused.')
    return link


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
        return self.request(method, 'https://management.azure.com' + path + '?api-version=' + API_VERSION, body_file)

    def request(self, method, url, body_file=None):
        argv = ['az', 'rest', '--method', method, '--only-show-errors', '--url', url]
        if body_file:
            argv += ['--headers', 'Content-Type=application/json', '--body', '@' + body_file]
        if method != 'get':
            self.call(argv + ['--output', 'none'])
            return None
        return json.loads(self.call(argv + ['--output', 'json']))

    def listing(self, path):
        """Every row of an ARM listing, following its pages — or a refusal.

        A listing read in part is still refused: each page must be well formed,
        each nextLink must be this listing's own next page (`next_page`), and a
        repeated link or more than MAX_LISTING_PAGES pages stops the read. Until
        2026-11-10 any nextLink was refused, which failed every deploy once the
        API app passed 20 revisions (QA deploy run 42889302849).
        """
        rows, seen, page = [], set(), self.rest('get', path)
        for read in range(1, MAX_LISTING_PAGES + 1):
            if not isinstance(page, dict) or not isinstance(page.get('value'), list):
                raise SafeFailure('Incomplete Container Apps listing; refused.')
            rows.extend(page['value'])
            link = page.get('nextLink')
            if not link:
                return rows
            if link in seen:
                raise SafeFailure('Container Apps listing repeats a page; refused.')
            if read == MAX_LISTING_PAGES:
                break
            seen.add(link)
            page = self.request('get', next_page(path, link))
        raise SafeFailure('Container Apps listing longer than ' + str(MAX_LISTING_PAGES) + ' pages; refused.')

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
    inputs = {'foundation': foundation, 'release': live_release_fields(foundation, api, candidate, sha, rid, project)}
    validate_release(inputs)
    # Candidate must be this exact commit, its migrations/lockfile and the QA origins.
    bind(candidate, inputs, sha)
    return inputs


def live_release_fields(foundation, api, candidate, sha, rid, project):
    """The release's required fields: live secret versions and storage settings, candidate digests."""
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
    return release


# ---------------------------------------------------------------- provenance from git objects
# `candidate.bind` recomputes a candidate from a clean checkout of its source. The inputs
# export and the rollback run from a checkout of later code, so they recompute the same
# fields from the source commit's git objects instead (fetch-depth 0 in the workflow).

MIGRATION_SQL = re.compile(r'packages/db/prisma/migrations/[^/]+/migration\.sql')


def git_bytes(*args):
    try:
        return subprocess.check_output(['git', *args], cwd=ROOT, stderr=subprocess.DEVNULL, timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        raise SafeFailure('Cannot read the source commit from git; fetch full history first.') from None


def fingerprint_at(sha, read_git=git_bytes):
    """candidate.fingerprint() for commit `sha`, read from git objects, not the working tree."""
    # -z: NUL-separated, unquoted paths, so a non-ASCII directory name reads as git stores it.
    listed = read_git('ls-tree', '-r', '-z', '--name-only', sha, '--', 'packages/db/prisma/migrations')
    paths = sorted(p for p in listed.decode().split('\0') if MIGRATION_SQL.fullmatch(p))
    if not paths:
        raise SafeFailure('No committed migration chain at the source commit.')
    def digest(path):
        return hashlib.sha256(read_git('show', sha + ':' + path)).hexdigest()
    return {'lockfile_sha256': digest('pnpm-lock.yaml'),
            'migrations': [{'name': p.split('/')[-2], 'sha256': digest(p)} for p in paths]}


def bind_at(candidate, inputs, sha, read_git=git_bytes):
    """candidate.bind() without a checkout: the same expected candidate, from git objects."""
    foundation, release = validate_release(inputs)
    if foundation['environment'] != 'staging' or release['source_sha'] != sha:
        raise SafeFailure('Only the selected staging source can be bound.')
    origins = {kind + '_origin': origin for kind, origin in public_origins(foundation).items()}
    expected = {'schema': 1, 'environment': 'staging', 'source_sha': sha,
                'api_digest': release['api_digest'], 'web_digest': release['web_digest'],
                'registry': foundation['registry_name'] + '.azurecr.io',
                'supabase_project_ref': release['supabase_project_ref'], **origins, **fingerprint_at(sha, read_git)}
    if candidate != expected:
        raise SafeFailure('Candidate provenance differs from source, migrations, lockfile or release target.')
    return expected


# ---------------------------------------------------------------- live inputs export

def live_identity(foundation, apps, same_revision=True):
    """The one source SHA (and revision suffix) both live apps serve, or a refusal.

    A deploy that failed at the API restores only the API, under `<rid>-rb`, so the apps can
    serve one source under different suffixes. A rollback needs only the source; the
    inputs export needs both, because the probes verify one exact release.
    """
    sources = {(apps[kind].get('tags') or {}).get('source') for kind in ('api', 'web')}
    suffixes = {apps[kind]['properties'].get('template', {}).get('revisionSuffix') for kind in ('api', 'web')}
    if len(sources) != 1 or (same_revision and len(suffixes) != 1):
        raise SafeFailure('Live API and web serve different sources or revisions; refused.')
    sha, rid = sources.pop(), sorted(suffixes, key=str)[0]
    if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise SafeFailure('Live source tag is missing or malformed; refused.')
    if not isinstance(rid, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,29}', rid):
        raise SafeFailure('Live revision suffix is missing or malformed; refused.')
    return sha, rid


def live_images(foundation, apps):
    return {kind: apps[kind]['properties']['template']['containers'][0].get('image') for kind in ('api', 'web')}


def candidate_images(foundation, candidate):
    registry = foundation['registry_name'] + '.azurecr.io/tonyai/'
    return {kind: registry + kind + '@' + str(candidate.get(kind + '_digest')) for kind in ('api', 'web')}


def live_env(api):
    return {item.get('name'): item for item in api['properties']['template']['containers'][0].get('env') or []}


def live_mail(foundation, api):
    """The release `mail` block from live API settings, or None when the API sends no mail."""
    from mail_settings import MAIL_ENV
    env = live_env(api)
    present = MAIL_ENV & set(env)
    if not present:
        return None
    if present != MAIL_ENV:
        raise SafeFailure('Live mail settings are incomplete; refused.')
    secrets = {item.get('name'): item.get('keyVaultUrl', '')
               for item in api['properties'].get('configuration', {}).get('secrets') or []}
    prefix = 'https://' + foundation['vault_name'] + '.vault.azure.net/secrets/smtp-password/'
    url = secrets.get('smtp-password', '')
    if not url.startswith(prefix) or not re.fullmatch(r'[a-f0-9]{32}', url[len(prefix):]):
        raise SafeFailure('Live SMTP password reference differs from the vault contract.')
    port, secure = env['SMTP_PORT'].get('value'), env['SMTP_SECURE'].get('value')
    if not re.fullmatch(r'[0-9]{1,5}', port or '') or secure not in ('true', 'false'):
        raise SafeFailure('Live SMTP port or security setting is malformed.')
    return {'host': env['SMTP_HOST'].get('value'), 'port': int(port), 'secure': secure == 'true',
            'user': env['SMTP_USER'].get('value'), 'from': env['MAIL_FROM'].get('value'),
            'password_secret_version': url[len(prefix):]}


def live_runtime_limits(api):
    """Overrides of the reviewed defaults, read from live API settings."""
    from runtime_limits import DEFAULTS, validate_limits
    env = live_env(api)
    overrides = {}
    for key, default in DEFAULTS.items():
        value = env.get(key, {}).get('value')
        if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', value):
            raise SafeFailure('Live runtime limits are missing or malformed.')
        if int(value) != default:
            overrides[key] = int(value)
    validate_limits(overrides)
    return overrides


def write_private(path, data):
    """Owner-only file; never overwrites, so a stale binding cannot be mistaken for a new one."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise SafeFailure('The output file already exists; choose a new path.') from None
    with os.fdopen(fd, 'w') as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write('\n')


def export_inputs(foundation, candidate, project, out, read, verifier=None, read_git=git_bytes):
    """Write the complete live release binding that the hosted probes consume unchanged."""
    apps = {kind: show(foundation, kind, read) for kind in ('api', 'web')}
    sha, rid = live_identity(foundation, apps)
    if live_images(foundation, apps) != candidate_images(foundation, candidate):
        raise SafeFailure('Live images differ from the candidate; download the live release candidate.')
    release = live_release_fields(foundation, apps['api'], candidate, sha, rid, project)
    mail = live_mail(foundation, apps['api'])
    if mail is not None:
        release['mail'] = mail
    release['runtime_limits'] = live_runtime_limits(apps['api'])
    inputs = {'foundation': foundation, 'release': release}
    bind_at(candidate, inputs, sha, read_git)
    if verifier is None:
        from deploy_apps import verify as verifier
    verifier(inputs, read=read)
    write_private(out, inputs)
    return inputs


# ---------------------------------------------------------------- on-demand rollback

def download_artifact(run_id, name, directory):
    command(['gh', 'run', 'download', run_id, '-R', REPOSITORY, '-n', name, '-D', directory])


def fetch_candidate(run_id, directory, read=None, download=download_artifact):
    """The candidate a successful QA deploy from main published, checked against that run."""
    read = read or gh_api
    if not isinstance(run_id, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', run_id):
        raise SafeFailure('A numeric QA deploy run ID is required.')
    run = read('repos/' + REPOSITORY + '/actions/runs/' + run_id)
    sha = run.get('head_sha') if isinstance(run, dict) else None
    if (not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{40}', sha)
            or str(run.get('path', '')).split('@')[0] != '.github/workflows/deploy-qa.yml'
            or run.get('head_branch') != 'main' or run.get('event') not in ('push', 'workflow_dispatch')
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or (run.get('repository') or {}).get('full_name') != REPOSITORY
            or (run.get('head_repository') or {}).get('full_name') != REPOSITORY
            or type(run.get('run_number')) is not int or type(run.get('run_attempt')) is not int):
        raise SafeFailure('Run ' + run_id + ' is not a successful QA deploy from main; refused.')
    # A deploy that skipped published nothing, so the download itself fails here.
    download(run_id, 'qa-candidate-' + str(run['run_number']) + '-' + str(run['run_attempt']), directory)
    path = Path(directory) / 'candidate.json'
    try:
        candidate = json.loads(path.read_text())
    except (OSError, ValueError):
        raise SafeFailure('The run published no readable candidate.') from None
    if not isinstance(candidate, dict) or candidate.get('source_sha') != sha:
        raise SafeFailure('The candidate does not belong to the run that published it.')
    return path


def rollback_id(env=os.environ):
    return 'rb' + release_id(env)[len('ci'):]


def rollback(foundation, candidate, mode, rid, project, read, patch, owns, run_git=git,
             read_git=git_bytes, **rollout_options):
    """Move QA to a previously deployed candidate (or redeploy the live one) via `rollout`."""
    if mode not in ('candidate', 'same-image'):
        raise SafeFailure('Rollback mode must be candidate or same-image.')
    sha = candidate.get('source_sha') if isinstance(candidate, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise SafeFailure('Candidate has no full source SHA; nothing was changed.')
    if run_git('merge-base', '--is-ancestor', sha, main_head(run_git))[0] != 0:
        raise SafeFailure('Candidate source is not on main; nothing was changed.')
    apps = {kind: show(foundation, kind, read) for kind in ('api', 'web')}
    live_sha, _ = live_identity(foundation, apps, same_revision=False)
    same = live_images(foundation, apps) == candidate_images(foundation, candidate)
    if mode == 'candidate' and same:
        raise SafeFailure('Candidate is already live; use same-image mode to rehearse; nothing was changed.')
    if mode == 'same-image' and (not same or sha != live_sha):
        raise SafeFailure('Same-image mode needs the live release candidate; nothing was changed.')
    release = live_release_fields(foundation, apps['api'], candidate, sha, rid, project)
    bind_at(candidate, {'foundation': foundation, 'release': release}, sha, read_git)
    # Migrations are never rolled back: old code must not meet a schema it does not know,
    # and the forward return must not skip one either.
    if fingerprint_at(live_sha, read_git)['migrations'] != candidate['migrations']:
        raise SafeFailure('Rollback would cross a migration; nothing was changed.')
    try:
        rollout(foundation, candidate, sha, rid, read, patch, owns, **rollout_options)
    except SafeFailure as error:
        raise SafeFailure('QA rollback to ' + sha + ' did not complete. ' + str(error)) from None
    return sha


# ---------------------------------------------------------------- migrate

def fetch_engine(destination, opener=urlopen):
    try:
        with opener(Request(ENGINE_URL, headers={'User-Agent': USER_AGENT}), timeout=120) as response:
            data = gzip.decompress(response.read())
    except HTTPError as error:
        raise SafeFailure('Schema-engine download failed: HTTP ' + str(error.code) + '.') from None
    except (OSError, EOFError, zlib.error):
        raise SafeFailure('Schema-engine download failed or returned an unreadable archive.') from None
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
        with opener(Request(url, headers={'User-Agent': USER_AGENT}), timeout=10) as response:
            return response.status
    except HTTPError as error:
        return error.code
    except (URLError, OSError):
        return None


def smoke(foundation, fetch=fetch_status, sleep=time.sleep, attempts=12):
    origins = public_origins(foundation)
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
REQUIRED_RULES = ('pull_request', 'deletion', 'non_fast_forward', 'required_status_checks')
GITHUB_ACTIONS_APP_ID = 15368


def verify_main_ruleset(repo=REPOSITORY, read=gh_api):
    """Main must be protected by rules nobody can bypass.

    GitHub resolves which active rules apply to main (include and exclude
    patterns, ~DEFAULT_BRANCH, every ruleset and level), so this never
    interprets ruleset conditions itself. A required rule counts only when it
    comes from a ruleset with no bypass actors; that list is visible to
    repository admins only, so anyone else is refused.
    """
    base = 'repos/' + repo
    rules = read(base + '/rules/branches/main?per_page=100')
    if not isinstance(rules, list) or len(rules) >= 100:
        raise SafeFailure('Cannot read the complete set of rules that apply to main.')
    clean = set()
    for ruleset_id in {rule.get('ruleset_id') for rule in rules}:
        if type(ruleset_id) is not int:
            raise SafeFailure('A rule on main does not name its ruleset.')
        ruleset = read(base + '/rulesets/' + str(ruleset_id))
        if ruleset.get('enforcement') == 'active' and ruleset.get('bypass_actors') == []:
            clean.add(ruleset_id)
    enforced = [rule for rule in rules if rule.get('ruleset_id') in clean]
    types = {rule.get('type') for rule in enforced}
    contexts = {check.get('context') for rule in enforced if rule.get('type') == 'required_status_checks'
                for check in (rule.get('parameters') or {}).get('required_status_checks', [])
                if check.get('integration_id') == GITHUB_ACTIONS_APP_ID}
    if not set(REQUIRED_RULES) <= types or not REQUIRED_CI_JOBS <= contexts:
        raise SafeFailure('Main needs active rules, from rulesets with no bypass actors, that require a pull '
                          'request and the CI jobs ' + ', '.join(sorted(REQUIRED_CI_JOBS)) + ' and forbid '
                          'deletion and force pushes. Run this as a repository admin: only admins can see '
                          'bypass actors.')


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


def shield_signals():
    """Once a rollback of a failed rollout starts, a second cancel signal must not stop it."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)


def main(argv=None, env=os.environ):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('operation', choices=['head', 'plan', 'wait-ci', 'migrate', 'rollout', 'check-github',
                                              'inputs', 'fetch-candidate', 'rollback'])
    parser.add_argument('--sha')
    parser.add_argument('--candidate')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--out', help='inputs: new owner-only file; fetch-candidate: download directory')
    parser.add_argument('--mode', choices=['candidate', 'same-image'], help='rollback: target kind')
    parser.add_argument('--run-id', help='fetch-candidate: the QA deploy run that published the candidate')
    args = parser.parse_args(argv)
    if args.operation == 'check-github':
        verify_qa_environment()
        print('PASS: main is ruleset-protected and environment qa admits deployments from main only.')
        return
    if args.operation == 'fetch-candidate':
        if not args.out:
            raise SafeFailure('fetch-candidate needs --run-id and --out.')
        path = fetch_candidate(args.run_id, args.out)
        print('PASS: candidate of run ' + args.run_id + ' for source '
              + json.loads(path.read_text())['source_sha'] + '.')
        return
    if args.operation in ('inputs', 'rollback'):
        # The source comes from the live apps (inputs) or the candidate (rollback), never --sha.
        if not args.candidate or (args.operation == 'inputs' and not args.out) or (
                args.operation == 'rollback' and not args.mode):
            raise SafeFailure('inputs needs --candidate and --out; rollback needs --candidate and --mode.')
        foundation = foundation_from_env(env)
        arm = Arm(foundation)
        candidate = json.loads(Path(args.candidate).read_text())
        project = env.get('SUPABASE_PROJECT_REF', '')
        if args.operation == 'inputs':
            inputs = export_inputs(foundation, candidate, project, args.out, arm)
            release = inputs['release']
            print('PASS: wrote ' + args.out + ' for source ' + release['source_sha'] + ', revision '
                  + release['release_id'] + (', with mail' if 'mail' in release else ', no mail') + '.')
            return
        rid = rollback_id(env)
        signal.signal(signal.SIGTERM, interrupted)
        sha = rollback(foundation, candidate, args.mode, rid, project, arm, arm.patch, arm.owns,
                       shield=shield_signals)
        print('PASS: QA serves ' + sha + ' as revision suffix ' + rid + ' (' + args.mode + ').')
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
    rollout(foundation, candidate, args.sha, rid, arm, arm.patch, arm.owns, shield=shield_signals)
    print('PASS: QA serves ' + args.sha + ' as revision suffix ' + rid + '.')


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        sys.exit('FAIL: ' + str(error))
    except BaseException:
        sys.exit('FAIL: QA deploy step failed; details withheld.')

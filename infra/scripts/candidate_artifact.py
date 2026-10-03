"""Read only the immutable candidate artifact from an exact successful workflow run."""
import hashlib
import io
import json
import os
import re
import subprocess
import zipfile
from pooler import SafeFailure


def gh(path, binary=False):
    result = subprocess.run(['gh', 'api', '--hostname', 'github.com', path], capture_output=True, check=False)
    if result.returncode:
        raise SafeFailure('Candidate run/artifact lookup failed; no cloud login attempted.')
    return result.stdout if binary else json.loads(result.stdout)


def download(repo, sha, run_id, read=gh):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise SafeFailure('Invalid candidate run identity.')
    base = f'repos/{repo}/actions'
    run = read(base + '/runs/' + run_id)
    if (run.get('path') != '.github/workflows/candidate.yml' or run.get('head_sha') != sha
            or run.get('head_branch') != 'main' or run.get('event') != 'workflow_dispatch'
            or run.get('head_repository', {}).get('full_name') != repo
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        raise SafeFailure('Candidate must be a successful exact-SHA main build in this repository.')
    listing = read(base + '/runs/' + run_id + '/artifacts?per_page=100')
    rows = listing.get('artifacts', [])
    if listing.get('total_count') != 1 or len(rows) != 1:
        raise SafeFailure('Candidate run needs exactly one provenance artifact.')
    artifact = rows[0]
    if (artifact.get('expired') is not False or artifact.get('name') != 'staging-candidate-' + sha
            or not isinstance(artifact.get('id'), int) or not 0 < artifact.get('size_in_bytes', 0) < 1_000_000):
        raise SafeFailure('Candidate artifact is expired or has an unexpected identity/size.')
    archive = read(base + '/artifacts/' + str(artifact['id']) + '/zip', binary=True)
    if len(archive) > 1_000_000 or artifact.get('digest') != 'sha256:' + hashlib.sha256(archive).hexdigest():
        raise SafeFailure('Candidate artifact digest differs from GitHub metadata.')
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        if source.namelist() != ['candidate.json'] or source.getinfo('candidate.json').file_size > 250_000:
            raise SafeFailure('Unexpected candidate artifact entries.')
        return json.loads(source.read('candidate.json'))

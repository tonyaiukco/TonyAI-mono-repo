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


def download(repo, sha, run_id, read=gh, *, with_provenance=False):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise SafeFailure('Invalid candidate run identity.')
    base = f'repos/{repo}/actions'
    run = read(base + '/runs/' + run_id)
    if (run.get('id') != int(run_id) or run.get('path') != '.github/workflows/qa-candidate.yml' or run.get('head_sha') != sha
            or run.get('head_branch') != 'main' or run.get('event') != 'workflow_dispatch'
            or run.get('head_repository', {}).get('full_name') != repo
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'):
        raise SafeFailure('Candidate must be a successful exact-SHA main build in this repository.')
    listing = read(base + '/runs/' + run_id + '/artifacts?per_page=100')
    rows = listing.get('artifacts', [])
    if listing.get('total_count') != 1 or len(rows) != 1:
        raise SafeFailure('Candidate run needs exactly one provenance artifact.')
    artifact = rows[0]
    if (artifact.get('expired') is not False or artifact.get('name') != 'qa-candidate-' + sha
            or not isinstance(artifact.get('id'), int) or not 0 < artifact.get('size_in_bytes', 0) < 1_000_000):
        raise SafeFailure('Candidate artifact is expired or has an unexpected identity/size.')
    archive = read(base + '/artifacts/' + str(artifact['id']) + '/zip', binary=True)
    if len(archive) > 1_000_000 or artifact.get('digest') != 'sha256:' + hashlib.sha256(archive).hexdigest():
        raise SafeFailure('Candidate artifact digest differs from GitHub metadata.')
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        if source.namelist() != ['qa-candidate.json'] or source.getinfo('qa-candidate.json').file_size > 250_000:
            raise SafeFailure('Unexpected candidate artifact entries.')
        content = source.read('qa-candidate.json')
        candidate = json.loads(content)
        if not with_provenance:
            return candidate
        return candidate, {
            'verification': 'github_api_run_and_archive_digest', 'repository': repo,
            'source_sha': sha, 'run_id': run_id, 'artifact_id': artifact['id'],
            'archive_sha256': hashlib.sha256(archive).hexdigest(),
            'candidate_file_sha256': hashlib.sha256(content).hexdigest(),
        }


if __name__ == '__main__':
    import argparse
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        value = download('tonyaiukco/TonyAI-mono-repo', args.sha, args.run_id)
        with Path(args.output).open('x') as output:
            json.dump(value, output, indent=2)
    except Exception:
        raise SystemExit('FAIL: QA candidate provenance lookup refused; details withheld.') from None
    print('PASS: QA candidate downloaded from the exact successful main workflow run.')

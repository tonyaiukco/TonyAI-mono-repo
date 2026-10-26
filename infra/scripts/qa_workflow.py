#!/usr/bin/env python3
"""Pre-authentication QA workflow binding. Handles only public build material."""
import json
import os
from pathlib import Path
from qa_contract import match, require, target
from qa_images import public_material


def prepare(env):
    require(env.get('GITHUB_REF') == 'refs/heads/main')
    require(env.get('GITHUB_REPOSITORY') == 'tonyaiukco/TonyAI-mono-repo')
    selected = target(json.loads(env['QA_TARGET_JSON']))
    require(selected['build']['source_sha'] == env['GITHUB_SHA'])
    require(selected['foundation']['tenant_id'] == env['QA_TENANT_ID'])
    require(selected['foundation']['subscription_id'] == env['QA_SUBSCRIPTION_ID'])
    match(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', env['QA_CLIENT_ID'])
    certificate = env['QA_PUBLIC_DB_CA'].encode()
    public_material(selected['build'], env['NEXT_PUBLIC_SUPABASE_ANON_KEY'], certificate)
    return selected, certificate


if __name__ == '__main__':
    try:
        selected, certificate = prepare(os.environ)
        directory = Path(os.environ['RUNNER_TEMP'])
        with (directory / 'qa-target.json').open('x') as output:
            json.dump(selected, output)
        with (directory / 'qa-db-ca.crt').open('xb') as output:
            output.write(certificate)
    except Exception:
        raise SystemExit('FAIL: QA workflow inputs refused before cloud login; details withheld.') from None
    print('PASS: QA public inputs bound before federation.')

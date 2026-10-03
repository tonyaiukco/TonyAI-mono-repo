#!/usr/bin/env python3
"""Exercise Docker's real ignore matcher using synthetic artifacts and a scratch export."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix='tonyai-context-') as directory:
        context = Path(directory) / 'context'
        context.mkdir()
        shutil.copy2(ROOT / '.dockerignore', context / '.dockerignore')
        ca = 'infra/certs/prod-ca-2021.crt'
        blocked = ['infra/certs/.env', 'infra/certs/terraform.tfstate', 'infra/certs/nested/saved.tfplan',
                   'infra/certs/other.crt', 'infra/config/owner.json', 'infra/.terraform/providers/mock',
                   'apps/api/.env', 'packages/db/terraform.tfstate', '.infra-local/release.json']
        kept = [ca, 'apps/api/src/main.ts', 'apps/web/package.json', 'packages/db/prisma/schema.prisma',
                'supabase/config.toml', 'scripts/check.mjs', 'e2e/smoke.ts']
        for name in blocked + kept:
            path = context / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic fixture\n')
        shutil.copy2(ROOT / ca, context / ca)
        (context / 'Dockerfile').write_text('FROM scratch\nCOPY . /\n')
        output = Path(directory) / 'output'
        subprocess.run(['docker', 'buildx', 'build', '--no-cache', '--network=none',
                        '--output', 'type=local,dest=' + str(output), str(context)], check=True)
        if any((output / name).exists() for name in blocked):
            raise SystemExit('FAIL: Docker included a forbidden infrastructure artifact.')
        if any(not (output / name).is_file() for name in kept):
            raise SystemExit('FAIL: Docker excluded a required source or CA fixture.')
        if (output / ca).read_bytes() != (ROOT / ca).read_bytes():
            raise SystemExit('FAIL: bundled CA changed in Docker context.')
    print('PASS: Docker excludes synthetic secrets/state under certs and preserves only the CA and required source paths.')


if __name__ == '__main__':
    main()

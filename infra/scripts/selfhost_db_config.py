#!/usr/bin/env python3
"""Seed a fresh persistent Postgres config directory from the exact pinned image."""
import json
import os
import re
from pathlib import Path
import subprocess


def main():
    target = Path('/srv/tonyai/database/db-config')
    postgres = Path('/srv/tonyai/database/postgres')
    if os.geteuid() != 0 or not os.path.ismount('/srv/tonyai/database'):
        raise ValueError('Run as root after the persistent database disk is mounted.')
    image = json.loads(Path('compose.images.json').read_text())['services']['db']['image']
    if not re.fullmatch(r'[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}', image):
        raise ValueError('A reviewed immutable Postgres image digest is required.')
    existing_database = postgres.exists() and any(postgres.iterdir())
    marker = target / '.tonyai-image'
    required_files = ('wal-g.conf', 'read-replica.conf', 'supautils.conf')
    def validate_config():
        if (any(not (target / name).is_file() for name in required_files)
                or not (target / 'conf.d').is_dir()):
            raise ValueError('Postgres configuration is incomplete; recover the original configuration.')
        if existing_database:
            key = target / 'pgsodium_root.key'
            if not key.is_file() or key.stat().st_size == 0:
                raise ValueError('Existing database requires its original pgsodium key; recover it before startup.')
    if marker.exists():
        if marker.read_text().strip() != image:
            raise ValueError('Existing Postgres config belongs to another image; review upgrade.')
        validate_config()
    elif existing_database:
        raise ValueError('Existing database requires recovery of its original configuration; fresh seeding refused.')
    elif target.exists() and any(target.iterdir()):
        raise ValueError('Refusing to overwrite an unrecognized Postgres config directory.')
    metadata = subprocess.check_output(['docker', 'run', '--rm', '--entrypoint', 'stat', image,
                                        '-c', '%u:%g:%a', '/etc/postgresql-custom'], text=True).strip()
    uid, gid, mode = metadata.split(':')
    def preserve_directory_metadata():
        os.chown(target, int(uid), int(gid))
        target.chmod(int(mode, 8))
    if marker.exists():
        preserve_directory_metadata()
        print('PASS: existing Postgres config preserved.')
        return
    target.mkdir(parents=True, exist_ok=True)
    container = subprocess.check_output(['docker', 'create', '--entrypoint', 'true', image], text=True).strip()
    try:
        subprocess.run(['docker', 'cp', '-a', container + ':/etc/postgresql-custom/.', str(target)], check=True)
    finally:
        subprocess.run(['docker', 'rm', '-v', container], check=True, stdout=subprocess.DEVNULL)
    validate_config()
    preserve_directory_metadata()
    marker.write_text(image + '\n')
    marker.chmod(0o600)
    print('PASS: fresh Postgres configuration seeded from the pinned image; no existing database changed.')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Owner-approved QA dashboard rotation; never prints credential material.

Run installed root-owned sources with python3 -I. No live operation is authorized
by possessing this script. Database integrity acceptance is a separate gate.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys

# Isolated Python omits the script directory. Add it only after checking its
# ownership chain; no user-controlled PYTHONPATH is needed for installed helpers.
if __name__ == '__main__':
    import stat
    folder = Path(__file__).resolve().parent
    for item in (folder, *folder.parents):
        info = item.lstat()
        if info.st_uid != 0 or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
            sys.exit('FAIL: install the reviewed helper bundle in a root-owned directory.')
    if os.geteuid() != 0 or not sys.flags.isolated:
        sys.exit('FAIL: root and isolated Python are required.')
    if stat.S_IMODE(folder.stat().st_mode) != 0o700:
        sys.exit('FAIL: the installed helper directory must be owner-only.')
    for name in ('selfhost_dashboard_rotation.py', 'dashboard_rotation_store.py',
                 'dashboard_rotation_runtime.py', 'selfhost_pin.py'):
        info = (folder / name).lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
                or info.st_mode & 0o022):
            sys.exit('FAIL: unsafe installed helper source.')
    sys.path.insert(0, str(folder))

from dashboard_rotation_store import Store, create, digest, read


def field(data, key):
    assignments = re.findall(rb'(?m)^[ \t]*(?:export[ \t]+)?' + key + rb'[ \t]*=', data)
    matches = list(re.finditer(rb"(?m)^" + key + rb"='([^'\r\n]*)'$", data))
    if len(assignments) != 1 or len(matches) != 1 or not matches[0][1] or len(matches[0][1]) > 1024:
        raise ValueError('Ambiguous dashboard field.')
    return matches[0]


def credentials(data):
    username = field(data, b'DASHBOARD_USERNAME')[1]
    if not re.fullmatch(rb'[a-zA-Z0-9_-]{1,64}', username):
        raise ValueError('Unsupported dashboard username.')
    return username, field(data, b'DASHBOARD_PASSWORD')[1]


def marker_valid(marker, env_hash):
    return (isinstance(marker, dict) and set(marker) == {'version', 'vault', 'sha256'}
            and isinstance(marker['version'], str) and re.fullmatch(r'[a-f0-9]{32}', marker['version'])
            and isinstance(marker['vault'], str)
            and re.fullmatch(r'https://tonyai-qa-rec-[a-f0-9]{8}\.vault\.azure\.net', marker['vault'])
            and marker['sha256'] == env_hash)


class Rotation:
    def __init__(self, store, runtime):
        self.store, self.runtime = store, runtime

    def resume(self):
        journal = self.store.journal()
        required = {'format', 'phase', 'before', 'after', 'escrow', 'sources', 'configuration', 'containers'}
        if set(journal) != required or journal['format'] != 1 or journal['phase'] not in (
                'prepared', 'awaiting-escrow', 'activating', 'credential-verified', 'finalized'):
            raise ValueError('Unexpected rotation journal.')
        if self.runtime.sources() != journal['sources']:
            raise ValueError('Source drift during rotation.')
        return journal

    def prepare(self):
        if (self.store.directory / 'journal.json').exists():
            journal = self.resume()
            if journal['phase'] not in ('prepared', 'awaiting-escrow'):
                raise ValueError('Preparation cannot restart an activated rotation.')
        else:
            if set(p.name for p in self.store.directory.iterdir()) != {'lock'}:
                raise ValueError('Orphan rotation material requires private reconciliation.')
            original = self.store.environment()
            escrow = self.store.escrow()
            if not marker_valid(escrow, digest(original)):
                raise ValueError('Current escrow marker does not bind this environment.')
            username, old = credentials(original)
            sources = self.runtime.sources()
            containers = self.runtime.inventory()
            self.runtime.require_stopped(containers, old)
            config = self.runtime.configuration(username, old, gateway_id=containers['api-gw']['id'])
            replacement = secrets.token_hex(32).encode()
            if replacement == old:
                raise ValueError('Replacement equals existing credential.')
            match = field(original, b'DASHBOARD_PASSWORD')
            updated = original[:match.start(1)] + replacement + original[match.end(1):]
            create(self.store.directory / 'previous-password', old)
            create(self.store.directory / 'next.env', updated)
            journal = dict(format=1, phase='prepared', before=digest(original), after=digest(updated),
                           escrow=escrow, sources=sources, configuration=config, containers=containers)
            self.store.write_journal(journal)
        current = digest(self.store.environment())
        if current not in (journal['before'], journal['after']):
            raise ValueError('Runtime differs from both transaction versions.')
        candidate = self.store.read('next.env')
        if digest(candidate) != journal['after']:
            raise ValueError('Staged environment changed.')
        self.runtime.require_stopped(self.runtime.inventory(), self.store.read('previous-password'))
        if current == journal['before']:
            if self.store.escrow() != journal['escrow']:
                raise ValueError('Original escrow binding changed before replacement.')
            self.store.install(journal['before'])
        journal['phase'] = 'awaiting-escrow'
        self.store.write_journal(journal)
        return 'PREPARED: gateway remains stopped; save and verify new escrow before activation.'

    def ready(self, journal):
        current = self.store.environment()
        if digest(current) != journal['after']:
            raise ValueError('Runtime changed after preparation.')
        escrow = self.store.escrow()
        if (not marker_valid(escrow, journal['after']) or escrow['vault'] != journal['escrow']['vault']
                or escrow['version'] == journal['escrow']['version']):
            raise ValueError('A new matching escrow version is required.')
        username, password = credentials(current)
        if self.runtime.configuration(username, password) != journal['configuration']:
            raise ValueError('Effective configuration changed beyond the dashboard password.')
        return username, password

    def activate(self):
        journal = self.resume()
        if journal['phase'] not in ('awaiting-escrow', 'activating', 'credential-verified'):
            raise ValueError('Rotation is not ready for activation.')
        username, password = self.ready(journal)
        old = self.store.read('previous-password')
        if old == password:
            raise ValueError('Old and new credentials must differ.')
        self.runtime.require_dependencies(journal['containers'])
        journal['phase'] = 'activating'
        self.store.write_journal(journal)
        try:
            self.runtime.recreate()
            self.runtime.verify(username, password, old, journal['containers'])
            if self.runtime.sources() != journal['sources']:
                raise ValueError('Source changed during activation.')
            self.ready(journal)
            journal['phase'] = 'credential-verified'
            self.store.write_journal(journal)
        except Exception:
            self.runtime.stop()
            raise ValueError('Activation failed; gateway stop requested. Verify containment privately.') from None
        return 'PASS: dashboard rotation verified; PD-3 integrity acceptance remains OPEN.'

    def finalize(self):
        journal = self.resume()
        if journal['phase'] not in ('credential-verified', 'finalized'):
            raise ValueError('Only a verified credential transaction may be finalized.')
        username, password = self.ready(journal)
        old_path = self.store.directory / 'previous-password'
        old = self.store.read('previous-password') if old_path.exists() or old_path.is_symlink() else None
        self.runtime.verify(username, password, old, journal['containers'])
        # Keep an auditable journal; never archive the previous credential as evidence.
        for name in ('previous-password', 'next.env'):
            path = self.store.directory / name
            if path.exists() or path.is_symlink():
                self.store.read(name)
                path.unlink()
        from dashboard_rotation_store import sync_dir
        sync_dir(self.store.directory)
        journal['phase'] = 'finalized'
        self.store.write_journal(journal)
        return 'PASS: temporary secret copies removed; custody journal retained; PD-3 remains OPEN.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'activate', 'finalize'])
    args = parser.parse_args()
    os.umask(0o077)
    source = Path(__file__).resolve().parent
    for name in ('selfhost_dashboard_rotation.py', 'dashboard_rotation_store.py',
                 'dashboard_rotation_runtime.py', 'selfhost_pin.py'):
        read(source / name)
    from dashboard_rotation_runtime import Runtime
    store = Store('/opt/tonyai/supabase', '/etc/tonyai/dashboard-rotation', '/etc/tonyai/escrow.json')
    with store.locked():
        print(getattr(Rotation(store, Runtime(store, source)), args.action)())


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: rotation incomplete; sensitive diagnostics withheld. Keep integration blocked and follow the private recovery procedure.')

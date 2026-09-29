#!/usr/bin/env python3
"""Reproduce the seven reported surviving mutations in disposable source copies."""
import ast
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

INFRA = Path(__file__).resolve().parents[1]
MUTANTS = [
    ('redirect handler removed', 'cloud_ops.py', 'build_opener(NoRedirect)', 'build_opener()'),
    ('public readback check removed', 'cloud_ops.py', "actual.get('public') is not False or ", ''),
    ('migration URL validation skipped', 'cloud_ops.py',
     '    validate_pooler(runtime, project, 6543)\n    validate_pooler(direct, project, 5432)\n', ''),
    ('signed bytes comparison removed', 'cloud_ops.py',
     'if require_success(request(base + signed)) != payload:', 'if False:'),
    ('cleanup prefix emptied', 'cloud_ops.py', "{'prefixes': [path]}", "{'prefixes': []}"),
    ('database path check removed', 'pooler.py', " or parsed.path != '/postgres'", ''),
    ('error body returned', 'cloud_ops.py', "return error.code, b''", 'return error.code, error.read()'),
]


def main():
    # A green control run prevents existing failures masquerading as killed mutants.
    result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(INFRA / 'tests')], capture_output=True)
    if result.returncode:
        sys.exit('FAIL: unmodified tests do not pass; mutation evidence is invalid.')
    for name, filename, before, after in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='tonyai-infra-mutant-') as directory:
            target = Path(directory)
            for folder in ('scripts', 'tests'):
                shutil.copytree(INFRA / folder, target / folder, ignore=shutil.ignore_patterns('__pycache__'))
            path = target / 'scripts' / filename
            source = path.read_text()
            if source.count(before) != 1:
                sys.exit('FAIL: mutation anchor changed: ' + name)
            mutated = source.replace(before, after)
            ast.parse(mutated)  # Syntax errors are not a valid security-test kill.
            path.write_text(mutated)
            result = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(target / 'tests')], capture_output=True)
            if result.returncode == 0:
                sys.exit('SURVIVED: ' + name)
            print('KILLED: ' + name)
    print('PASS: all seven reported surviving mutations are now detected.')


if __name__ == '__main__':
    main()

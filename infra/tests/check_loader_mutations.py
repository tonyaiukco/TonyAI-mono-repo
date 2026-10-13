"""Offline loader guard mutants, each run in a private copy, never against a DB."""
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MUTANTS = [
    ('current identity', 'loader-identity.mjs', "rows[0].current_user !== ROLE", 'false'),
    ('session identity', 'loader-identity.mjs', "rows[0].session_user !== ROLE", 'false'),
    ('row cardinality', 'loader-identity.mjs', 'rows.length !== 1', 'rows.length < 1'),
    ('runtime fallback', 'loader-identity.mjs', 'env.FACTOR_LOADER_DATABASE_URL;', 'env.FACTOR_LOADER_DATABASE_URL || env.DATABASE_URL;'),
    ('transaction endpoint', 'loader-identity.mjs', "url.port !== '5432'", 'false'),
    ('project binding', 'loader-identity.mjs', 'url.username !== `${ROLE}.${project}`', 'false'),
    ('TLS policy', 'loader-identity.mjs', '[...params].some(([key, expected]) => url.searchParams.get(key) !== expected)', 'false'),
    ('parameter overrides', 'loader-identity.mjs', '[...url.searchParams].length !== params.size', 'false'),
    ('disconnect', 'loader-identity.mjs', 'await client.$disconnect();', '/* omitted */'),
    ('child environment', 'loader-command.mjs', "env: { FACTOR_LOADER_DATABASE_URL", "env: { ...env, FACTOR_LOADER_DATABASE_URL"),
    ('child logging', 'loader-command.mjs', "stdio: ['ignore', 'pipe', 'pipe']", "stdio: ['ignore', 'inherit', 'inherit']"),
    ('child status', 'loader-command.mjs', 'result.status !== 0', 'false'),
    ('child signal', 'loader-command.mjs', 'result.signal ||', ''),
    ('driver stderr', 'loader-command.mjs', '|| result.stderr', ''),
    ('report command', 'loader-command.mjs', 'report?.command !== args[0]', 'false'),
    ('report outcome', 'loader-command.mjs', '!OUTCOMES[args[0]].includes(report.outcome)', 'false'),
    ('secret report', 'loader-command.mjs', 'text.includes(url) || text.includes(new URL(url).password)', 'false'),
    ('command URL validation', 'loader-command.mjs', 'const url = loaderUrl(env);', "const url = env.FACTOR_LOADER_DATABASE_URL; if (!url) throw new Error('missing');"),
    ('child encoding', 'loader-command.mjs', ", encoding: 'utf8'", ''),
    ('child working directory', 'loader-command.mjs', "new URL('../../apps/api/', import.meta.url)", "new URL('../../../apps/api/', import.meta.url)"),
    ('host start anchor', 'loader-identity.mjs', '/^aws-', '/aws-'),
    ('host end anchor', 'loader-identity.mjs', r'\.com$/', r'\.com/'),
    ('host dot escaping', 'loader-identity.mjs', r'eu-central-1\.pooler\.supabase\.com', 'eu-central-1.pooler.supabase.com'),
    ('success would_load', 'loader-command.mjs', "'would_load'", "'unsupported_would_load'"),
    ('success loaded', 'loader-command.mjs', "'loaded'", "'unsupported_loaded'"),
    ('success already_loaded', 'loader-command.mjs', "'already_loaded'", "'unsupported_already_loaded'"),
    ('success would_withdraw', 'loader-command.mjs', "'would_withdraw'", "'unsupported_would_withdraw'"),
    ('success withdrawn', 'loader-command.mjs', "'withdrawn'", "'unsupported_withdrawn'"),
    ('success already_withdrawn', 'loader-command.mjs', "'already_withdrawn'", "'unsupported_already_withdrawn'"),
]


def main():
    for label, filename, before, after in MUTANTS:
        with tempfile.TemporaryDirectory(prefix='lp4-loader-mutant-') as directory:
            root = Path(directory)
            for relative in ['infra/scripts/loader-identity.mjs', 'infra/scripts/loader-command.mjs', 'infra/tests/loader-identity.test.mjs']:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            target = root / 'infra/scripts' / filename
            source = target.read_text()
            assert source.count(before) == 1, label
            target.write_text(source.replace(before, after))
            result = subprocess.run(['node', '--test', str(root / 'infra/tests/loader-identity.test.mjs')], capture_output=True, text=True, timeout=30)
            if result.returncode == 0:
                raise AssertionError(f'Survived: {label}')
            assert 'ERR_ASSERTION' in result.stdout, f'Not an assertion failure: {label}'
            print(f'KILLED: {label}')
    print(f'PASS: {len(MUTANTS)} loader guard mutants killed')


if __name__ == '__main__':
    main()

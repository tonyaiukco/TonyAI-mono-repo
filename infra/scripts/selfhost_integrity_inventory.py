#!/usr/bin/env python3
"""Owner-approved QA metadata inventory only; never an integrity verdict.

The query requests no application/Auth rows, credential fields or definitions.
Only reviewed aggregate counts and scope/existence fields are returned;
the database reads catalog rows internally to calculate aggregates.
No arbitrary object names are returned.
No baseline is created. No database/schema/user/configuration mutation is requested.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

DB_IMAGE = 'supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00'
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
COUNTS = {
    'connectable_databases': 'SELECT count(*) FROM pg_catalog.pg_database WHERE datallowconn AND NOT datistemplate',
    'additional_databases': "SELECT count(*) FROM pg_catalog.pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres','_supabase')",
    'roles': 'SELECT count(*) FROM pg_catalog.pg_roles',
    'login_roles': 'SELECT count(*) FROM pg_catalog.pg_roles WHERE rolcanlogin',
    'superuser_roles': 'SELECT count(*) FROM pg_catalog.pg_roles WHERE rolsuper',
    'bypassrls_roles': 'SELECT count(*) FROM pg_catalog.pg_roles WHERE rolbypassrls',
    'memberships': 'SELECT count(*) FROM pg_catalog.pg_auth_members',
    'schemas': 'SELECT count(*) FROM pg_catalog.pg_namespace',
    'relations': 'SELECT count(*) FROM pg_catalog.pg_class',
    'extensions': 'SELECT count(*) FROM pg_catalog.pg_extension',
    'functions': 'SELECT count(*) FROM pg_catalog.pg_proc',
    'security_definer_functions': 'SELECT count(*) FROM pg_catalog.pg_proc WHERE prosecdef',
    'triggers': 'SELECT count(*) FROM pg_catalog.pg_trigger',
    'event_triggers': 'SELECT count(*) FROM pg_catalog.pg_event_trigger',
    'login_event_triggers': "SELECT count(*) FROM pg_catalog.pg_event_trigger WHERE evtevent='login'",
    'policies': 'SELECT count(*) FROM pg_catalog.pg_policy',
    'default_acl_entries': 'SELECT count(*) FROM pg_catalog.pg_default_acl',
    'foreign_servers': 'SELECT count(*) FROM pg_catalog.pg_foreign_server',
    'user_mappings': 'SELECT count(*) FROM pg_catalog.pg_user_mapping',
    'publications': 'SELECT count(*) FROM pg_catalog.pg_publication',
    'subscriptions': 'SELECT count(*) FROM pg_catalog.pg_subscription',
}
RELATIONS = {'auth_users': ('auth', 'users'), 'storage_objects': ('storage', 'objects'),
             'application_migrations': ('public', '_prisma_migrations')}
# All interpolated names below are source constants, never database/user input.
SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_catalog.json_build_object(" + \
    "'format',2,'read_only',pg_catalog.current_setting('transaction_read_only')='on'," + \
    "'event_triggers_disabled',pg_catalog.current_setting('event_triggers')='off'," + \
    "'database_matches',pg_catalog.current_database()='postgres'," + \
    "'server_version_num',pg_catalog.current_setting('server_version_num')::integer," + \
    "'counts',pg_catalog.json_build_object(" + ','.join("'%s',(%s)" % item for item in COUNTS.items()) + \
    "),'relations',pg_catalog.json_build_object(" + ','.join(
        "'%s',EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='%s' AND c.relname='%s' AND c.relkind IN ('r','p'))" % (key, *value)
        for key, value in RELATIONS.items()) + "));\nROLLBACK;\n"


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate output field.')
        value[key] = item
    return value


def decode(data):
    if len(data) > 16384:
        raise ValueError('Oversize response.')
    return json.loads(data, object_pairs_hook=unique_object)


def validate_report(data):
    value = decode(data)
    if (not isinstance(value, dict) or set(value) != {'format', 'read_only', 'event_triggers_disabled', 'database_matches', 'server_version_num', 'counts', 'relations'}
            or type(value['format']) is not int or value['format'] != 2
            or value['read_only'] is not True or value['event_triggers_disabled'] is not True
            or value['database_matches'] is not True
            or type(value['server_version_num']) is not int or not 170000 <= value['server_version_num'] < 180000):
        raise ValueError('Unexpected inventory scope/version.')
    if (not isinstance(value['counts'], dict) or set(value['counts']) != set(COUNTS)
            or any(type(n) is not int or not 0 <= n <= 2**63-1 for n in value['counts'].values())
            or not isinstance(value['relations'], dict) or set(value['relations']) != set(RELATIONS)
            or any(type(n) is not bool for n in value['relations'].values())):
        raise ValueError('Unexpected inventory fields.')
    return dict(value, scope='postgres_catalog_metadata_only', baseline_compared=False,
                integrity_verdict='NOT_ASSESSED', pd3='OPEN', safe_to_discard_data=False)


def call(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=25,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}, check=False)
    if result.returncode:
        raise ValueError('Private metadata operation failed.')
    return result.stdout


def collect():
    projection = ('{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},'
                  '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                  '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                  '"running":{{json .State.Running}},"ports":{{json .HostConfig.PortBindings}}}')
    item = decode(call(DOCKER + ['inspect', '--format', projection, 'supabase-db']))
    if (item['name'] != '/supabase-db' or item['image'] != DB_IMAGE or item['project'] != 'supabase'
            or item['service'] != 'db' or item['running'] is not True or item['ports'] not in (None, {})
            or not re.fullmatch(r'[a-f0-9]{64}', item['id'])):
        raise ValueError('Foreign or exposed database container.')
    options = ('-c event_triggers=off -c default_transaction_read_only=on -c search_path=pg_catalog '
               '-c statement_timeout=5000 -c lock_timeout=1000 '
               '-c idle_in_transaction_session_timeout=10000 -c row_security=off')
    command = DOCKER + ['exec', '--user', 'postgres', '-i', item['id'], '/usr/bin/env', '-i',
                        'PATH=/usr/lib/postgresql/17/bin:/usr/bin:/bin', 'PGPASSFILE=/dev/null', 'PGOPTIONS=' + options,
                        'psql', '-X', '-qAt', '-w', '--set=ON_ERROR_STOP=1',
                        '-h', '/var/run/postgresql', '-U', 'postgres', '-d', 'postgres']
    return validate_report(call(command, SQL.encode()))


def trusted_file(path):
    for parent in path.parents:
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Unsafe directory.')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise ValueError('Unsafe source/contract.')


def main():
    if os.geteuid() != 0 or not sys.flags.isolated:
        raise ValueError('Root and isolated Python required.')
    trusted_file(Path(__file__).absolute())
    host = Path('/etc/tonyai/host.json'); trusted_file(host)
    installed = decode(host.read_bytes())
    binding = Path(__file__).resolve().with_name('target.json'); trusted_file(binding)
    contract = decode(binding.read_bytes())
    if (set(contract) != {'environment', 'resource_group', 'vm_name', 'public_hostname'}
            or contract['environment'] != 'staging' or contract['resource_group'] != 'tonyai-staging-data'
            or contract['vm_name'] != 'tonyai-staging-data'
            or not isinstance(contract['public_hostname'], str)
            or not re.fullmatch(r'[a-z0-9][a-z0-9.-]*\.cloudapp\.azure\.com', contract['public_hostname'])
            or installed.get('public_hostname') != contract['public_hostname']):
        raise ValueError('QA target required.')
    print(json.dumps(collect(), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: metadata inventory incomplete; raw diagnostics withheld. PD-3 remains OPEN.')

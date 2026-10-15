"""Generation-bound recovery envelopes. Bytes stay within owner-only processes."""
import base64
import hashlib
import json
import re
from replacement_bundle import encoded

ENV = '/opt/tonyai/supabase/.env'
SODIUM = '/srv/tonyai/database/db-config/pgsodium_root.key'


def binding(contract):
    return {key: contract[key] for key in ('generation', 'vm_id', 'vm_uuid', 'recovery_vault_url', 'source_sha256', 'disks')}


def envelope(contract, stage, files):
    expected = {ENV} if stage == 'environment' else {ENV, SODIUM} if stage == 'intrinsic' else set()
    if not expected or set(files) != expected or any(not data or len(data) > 24000 for data in files.values()):
        raise ValueError('Exact recovery file set required.')
    result = {'format': 2, 'binding': binding(contract), 'stage': stage,
              'files': {name: base64.b64encode(data).decode() for name, data in files.items()}}
    if len(encoded(result)) > 25000:
        raise ValueError('Recovery envelope exceeds vault secret limit.')
    return result


def unpack(value, contract, stage):
    if set(value) != {'format', 'binding', 'stage', 'files'} or value['format'] != 2 or value['binding'] != binding(contract) or value['stage'] != stage:
        raise ValueError('Foreign or downgraded recovery envelope.')
    files = {name: base64.b64decode(data, validate=True) for name, data in value['files'].items()}
    if envelope(contract, stage, files) != value:
        raise ValueError('Noncanonical recovery envelope.')
    return files


def marker(contract, stage, version, files):
    if not re.fullmatch('[a-f0-9]{32}', version):
        raise ValueError('Exact immutable recovery version required.')
    envelope(contract, stage, files)
    return {'format': 2, 'binding': binding(contract), 'stage': stage, 'version': version,
            'secret': 'supabase-r02-' + stage,
            'sha256': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}


def verify_marker(record, contract, stage, files):
    if marker(contract, stage, record['version'], files) != record:
        raise ValueError('Recovery marker does not bind this generation and bytes.')

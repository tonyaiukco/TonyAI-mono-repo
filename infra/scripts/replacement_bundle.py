"""Local private-file and source bindings for the replacement saved-plan workflow."""
import hashlib
import json
import os
from pathlib import Path
import stat

ROOT = Path(__file__).resolve().parents[2]
TF_ROOT = ROOT / 'infra/terraform/selfhost'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def private_read(path):
    path = Path(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_nlink != 1:
        raise ValueError('Expected an owner-only regular file.')
    return path.read_bytes()


def write_new(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def sources():
    paths = [ROOT / 'README.md', ROOT / '.github/workflows/infra.yml']
    for folder in ('infra/scripts', 'infra/selfhost', 'infra/terraform/selfhost', 'infra/config'):
        paths.extend(p for p in (ROOT / folder).iterdir() if p.is_file() and (p.suffix in ('.py', '.mjs', '.sh', '.tf', '.json', '.yml', '.hcl') or p.name == 'Caddyfile'))
    if any(p.is_symlink() for p in paths):
        raise ValueError('Symlinked source refused.')
    return {str(p.relative_to(ROOT)): digest(p.read_bytes()) for p in sorted(set(paths))}


def clean_environment(environ):
    # Refuse rather than silently discard caller-selected state, credentials or CLI config.
    if any(k.startswith(('TF_', 'ARM_', 'AZAPI_')) for k in environ):
        raise ValueError('Remove ambient Terraform/provider overrides first.')
    if (Path.home() / '.terraformrc').exists():
        raise ValueError('Unreviewed Terraform CLI configuration.')
    for path in TF_ROOT.iterdir():
        if (path.name.endswith(('.tfvars', '.tfvars.json', '.tf.json')) or 'override.tf' in path.name):
            raise ValueError('Ambient Terraform inputs refused.')
    return {k: v for k, v in environ.items() if k in ('PATH', 'HOME', 'AZURE_CONFIG_DIR', 'LANG', 'TMPDIR', 'SSL_CERT_FILE')}


def backend_binding(backend):
    from bootstrap_backend import validate
    validate(backend)
    if backend.get('location') != 'swedencentral' or backend['environment'] != 'staging':
        raise ValueError('Sweden QA backend required.')
    cached = json.loads((TF_ROOT / '.terraform/terraform.tfstate').read_bytes())['backend']
    expected = dict(subscription_id=backend['subscription_id'], tenant_id=backend['tenant_id'],
                    storage_account_name=backend['storage_account'], container_name='foundation',
                    key='staging-selfhost.tfstate', use_azuread_auth=True)
    if cached['type'] != 'azurerm' or any(cached['config'].get(k) != v for k, v in expected.items()):
        raise ValueError('Existing backend binding differs; never reconfigure it here.')
    forbidden = ('access_key', 'sas_token', 'client_secret', 'client_certificate_path', 'endpoint', 'metadata_host')
    if any(cached['config'].get(k) for k in forbidden):
        raise ValueError('Unreviewed backend credential or endpoint.')
    workspace = TF_ROOT / '.terraform/environment'
    if workspace.exists() and workspace.read_text().strip() != 'default':
        raise ValueError('Only the existing default workspace is permitted.')
    return {'expected': expected, 'cache_sha256': digest(encoded(cached)), 'workspace': 'default'}

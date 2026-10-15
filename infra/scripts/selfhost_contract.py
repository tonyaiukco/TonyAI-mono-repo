"""Nonsecret, owner-only input boundary for the Azure Supabase host foundation."""
import base64
import ipaddress
import re
import struct
from uuid import UUID
from pooler import SafeFailure


def validate_selfhost(inputs):
    if not isinstance(inputs, dict) or set(inputs) != {'config'}:
        raise SafeFailure('Selfhost input must contain only config.')
    config = inputs['config']
    fields = {'subscription_id', 'tenant_id', 'environment', 'operator_ipv4',
              'ssh_public_key', 'image_version', 'vm_size', 'https_enabled', 'recovery_owner_object_id'}
    if not isinstance(config, dict) or set(config) != fields:
        raise SafeFailure('Selfhost requires exact nonsecret fields; unknown fields are prohibited.')
    try:
        for name in ('subscription_id', 'tenant_id', 'recovery_owner_object_id'):
            if str(UUID(config[name])) != config[name]:
                raise ValueError()
        address = ipaddress.IPv4Network(config['operator_ipv4'], strict=True)
        if address.prefixlen != 32 or not address.network_address.is_global:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise SafeFailure('Canonical UUIDs and one public operator IPv4 /32 are required.') from None
    if config['environment'] not in ('staging', 'production'):
        raise SafeFailure('Environment must be staging or production.')
    if config['environment'] == 'production':
        raise SafeFailure('Production is gated on owned-domain integration, recovery acceptance and the legacy-key decision; this bootstrap is QA-only.')
    if config['vm_size'] not in ('Standard_D2as_v7', 'Standard_D4as_v7'):
        raise SafeFailure('Only reviewed D2as/D4as v7 VM sizes are permitted.')
    if not isinstance(config['image_version'], str) or not re.fullmatch(r'\d+\.\d+\.\d+', config['image_version']):
        raise SafeFailure('Use an exact verified Canonical Ubuntu image version, never latest.')
    if type(config['https_enabled']) is not bool:
        raise SafeFailure('HTTPS exposure must be an explicit boolean.')
    validate_public_key(config['ssh_public_key'])
    return config


def validate_public_key(value):
    """Accept only an OpenSSH RSA public key with a >=2048-bit modulus."""
    try:
        if not isinstance(value, str) or '\n' in value or '\r' in value:
            raise ValueError()
        parts = value.split()
        if len(parts) != 2 or parts[0] != 'ssh-rsa':
            raise ValueError()
        data = base64.b64decode(parts[1], validate=True)
        fields = []
        while data:
            length = struct.unpack('>I', data[:4])[0]
            if length > len(data) - 4:
                raise ValueError()
            fields.append(data[4:4 + length])
            data = data[4 + length:]
        if len(fields) != 3 or fields[0] != b'ssh-rsa':
            raise ValueError()
        integers = fields[1:]
        if any(not v or v[0] & 128 or (v[0] == 0 and (len(v) == 1 or not v[1] & 128)) for v in integers):
            raise ValueError()
        exponent, modulus = (int.from_bytes(v, 'big') for v in integers)
        if exponent < 3 or exponent % 2 != 1 or exponent >= modulus or modulus % 2 != 1 or modulus.bit_length() < 2048:
            raise ValueError()
    except (ValueError, TypeError, struct.error):
        raise SafeFailure('Supply a single RSA public key (2048+ bits), without comment or private material.') from None

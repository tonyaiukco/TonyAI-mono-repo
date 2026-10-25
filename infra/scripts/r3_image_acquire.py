"""Fetch the twelve locked roots into a selected-platform OCI layout over HTTPS.

Connected acquisition only: anonymous Docker Hub reads by digest, never a tag,
daemon, pull or build. Every byte is size- and hash-checked before it is kept;
r3_image_transport then re-verifies the exact layout. Not import qualification.
"""
import hashlib
import json
from pathlib import Path
import re
import socket
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_image_transport import INDEXES, MANIFESTS

REGISTRY = 'https://registry-1.docker.io/v2/'
AUTH = 'https://auth.docker.io/token'
ACCEPT = ', '.join(sorted(MANIFESTS | INDEXES))
DOCUMENT_LIMIT = 4 * 1024 * 1024
BLOB_LIMIT = 4 * 1024**3
TOTAL_LIMIT = 16 * 1024**3
# Docker Hub only: a domain-looking first component would name another registry.
REFERENCE = re.compile(r'(?:([a-z0-9]+(?:[_-]+[a-z0-9]+)*)/)?([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)@(sha256:[a-f0-9]{64})')


def repository(image):
    match = REFERENCE.fullmatch(image)
    if not match:
        raise ValueError('Docker Hub repository@sha256 reference required.')
    namespace, name, value = match.groups()
    if namespace == 'localhost':
        raise ValueError('A localhost namespace names another registry.')
    return (namespace or 'library') + '/' + name, value


def canonical(image):
    """The name a by-digest pull records in the containerd image store."""
    repo, value = repository(image)
    return 'docker.io/' + repo + '@' + value


class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != 'https':
            raise ValueError('Insecure redirect refused.')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Client:
    """Anonymous pull-scoped tokens; the bearer never follows a CDN redirect."""

    def __init__(self, opener=None):
        self.opener = opener or urllib.request.build_opener(HTTPSRedirect)
        self.tokens, self.hosts = {}, set()

    def open(self, url, headers=None, token=None):
        request = urllib.request.Request(url, headers={'User-Agent': 'tonyai-r3-acquire/1', **(headers or {})})
        if token:
            request.add_unredirected_header('Authorization', 'Bearer ' + token)
        response = self.opener.open(request, timeout=120)
        final = urllib.parse.urlsplit(response.url)
        if final.scheme != 'https' or not final.hostname:
            raise ValueError('Insecure registry response refused.')
        self.hosts.add(final.hostname)
        return response

    def token(self, repo):
        if repo not in self.tokens:
            query = urllib.parse.urlencode({'service': 'registry.docker.io', 'scope': 'repository:' + repo + ':pull'})
            with self.open(AUTH + '?' + query) as response:
                value = json.loads(bounded(response, DOCUMENT_LIMIT)).get('token')
            if not isinstance(value, str) or not value:
                raise ValueError('Anonymous registry token refused.')
            self.tokens[repo] = value
        return self.tokens[repo]


def bounded(response, limit):
    data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Registry document limit.')
    return data


def document(client, repo, descriptor, accept):
    url = REGISTRY + repo + '/manifests/' + descriptor['digest']
    with client.open(url, {'Accept': accept}, client.token(repo)) as response:
        media = response.headers.get('Content-Type', '').split(';')[0].strip()
        data = bounded(response, DOCUMENT_LIMIT)
    if 'sha256:' + hashlib.sha256(data).hexdigest() != descriptor['digest']:
        raise ValueError('Registry manifest digest differs.')
    if 'size' in descriptor and len(data) != descriptor['size']:
        raise ValueError('Registry manifest size differs.')
    value = json.loads(data)
    if media not in MANIFESTS | INDEXES or value.get('mediaType', media) != media:
        raise ValueError('Registry manifest media type differs.')
    if 'mediaType' in descriptor and descriptor['mediaType'] != media:
        raise ValueError('Registry manifest descriptor type differs.')
    return data, media, value


def store(layout, data):
    path = layout / 'blobs/sha256' / hashlib.sha256(data).hexdigest()
    if not path.exists():
        with path.open('xb') as stream:
            stream.write(data)
    elif path.read_bytes() != data:
        raise ValueError('Existing blob differs.')


def blob(client, repo, descriptor, layout, budget):
    path = layout / 'blobs/sha256' / descriptor['digest'][7:]
    size = descriptor.get('size')
    if (not re.fullmatch(r'sha256:[a-f0-9]{64}', descriptor.get('digest', ''))
            or type(size) is not int or not 0 <= size <= BLOB_LIMIT or descriptor.get('urls')):
        raise ValueError('Unsupported blob descriptor.')
    if path.exists():
        return 0  # Already fetched and verified for another locked image.
    if size > budget:
        raise ValueError('Acquisition total limit.')
    partial = path.with_name(path.name + '.partial')
    digest, total = hashlib.sha256(), 0
    with client.open(REGISTRY + repo + '/blobs/' + descriptor['digest'], token=client.token(repo)) as response, \
            partial.open('xb') as stream:
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > size:
                raise ValueError('Registry blob exceeds descriptor size.')
            digest.update(chunk)
            stream.write(chunk)
    if total != size or 'sha256:' + digest.hexdigest() != descriptor['digest']:
        partial.unlink()
        raise ValueError('Registry blob digest differs.')
    partial.rename(path)
    return size


def acquire(lock, layout, client=None, resolve=socket.getaddrinfo):
    """Write exactly the locked roots and their unique linux/amd64 closure."""
    client = client or Client()
    layout = Path(layout).absolute()
    layout.mkdir(mode=0o700)
    (layout / 'blobs/sha256').mkdir(parents=True, mode=0o700)
    roots, documents, budget = [], {}, TOTAL_LIMIT
    for service, item in sorted(lock.items()):
        if item.get('platform') != 'linux/amd64':
            raise ValueError('Only locked linux/amd64 images are acquired.')
        repo, value = repository(item['image'])
        data, media, root = document(client, repo, {'digest': value}, ACCEPT)
        store(layout, data)
        roots.append({'mediaType': media, 'digest': value, 'size': len(data),
                      'annotations': {'org.opencontainers.image.ref.name': item['image']}})
        record = {'image': item['image'], 'root': value, 'root_media_type': media}
        manifest = root
        if media in INDEXES:
            children = [child for child in root.get('manifests', [])
                        if child.get('platform', {}).get('os') == 'linux'
                        and child.get('platform', {}).get('architecture') == 'amd64']
            if len(children) != 1 or children[0]['platform'] != {'os': 'linux', 'architecture': 'amd64'}:
                raise ValueError('Exactly one unambiguous linux/amd64 child required.')
            if children[0].get('mediaType') not in MANIFESTS:
                raise ValueError('Nested platform index refused.')
            data, _, manifest = document(client, repo, children[0], children[0]['mediaType'])
            store(layout, data)
            record['platform_manifest'] = children[0]['digest']
        config = manifest.get('config', {})
        if config.get('size', DOCUMENT_LIMIT + 1) > DOCUMENT_LIMIT:
            raise ValueError('Config descriptor too large.')
        for descriptor in [config, *manifest.get('layers', [])]:
            budget -= blob(client, repo, descriptor, layout, budget)
        record['config'] = config['digest']
        record['layers'] = [layer['digest'] for layer in manifest['layers']]
        documents[service] = record
    with (layout / 'oci-layout').open('x') as stream:
        json.dump({'imageLayoutVersion': '1.0.0'}, stream)
    with (layout / 'index.json').open('x') as stream:
        json.dump({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                   'manifests': roots}, stream, indent=2)
    # Every endpoint that served bytes becomes a literal-address denial probe later.
    addresses = {host: sorted({row[4][0] for row in resolve(host, 443, type=socket.SOCK_STREAM)})
                 for host in sorted(client.hosts)}
    return {'format': 1, 'registry': 'docker.io', 'images': documents, 'endpoints': addresses,
            'bytes': TOTAL_LIMIT - budget, 'status': 'ACQUIRED_NOT_TRANSPORTED'}

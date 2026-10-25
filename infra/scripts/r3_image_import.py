"""Registry-denied, empty-store import of the nine active images; no service starts.

Runs as root inside the loopback-only network namespace that r3_image_qualify.py
prepares. It extracts the pinned containerd/Engine binaries from hash-locked
packages, starts them on a NEW data root, observes the empty store, refuses one
controlled pull, imports only the nine active roots from the verified archive
and reads every identity back. Containers are created, never started, so the
engine materializes each rootfs: layers are decompressed and their diff IDs
validated at load, or at create at the latest.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_image_acquire import canonical
from r3_image_transport import ACTIVE, INDEXES, verify
from r3_noble_common import encoded, file_hash, read, run, write

ROOT = Path(__file__).resolve().parents[2]
NETNS = 'tonyai-r3-deny'
RESOLVER = '127.0.0.53'
RESOLV_CONF = b'nameserver 127.0.0.53\noptions timeout:1 attempts:1\n'
HOSTS = b'127.0.0.1 localhost\n::1 localhost\n'
NSSWITCH = b'passwd: files\ngroup: files\nshadow: files\nhosts: files dns\nnetworks: files\nprotocols: files\nservices: files\n'
ENGINE = '29.9.1'
# Package member -> extracted name. Only what the daemons and readback execute.
MEMBERS = {'containerd.io': {'usr/bin/containerd': 'containerd', 'usr/bin/ctr': 'ctr', 'usr/bin/runc': 'runc',
                             'usr/bin/containerd-shim-runc-v2': 'containerd-shim-runc-v2'},
           'docker-ce': {'usr/bin/dockerd': 'dockerd'},
           'docker-ce-cli': {'usr/bin/docker': 'docker'}}
PROBE_NAMES = ('registry-1.docker.io', 'auth.docker.io', 'index.docker.io', 'production.cloudflare.docker.com')
DAEMON_LOG_LIMIT = 32 * 1024 * 1024
UNREACHABLE = {101, 113, 99}  # ENETUNREACH, EHOSTUNREACH, EADDRNOTAVAIL on Linux.
REGISTRY_NAME = re.compile(r'(?:[a-z0-9-]+\.)*docker\.(?:io|com)\.?')


# ---- Pure checks (fixture-tested; no daemon or network) -------------------

def check_namespace(links, addresses, routes, inode, host_inode):
    """Loopback only: the denial is structural, not a firewall rule."""
    if inode == host_inode:
        raise ValueError('Still in the host network namespace.')
    if [(link.get('ifname'), link.get('link_type')) for link in links] != [('lo', 'loopback')]:
        raise ValueError('A non-loopback interface exists in the denied namespace.')
    for entry in addresses:
        for item in entry.get('addr_info', []):
            if item.get('local') not in ('127.0.0.1', '::1'):
                raise ValueError('Unexpected namespace address.')
    for route in routes:
        # The kernel's own loopback routes (including main-table ::1) stay on lo;
        # reject-type routes carry no packet anywhere.
        if route.get('type') in ('unreachable', 'prohibit', 'blackhole') and 'gateway' not in route:
            continue
        if route.get('dev') != 'lo' or route.get('dst') == 'default' or 'gateway' in route:
            raise ValueError('A forwarding route exists in the denied namespace.')
    return {'links': ['lo'], 'inode': inode, 'host_inode': host_inode}


def check_resolver_file(path, source, expected):
    """The namespace's file must BE the staged one, not merely equal bytes.

    `ip netns exec` bind-mounts /etc/netns/<ns>/<name> with mount(2), which follows
    Ubuntu's symlinked /etc/resolv.conf to the systemd stub; resolve it first.
    """
    target = os.path.realpath(path)
    seen, staged = os.stat(target), os.stat(source)
    if (seen.st_dev, seen.st_ino) != (staged.st_dev, staged.st_ino):
        raise ValueError('Namespace resolver file is not the staged bind mount.')
    if read(target) != expected or read(source) != expected:
        raise ValueError('Namespace resolver files differ.')
    return {'path': path, 'target': target}


def question(packet):
    if len(packet) < 12 or int.from_bytes(packet[4:6], 'big') != 1:
        raise ValueError('One DNS question required.')
    labels, offset = [], 12
    while True:
        if offset >= len(packet):
            raise ValueError('Truncated DNS question.')
        size = packet[offset]
        offset += 1
        if size == 0:
            break
        if size > 63 or offset + size > len(packet):
            raise ValueError('Compressed or oversized DNS label.')
        labels.append(packet[offset:offset + size].decode('ascii').lower())
        offset += size
    if offset + 4 > len(packet):
        raise ValueError('Truncated DNS question.')
    return '.'.join(labels), int.from_bytes(packet[offset:offset + 2], 'big'), offset + 4


def refused(packet):
    """REFUSED for every query; never an answer."""
    try:
        _, _, end = question(packet)
        body = packet[4:6] + b'\0' * 6 + packet[12:end]
    except Exception:
        body = b'\0' * 8
    return packet[:2] + bytes([0x80 | (packet[2] & 0x79) if len(packet) > 2 else 0x80, 0x05]) + body


def blob_digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def dns_violations(log):
    """Resolver use is allowed only inside the deliberate probe windows."""
    return [row for row in log if row['window'] == 'none']


def check_store(info, images, containers, volumes, content, names, expected=None):
    """expected None means empty; else exact nine roots, names and blob set."""
    status = {tuple(row) for row in info.get('DriverStatus') or []}
    if info.get('Driver') != 'overlayfs' or ('driver-type', 'io.containerd.snapshotter.v1') not in status:
        raise ValueError('The containerd image store is not active.')
    if info.get('RegistryConfig', {}).get('Mirrors') or info.get('HttpProxy') or info.get('HttpsProxy'):
        raise ValueError('Registry mirror or proxy configured.')
    if containers or volumes or info.get('Containers'):
        raise ValueError('Containers or volumes present.')
    if expected is None:
        if images or content or names or info.get('Images'):
            raise ValueError('Image store is not empty.')
        return {'images': 0, 'content': 0}
    if sorted(row['ID'] for row in images) != sorted(item['id'] for item in expected['images'].values()):
        raise ValueError('Image inventory differs from the nine roots.')
    if sorted(names) != sorted(item['name'] for item in expected['images'].values()):
        raise ValueError('Store image names differ from the canonical by-digest names.')
    if sorted(content) != sorted(expected['blobs']):
        raise ValueError('Content store differs from the nine-image closure.')
    return {'images': len(images), 'content': len(content)}


def check_image(inspect, item):
    """Docker API readback of one pinned reference in the containerd store."""
    if len(inspect) != 1:
        raise ValueError('One image per pinned reference required.')
    image = inspect[0]
    descriptor = image.get('Descriptor') or {}
    if (image.get('Id') != item['id'] or descriptor.get('digest') != item['id']
            or descriptor.get('mediaType') != item['media_type'] or descriptor.get('size') != item['size']):
        raise ValueError('Image target differs from the pinned root.')
    if set(image.get('RepoDigests') or []) != {item['image']} or image.get('RepoTags'):
        raise ValueError('Repository digest differs or a tag exists.')
    if (image.get('Os'), image.get('Architecture'), image.get('Variant', '')) != ('linux', 'amd64', ''):
        raise ValueError('Image platform differs.')
    if image.get('RootFS') != {'Type': 'layers', 'Layers': item['diff_ids']}:
        raise ValueError('Image diff IDs differ from the verified config.')
    return {'id': image['Id'], 'repo_digests': image['RepoDigests'], 'platform': 'linux/amd64'}


def check_created(container, item, name):
    state = container.get('State') or {}
    if (container.get('Name') != '/' + name or container.get('Image') != item['id']
            or (container.get('Config') or {}).get('Image') != item['image']
            or state.get('Status') != 'created' or state.get('Running') or state.get('Pid')
            or state.get('StartedAt') != '0001-01-01T00:00:00Z'):
        raise ValueError('Created container differs or was started.')
    return {'image': container['Image'], 'status': 'created', 'started': False}


def safe_extract(archive, destination):
    """Regular OCI files only; nothing else is written from the archive."""
    destination.mkdir(mode=0o700)
    (destination / 'blobs/sha256').mkdir(parents=True, mode=0o700)
    seen = set()
    with tarfile.open(archive, 'r:') as tar:
        for member in tar:
            if (not member.isfile() or member.name in seen
                    or not re.fullmatch(r'oci-layout|index\.json|blobs/sha256/[a-f0-9]{64}', member.name)):
                raise ValueError('Unexpected transport archive member.')
            seen.add(member.name)
            with tar.extractfile(member) as source, (destination / member.name).open('xb') as target:
                while chunk := source.read(1024 * 1024):
                    target.write(chunk)
    return seen


def subset(layout, destination, lock, analysis):
    """Copy only the nine roots' closure; verify it strictly before any import."""
    index = json.loads((layout / 'index.json').read_bytes())
    wanted = {lock[name]['image'] for name in ACTIVE}
    roots = [entry for entry in index['manifests']
             if entry['annotations']['org.opencontainers.image.ref.name'] in wanted]
    if len(roots) != len(ACTIVE):
        raise ValueError('Nine active roots required.')
    destination.mkdir(mode=0o700)
    (destination / 'blobs/sha256').mkdir(parents=True, mode=0o700)
    blobs = set()
    for name in ACTIVE:
        item = analysis['images'][name]
        blobs.update({item['image'].split('@')[1], item['platform_manifest_digest'], item['config_digest'], *item['layers']})
    for value in sorted(blobs):
        with (layout / 'blobs/sha256' / value[7:]).open('rb') as source, \
                (destination / 'blobs/sha256' / value[7:]).open('xb') as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
    write(destination / 'oci-layout', (layout / 'oci-layout').read_bytes())
    write(destination / 'index.json', encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json',
                                               'manifests': sorted(roots, key=lambda e: e['digest'])}))
    nine = {name: lock[name] for name in ACTIVE}
    images, names, _ = verify(destination, nine)
    if images != {name: analysis['images'][name] for name in sorted(ACTIVE)}:
        raise ValueError('Nine-image subset differs from the transport analysis.')
    return roots, sorted(blobs), names


def load_archive(destination, roots, layout, names):
    """Deterministic load tar. Only index.json differs from the verified subset:
    each root also carries the canonical name a by-digest pull would record."""
    index = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [
        {**root, 'annotations': {**root['annotations'], 'io.containerd.image.name':
                                 canonical(root['annotations']['org.opencontainers.image.ref.name'])}}
        for root in sorted(roots, key=lambda e: e['digest'])]}
    index_bytes = encoded(index)
    with destination.open('xb') as stream, tarfile.open(fileobj=stream, mode='w') as tar:
        for name in sorted(names):
            data = index_bytes if name == 'index.json' else None
            info = tarfile.TarInfo(name)
            info.mode, info.mtime = 0o600, 0
            if data is not None:
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            else:
                path = layout / name
                info.size = path.stat().st_size
                with path.open('rb') as source:
                    tar.addfile(info, source)
    return index


def expected_images(lock, analysis, configs):
    images = {}
    for name in sorted(ACTIVE):
        item = analysis['images'][name]
        root = item['image'].split('@')[1]
        images[name] = {'image': lock[name]['image'], 'id': root, 'name': canonical(lock[name]['image']),
                        'media_type': configs[name]['root_media_type'], 'size': configs[name]['root_size'],
                        'config': item['config_digest'], 'diff_ids': configs[name]['diff_ids']}
    return images


def closure_documents(layout, analysis):
    """Root size/media and verified config diff IDs, read from the checked layout."""
    index = json.loads((layout / 'index.json').read_bytes())
    by_ref = {e['annotations']['org.opencontainers.image.ref.name']: e for e in index['manifests']}
    result = {}
    for name in ACTIVE:
        item = analysis['images'][name]
        root = by_ref[item['image']]
        config = json.loads((layout / 'blobs/sha256' / item['config_digest'][7:]).read_bytes())
        result[name] = {'root_media_type': root['mediaType'], 'root_size': root['size'],
                        'diff_ids': config['rootfs']['diff_ids']}
    return result


# ---- Resolver observer ----------------------------------------------------

class Resolver:
    """Loopback DNS observer: logs every question with its window, answers REFUSED."""

    def __init__(self, address=RESOLVER, port=53):
        self.window, self.log, self.lock, self.closed = 'none', [], threading.Lock(), False
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind((address, port))
        self.address = self.udp.getsockname()
        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.tcp.bind(self.address)
        self.tcp.listen(16)
        for target in (self.serve_udp, self.serve_tcp):
            threading.Thread(target=target, daemon=True).start()

    def record(self, packet, transport):
        try:
            name, kind, _ = question(packet)
        except Exception:
            name, kind = '<malformed>', None
        with self.lock:
            self.log.append({'window': self.window, 'transport': transport, 'name': name, 'type': kind,
                             'monotonic': time.monotonic()})
        return refused(packet)

    def serve_udp(self):
        while not self.closed:
            try:
                packet, peer = self.udp.recvfrom(4096)
                self.udp.sendto(self.record(packet, 'udp'), peer)
            except OSError:
                return

    def serve_tcp(self):
        while not self.closed:
            try:
                connection, _ = self.tcp.accept()
            except OSError:
                return
            with connection:
                connection.settimeout(2)
                try:
                    size = int.from_bytes(connection.recv(2), 'big')
                    packet = connection.recv(min(size, 4096))
                    reply = self.record(packet, 'tcp')
                    connection.sendall(len(reply).to_bytes(2, 'big') + reply)
                except OSError:
                    pass

    def snapshot(self):
        with self.lock:
            return list(self.log)

    def close(self):
        self.closed = True
        self.udp.close()
        self.tcp.close()


# ---- Session --------------------------------------------------------------

class Session:
    """One import attempt. Tests replace command/spawn/probe seams with fakes."""

    def __init__(self, request, evidence):
        self.request, self.evidence = request, evidence
        self.phase, self.daemons, self.resolver = 'request', {}, None
        work = Path(request['work'])
        self.bin, self.run_dir = work / 'bin', Path(request['run_dir'])
        self.docker_socket = self.run_dir / 'docker.sock'
        self.containerd_socket = self.run_dir / 'containerd.sock'

    # Seams ---------------------------------------------------------------
    def command(self, argv, label, timeout=300, limit=8 * 1024 * 1024):
        return run(argv, self.evidence, label, timeout=timeout, limit=limit)

    def spawn(self, argv, label, env):
        log = (self.evidence / (label + '.log')).open('xb')
        return subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env)

    def probe_name(self, name):
        try:
            socket.getaddrinfo(name, 443, type=socket.SOCK_STREAM)
        except socket.gaierror as exc:
            return {'name': name, 'resolved': False, 'error': exc.errno}
        return {'name': name, 'resolved': True}

    def probe_address(self, address):
        family = socket.AF_INET6 if ':' in address else socket.AF_INET
        with socket.socket(family, socket.SOCK_STREAM) as stream:
            stream.settimeout(3)
            try:
                stream.connect((address, 443))
            except OSError as exc:
                return {'address': address, 'connected': False, 'errno': exc.errno}
        return {'address': address, 'connected': True}

    def start_resolver(self):
        return Resolver()

    def resolver_file(self, name, expected):
        return check_resolver_file('/etc/' + name, '/etc/netns/' + NETNS + '/' + name, expected)

    def namespace_inodes(self):
        return os.stat('/proc/self/ns/net').st_ino, os.stat('/proc/1/ns/net').st_ino

    def process_namespace(self, pid):
        return os.stat(f'/proc/{pid}/ns/net').st_ino, os.path.realpath(f'/proc/{pid}/exe')

    def fsys_tarfile(self, deb, target):
        # Package payloads go to the work tree, never into the sealed evidence.
        with target.open('xb') as stream:
            subprocess.run(['dpkg-deb', '--fsys-tarfile', str(deb)], stdin=subprocess.DEVNULL, stdout=stream,
                           stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, check=True, timeout=120)

    def mount_cgroup(self):
        # `ip netns exec` remounts /sys; restore cgroup2 only in this private mount namespace.
        self.command(['mount', '-t', 'cgroup2', 'cgroup2', '/sys/fs/cgroup'], 'cgroup-mount')

    # Helpers -------------------------------------------------------------
    def docker(self, *args, label, timeout=300):
        return self.command([str(self.bin / 'docker'), '--config', str(Path(self.request['work']) / 'cli'),
                             '--host', 'unix://' + str(self.docker_socket), *args], label, timeout)

    def ctr(self, *args, label):
        return self.command([str(self.bin / 'ctr'), '--address', str(self.containerd_socket), '--namespace', 'moby',
                             *args], label)

    def lines(self, data):
        return [line for line in data.decode().splitlines() if line.strip()]

    def json_lines(self, data):
        return [json.loads(line) for line in self.lines(data)]

    def at(self, phase):
        self.phase = phase
        write(self.evidence / ('phase-' + str(len(list(self.evidence.glob('phase-*')))).zfill(2) + '.json'),
              encoded({'phase': phase, 'monotonic': time.monotonic()}))

    def observe_namespace(self, label):
        links = json.loads(self.command(['ip', '-j', '-d', 'link', 'show'], label + '-links'))
        addresses = json.loads(self.command(['ip', '-j', 'address', 'show'], label + '-addresses'))
        routes = (json.loads(self.command(['ip', '-j', '-4', 'route', 'show', 'table', 'all'], label + '-routes4'))
                  + json.loads(self.command(['ip', '-j', '-6', 'route', 'show', 'table', 'all'], label + '-routes6')))
        inode, host = self.namespace_inodes()
        return check_namespace(links, addresses, routes, inode, host)

    def store_state(self, label, expected=None):
        info = json.loads(self.docker('info', '--format', '{{json .}}', label=label + '-info'))
        images = self.json_lines(self.docker('image', 'ls', '--all', '--no-trunc', '--digests', '--format', '{{json .}}',
                                             label=label + '-images'))
        containers = self.lines(self.docker('container', 'ls', '--all', '--quiet', '--no-trunc', label=label + '-containers'))
        volumes = self.lines(self.docker('volume', 'ls', '--quiet', label=label + '-volumes'))
        content = [line.split()[0] for line in self.lines(self.ctr('content', 'ls', '--quiet', label=label + '-content'))]
        names = self.lines(self.ctr('images', 'ls', '--quiet', label=label + '-names'))
        return check_store(info, images, containers, volumes, content, names, expected)

    def extract_toolchain(self, lock):
        self.bin.mkdir(mode=0o755)
        hashes = {}
        packages = {item['name']: item for item in lock['packages']}
        for package, members in MEMBERS.items():
            item = packages[package]
            deb = Path(self.request['packages']) / item['url'].rsplit('/', 1)[1]
            if file_hash(deb) != item['sha256']:
                raise ValueError('Pinned package digest differs.')
            payload = Path(self.request['work']) / (package + '.tar')
            self.fsys_tarfile(deb, payload)
            found = set()
            with tarfile.open(payload, mode='r:') as tar:
                for member in tar:
                    name = member.name.removeprefix('./')
                    if name in members:
                        if not member.isfile() or name in found:
                            raise ValueError('Unexpected package member type.')
                        found.add(name)
                        target = self.bin / members[name]
                        write(target, tar.extractfile(member).read())
                        target.chmod(0o755)
                        hashes[members[name]] = file_hash(target)
            if found != set(members):
                raise ValueError('Pinned package member missing.')
        return hashes

    def start_daemons(self):
        work = Path(self.request['work'])
        env = {'PATH': str(self.bin) + ':/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C', 'LC_ALL': 'C'}
        config = work / 'containerd.toml'
        write(config, '\n'.join([
            'version = 3', f'root = "{work}/containerd-root"', f'state = "{self.run_dir}/containerd-state"',
            # CRI is unused; its image service must not exist beside the moby namespace.
            'disabled_plugins = ["io.containerd.grpc.v1.cri", "io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime"]',
            '[grpc]', f'  address = "{self.containerd_socket}"',
            '[ttrpc]', f'  address = "{self.containerd_socket}.ttrpc"',
            '[debug]', f'  address = "{self.run_dir}/containerd-debug.sock"', '  level = "info"', '']).encode())
        policy = json.loads(read(ROOT / 'infra/selfhost/daemon.r02.json'))
        # r02 keys, minus firewall-backend: no container networking exists in this run.
        daemon = {**{k: v for k, v in policy.items() if k != 'firewall-backend'},
                  'data-root': str(work / 'docker-root'), 'exec-root': str(self.run_dir / 'docker-exec'),
                  'pidfile': str(self.run_dir / 'docker.pid'), 'hosts': ['unix://' + str(self.docker_socket)],
                  'containerd': str(self.containerd_socket), 'bridge': 'none', 'iptables': False,
                  'ip6tables': False, 'userland-proxy': False, 'debug': True,
                  'registry-mirrors': [], 'insecure-registries': []}
        write(work / 'daemon.json', encoded(daemon))
        write(self.evidence / 'daemon.json', encoded(daemon))
        write(self.evidence / 'containerd.toml', read(config))
        if any((work / name).exists() for name in ('docker-root', 'containerd-root')):
            raise ValueError('Store directories must be new.')
        self.daemons['containerd'] = self.spawn([str(self.bin / 'containerd'), '--config', str(config)], 'containerd', env)
        self.wait(lambda n: self.ctr('version', label=f'containerd-ready-{n:03d}'), 'containerd')
        self.daemons['dockerd'] = self.spawn([str(self.bin / 'dockerd'), '--config-file', str(work / 'daemon.json')], 'dockerd', env)
        self.wait(lambda n: self.docker('version', '--format', '{{json .}}', label=f'dockerd-ready-{n:03d}'), 'dockerd')
        own = self.namespace_inodes()[0]
        for name, child in self.daemons.items():
            inode, exe = self.process_namespace(child.pid)
            if inode != own or exe != str(self.bin / name):
                raise ValueError('Daemon is outside the denied namespace or not the pinned binary.')
        return daemon

    def wait(self, ready, label, deadline=60):
        stop = time.monotonic() + deadline
        for attempt in range(1, deadline * 2):
            if self.daemons[label].poll() is not None:
                raise ValueError('Daemon exited during start.')
            try:
                return ready(attempt)  # Each attempt keeps its own numbered evidence.
            except ValueError:
                if time.monotonic() >= stop:
                    raise
                time.sleep(1)
        raise ValueError('Daemon readiness deadline.')

    def stop_daemons(self):
        result = {}
        for name in ('dockerd', 'containerd'):
            child = self.daemons.get(name)
            if child is None:
                continue
            if child.poll() is None:
                child.send_signal(signal.SIGTERM)
                try:
                    child.wait(60)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(10)
                    result[name] = 'killed'
                    continue
            result[name] = child.returncode
        for name in self.daemons:
            path = self.evidence / (name + '.log')
            if path.exists() and path.stat().st_size > DAEMON_LOG_LIMIT:
                os.truncate(path, DAEMON_LOG_LIMIT)
                result[name + '_log_truncated'] = True
        return result

    # Flow ----------------------------------------------------------------
    def execute(self):
        request, result = self.request, {'format': 1, 'status': 'REFUSED', 'qa_ready': False}
        lock = json.loads(read(ROOT / 'infra/selfhost/images.qa.lock.json'))['services']
        work = Path(request['work'])
        try:
            self.at('namespace-before')
            result['namespace_before'] = self.observe_namespace('namespace-before')
            result['resolver_files'] = [self.resolver_file(name, expected) for name, expected in
                                        (('resolv.conf', RESOLV_CONF), ('hosts', HOSTS), ('nsswitch.conf', NSSWITCH))]
            self.at('resolver')
            self.resolver = self.start_resolver()
            self.at('denial-probes')
            self.resolver.window = 'probe-name'
            names = [self.probe_name(name) for name in sorted({*PROBE_NAMES, *request['endpoints']})]
            self.resolver.window = 'probe-address'
            addresses = [self.probe_address(a) for v in request['endpoints'].values() for a in v]
            self.resolver.window = 'none'
            observed = {row['name'] for row in self.resolver.snapshot() if row['window'] == 'probe-name'}
            if (any(row['resolved'] for row in names) or {row['name'] for row in names} - observed
                    or any(row['connected'] or row['errno'] not in UNREACHABLE for row in addresses)):
                raise ValueError('Registry denial not proven before import.')
            result['denial_probes'] = {'names': names, 'addresses': addresses}
            self.at('archive')
            analysis = json.loads(read(request['analysis']))
            if (file_hash(request['analysis']) != request['analysis_sha256']
                    or file_hash(request['archive']) != analysis['archive_sha256']
                    or analysis['image_lock_sha256'] != file_hash(ROOT / 'infra/selfhost/images.qa.lock.json')):
                raise ValueError('Archive or analysis binding differs.')
            layout = work / 'layout'
            safe_extract(Path(request['archive']), layout)
            images, _, _ = verify(layout, lock)
            if images != analysis['images']:
                raise ValueError('Re-verified archive differs from its analysis.')
            self.at('subset')
            roots, blobs, names = subset(layout, work / 'nine', lock, analysis)
            index = load_archive(work / 'nine.oci.tar', roots, work / 'nine', names)
            expected = {'images': expected_images(lock, analysis, closure_documents(layout, analysis)), 'blobs': blobs}
            write(self.evidence / 'load-index.json', encoded(index))
            write(self.evidence / 'expected.json', encoded(expected))
            result['load_archive_sha256'] = file_hash(work / 'nine.oci.tar')
            self.at('toolchain')
            result['binaries'] = self.extract_toolchain(json.loads(read(ROOT / 'infra/selfhost/r3-toolchain.lock.json')))
            self.mount_cgroup()
            (work / 'cli').mkdir(mode=0o700)
            self.run_dir.mkdir(mode=0o700)
            self.at('daemon-start')
            self.start_daemons()
            version = json.loads(self.docker('version', '--format', '{{json .}}', label='version'))
            if version['Client']['Version'] != ENGINE or version['Server']['Version'] != ENGINE:
                raise ValueError('Pinned Engine version differs.')
            result['engine'] = {'client': ENGINE, 'server': ENGINE,
                                'components': {c['Name']: c['Version'] for c in version['Server'].get('Components', [])}}
            self.at('store-before')
            result['store_before'] = self.store_state('store-before')
            self.at('daemon-probe')
            self.resolver.window = 'probe-daemon'
            try:
                self.docker('pull', '--platform', 'linux/amd64', lock['caddy']['image'], label='daemon-probe', timeout=120)
            except (ValueError, TimeoutError):
                pulled = False  # A refused or hung pull; the observed question below proves which path.
            else:
                pulled = True
            self.resolver.window = 'none'
            asked = {row['name'].rstrip('.') for row in self.resolver.snapshot() if row['window'] == 'probe-daemon'}
            if pulled or not any(REGISTRY_NAME.fullmatch(name) for name in asked):
                raise ValueError('Daemon registry path was not observed refused.')
            result['daemon_probe'] = {'pulled': False, 'resolver_questions': sorted(asked)}
            result['store_after_probe'] = self.store_state('store-after-probe')
            self.at('import')
            self.docker('load', '--platform', 'linux/amd64', '--input', str(work / 'nine.oci.tar'), label='import', timeout=900)
            self.at('readback')
            readback = {}
            for name, item in expected['images'].items():
                inspect = json.loads(self.docker('image', 'inspect', item['image'], label='inspect-' + name))
                readback[name] = check_image(inspect, item)
                root = self.ctr('content', 'get', item['id'], label='content-root-' + name)
                manifest = json.loads(root)
                if blob_digest(root) != item['id']:
                    raise ValueError('Stored root bytes differ.')
                if item['media_type'] in INDEXES:
                    child = analysis['images'][name]['platform_manifest_digest']
                    data = self.ctr('content', 'get', child, label='content-platform-' + name)
                    if blob_digest(data) != child:
                        raise ValueError('Stored platform manifest differs.')
                    manifest = json.loads(data)
                config = self.ctr('content', 'get', item['config'], label='content-config-' + name)
                if (manifest['config']['digest'] != item['config']
                        or blob_digest(config) != item['config']
                        or json.loads(config)['rootfs']['diff_ids'] != item['diff_ids']):
                    raise ValueError('Stored config differs from the pin closure.')
                readback[name]['config_digest'] = item['config']
            policy = json.loads(read(ROOT / 'infra/selfhost/database-image-policy.json'))
            if lock['db']['image'] != policy['image'] or readback['db']['config_digest'] != policy['config_digest']:
                raise ValueError('Database image policy differs.')
            result['images'] = readback
            result['store_after_import'] = self.store_state('store-after-import', expected)
            self.at('excluded')
            for name in sorted(set(lock) - ACTIVE):
                try:
                    self.docker('image', 'inspect', lock[name]['image'], label='excluded-' + name)
                except ValueError:
                    continue
                raise ValueError('An inactive service image is present.')
            self.at('materialize')
            created = {}
            for name, item in expected['images'].items():
                container = 'tonyai-r3-transport-' + name
                identifier = self.docker('create', '--pull', 'never', '--platform', 'linux/amd64', '--network', 'none',
                                         '--name', container, item['image'], label='create-' + name).decode().strip()
                try:
                    created[name] = check_created(json.loads(self.docker(
                        'container', 'inspect', identifier, label='created-' + name))[0], item, container)
                finally:
                    self.docker('container', 'rm', '--volumes', identifier, label='remove-' + name)
            result['materialized'] = created
            result['store_final'] = self.store_state('store-final', expected)
            self.at('namespace-after')
            result['namespace_after'] = self.observe_namespace('namespace-after')
            if result['namespace_after']['inode'] != result['namespace_before']['inode']:
                raise ValueError('Namespace changed during the run.')
            violations = dns_violations(self.resolver.snapshot())
            if violations:
                raise ValueError('Resolver used outside the probe windows.')
            result['status'] = 'TRANSPORT_IDENTITY_PASS'
        except BaseException as exc:
            result['failure'] = {'phase': self.phase, 'type': type(exc).__name__, 'message': str(exc)[:500]}
            result['status'] = 'REFUSED'
        finally:
            try:
                # Exit codes are recorded; only a daemon that ignored SIGTERM refuses the run.
                result['daemon_stop'] = self.stop_daemons()
                if 'killed' in result['daemon_stop'].values():
                    result['status'] = 'REFUSED'
            except Exception as exc:
                result.update(status='REFUSED', daemon_stop={'error': type(exc).__name__})
            if self.resolver is not None:
                result['resolver_log'] = self.resolver.snapshot()
                self.resolver.close()
            result['phase'] = self.phase
            result['unproven'] = [
                'Nine-service --pull never --no-build startup from the transported store under the reviewed composition',
                'Pinned Compose 5.6.0 rendering and r02 daemon store activation on the exact target',
                'Exact r02 OS dependency closure and installer lifecycle (separate gate)']
            write(self.evidence / 'result.json', encoded(result))
        return result


def load_request(path):
    request = json.loads(read(path))
    keys = {'work', 'run_dir', 'archive', 'analysis', 'analysis_sha256', 'packages', 'endpoints', 'owner'}
    if set(request) != keys:
        raise ValueError('Unexpected import request.')
    owner = request['owner']
    if not isinstance(owner, list) or len(owner) != 2 or any(type(v) is not int or v <= 0 for v in owner):
        raise ValueError('Unprivileged evidence owner required.')
    for key in ('work', 'run_dir', 'archive', 'analysis', 'packages'):
        if not Path(request[key]).is_absolute():
            raise ValueError('Absolute request paths required.')
    if not re.fullmatch('[a-f0-9]{64}', request['analysis_sha256']):
        raise ValueError('Analysis digest required.')
    if (not isinstance(request['endpoints'], dict) or not request['endpoints']
            or any(not isinstance(v, list) or not v for v in request['endpoints'].values())):
        raise ValueError('Observed registry endpoints required.')
    return request


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request')
    parser.add_argument('evidence')
    args = parser.parse_args(argv)
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit('FAIL: the isolated import runs as root inside the denied namespace.')
    evidence = Path(args.evidence)
    evidence.mkdir(mode=0o700)
    request = load_request(args.request)
    Path(request['work']).mkdir(mode=0o700)
    try:
        result = Session(request, evidence).execute()
    finally:
        # The unprivileged controller seals this directory; the store itself stays root-owned.
        uid, gid = request['owner']
        for path in [evidence, *evidence.rglob('*')]:
            os.chown(path, uid, gid, follow_symlinks=False)
    print('PASS' if result['status'] == 'TRANSPORT_IDENTITY_PASS' else 'REFUSED: see sealed evidence.')
    return 0 if result['status'] == 'TRANSPORT_IDENTITY_PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))

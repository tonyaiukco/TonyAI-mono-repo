"""Snap alias evidence (format 2). Temporary trees only; the host's real snap is never read."""
import ast
import copy
import errno
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from test_r3_policy_evidence import (BINDING, META, apt_scope, unit_scope, command, release_record,
    document, document_v2, snap_record, capture, evidence, validator, scope, snap, encoded, digest)


class Tree:
    """`<root>/usr/bin/snap -> ../lib/snapd/snapd` with a regular target, by default."""
    def __init__(self, test, link=snap.LINK.decode(), body=b'snapd-binary'):
        self.tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / 'usr/bin').mkdir(parents=True)
        (self.root / 'usr/lib/snapd').mkdir(parents=True)
        self.target = self.root / 'usr/lib/snapd/snapd'
        self.target.write_bytes(body)
        self.alias = self.root / 'usr/bin/snap'
        if link is not None:
            self.alias.symlink_to(link)
        self.opened = []
        real_open = os.open
        def tracking(name, *args, **kwargs):
            self.opened.append(name)
            if name in ('snap', b'snap') and self.alias.is_symlink():
                raise AssertionError('alias link opened')
            return real_open(name, *args, **kwargs)
        for item in (patch.object(snap, 'ALIAS_PARENT', str(self.root / 'usr/bin')),
                     patch.object(snap, 'TARGET_PARENT', str(self.root / 'usr/lib/snapd')),
                     patch.object(snap.os, 'open', side_effect=tracking)):
            item.start()
            test.addCleanup(item.stop)

    def run(self, deadline=None):
        return snap.operation(lambda: snap.observe(time.monotonic() + 60 if deadline is None else deadline))


def fds():
    return len(os.listdir('/dev/fd'))


class Observe(unittest.TestCase):
    def test_known_alias_hashes_the_fixed_target_without_opening_the_alias(self):
        tree = Tree(self)
        before = fds()
        result = tree.run()
        self.assertEqual(fds(), before)
        self.assertEqual(result['state'], 'ok')
        value = result['value']
        self.assertEqual((value['kind'], value['alias']['link']), ('known-alias', '../lib/snapd/snapd'))
        self.assertEqual((value['target']['bytes'], value['target']['sha256']), (12, digest(b'snapd-binary')))
        self.assertIn('snapd', tree.opened)
        self.assertNotIn('snap', tree.opened)
        # A temporary tree is user-owned: valid schema, but not complete evidence.
        self.assertIs(snap.validate_record(value, validator.file_record), os.getuid() == 0)

    def test_other_links_never_reach_the_target(self):
        for link in ('../lib/snapd/snapd ', '/usr/lib/snapd/snapd', '../lib/snapd/other', 'snapd', '../../etc/shadow'):
            with self.subTest(link=link):
                tree = Tree(self, link)
                self.assertEqual(tree.run(), {'state': 'error', 'error': 'UNEXPECTED_ALIAS'})
                self.assertNotIn('snapd', tree.opened)
        tree = Tree(self)
        with patch.object(snap, 'LINK_LIMIT', 4):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'UNEXPECTED_ALIAS'})
        self.assertNotIn('snapd', tree.opened)

    def test_absent_and_regular_aliases_stay_explicit(self):
        tree = Tree(self, None)
        value = tree.run()['value']
        self.assertEqual((value['kind'], set(value['alias'])), ('absent', {'parent'}))
        tree.alias.write_bytes(b'#!/bin/sh\n')
        value = tree.run()['value']
        self.assertEqual(value['kind'], 'regular')
        self.assertEqual(value['file']['sha256'], digest(b'#!/bin/sh\n'))
        self.assertNotIn('snapd', tree.opened)

    def test_fifo_alias_and_unsafe_targets_refuse_without_hashes(self):
        tree = Tree(self, None)
        os.mkfifo(tree.alias)
        self.assertEqual(tree.run(), {'state': 'error', 'error': 'UNSUPPORTED_TYPE'})
        tree = Tree(self)
        os.link(tree.target, tree.root / 'usr/lib/snapd/second')
        self.assertEqual(tree.run(), {'state': 'error', 'error': 'TARGET_UNSAFE'})
        tree = Tree(self)
        tree.target.unlink(); os.mkfifo(tree.target)
        self.assertEqual(tree.run(), {'state': 'error', 'error': 'TARGET_UNSAFE'})
        tree = Tree(self)
        tree.target.unlink(); tree.target.symlink_to('/etc/hosts')
        result = tree.run()
        self.assertEqual((result['error'], result['context']['stage'], result['context']['errno']),
                         ('OSError', 'open-target', errno.ELOOP))
        self.assertNotIn(b'/etc/hosts', encoded(result))

    def test_symlinked_parents_refuse(self):
        tree = Tree(self)
        moved = tree.root / 'usr/lib/real-snapd'
        (tree.root / 'usr/lib/snapd').rename(moved)
        (tree.root / 'usr/lib/snapd').symlink_to(moved)
        result = tree.run()
        self.assertEqual((result['error'], result['context']['stage']), ('OSError', 'resolve-parent'))

    def test_size_cap_before_and_during_the_read(self):
        tree = Tree(self, body=b'x' * 32)
        with patch.object(snap, 'TARGET_LIMIT', 16):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'TARGET_LIMIT'})
        tree = Tree(self, body=b'x' * 8)
        real_read = os.read
        grown = []
        def grow(fd, size):
            block = real_read(fd, size)
            if block and not grown:
                grown.append(1)
                with open(tree.target, 'ab') as handle:
                    handle.write(b'more')
            return block
        with patch.object(snap.os, 'read', side_effect=grow):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_alias_or_parent_drift_during_the_target_read_is_refused(self):
        for change in ('relink', 'parent'):
            with self.subTest(change=change):
                tree = Tree(self)
                real_target = snap.target
                def changing(deadline):
                    value = real_target(deadline)
                    if change == 'relink':
                        tree.alias.unlink(); tree.alias.symlink_to(snap.LINK.decode())
                    else:
                        # Flip one bit so the change holds whatever the process umask was.
                        path = tree.root / 'usr/bin'
                        os.chmod(path, (os.stat(path).st_mode & 0o7777) ^ 0o010)
                    return value
                with patch.object(snap, 'target', side_effect=changing):
                    self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_target_parent_mode_or_rename_swap_during_the_read_is_refused(self):
        for change in ('mode', 'rename'):
            with self.subTest(change=change):
                tree = Tree(self, body=b'x' * 8)
                parent = tree.root / 'usr/lib/snapd'
                real_read, done = os.read, []
                def swap(fd, size):
                    block = real_read(fd, size)
                    if not done:
                        done.append(1)
                        if change == 'mode':
                            os.chmod(parent, (os.stat(parent).st_mode & 0o7777) ^ 0o010)
                        else:
                            parent.rename(tree.root / 'usr/lib/snapd-old')
                            parent.mkdir(); (parent / 'snapd').write_bytes(b'y' * 8)
                    return block
                with patch.object(snap.os, 'read', side_effect=swap):
                    self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_alias_link_bytes_must_read_back_unchanged(self):
        # A real symlink cannot be rewritten in place; this pins the byte comparison itself.
        tree = Tree(self)
        real_readlink, reads = os.readlink, []
        def drifting(name, *args, **kwargs):
            reads.append(1)
            value = real_readlink(name, *args, **kwargs)
            return value if len(reads) == 1 else b'../lib/snapd/other'
        with patch.object(snap.os, 'readlink', side_effect=drifting):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})
        self.assertGreater(len(reads), 1)

    def test_alias_parent_rename_swap_is_refused(self):
        tree = Tree(self)
        real_target = snap.target
        def swapping(deadline):
            value = real_target(deadline)
            bin_dir = tree.root / 'usr/bin'
            bin_dir.rename(tree.root / 'usr/bin-old')
            bin_dir.mkdir(); (bin_dir / 'snap').symlink_to(snap.LINK.decode())
            return value
        with patch.object(snap, 'target', side_effect=swapping):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_regular_alias_vanishing_replaced_or_swapped_parent_is_refused(self):
        real_leaf = snap.leaf
        def run_with(tree, action):
            def acting(*args):
                action(tree)
                return real_leaf(*args)
            with patch.object(snap, 'leaf', side_effect=acting):
                return tree.run()
        def vanish(tree):
            tree.alias.unlink()
        def replace(tree):
            tree.alias.unlink(); tree.alias.write_bytes(b'#!/bin/sh\n')
        def swap(tree):
            bin_dir = tree.root / 'usr/bin'
            bin_dir.rename(tree.root / 'usr/bin-old')
            bin_dir.mkdir(); (bin_dir / 'snap').write_bytes(b'#!/bin/sh\n')
        for action, expected in ((vanish, 'OSError'), (replace, 'CHANGED'), (swap, 'CHANGED')):
            with self.subTest(action=action.__name__):
                tree = Tree(self, None)
                tree.alias.write_bytes(b'#!/bin/sh\n')
                self.assertEqual(run_with(tree, action)['error'], expected)

    def test_regular_alias_replaced_after_the_read_is_refused_by_the_reopened_check(self):
        tree = Tree(self, None)
        tree.alias.write_bytes(b'#!/bin/sh\n')
        real_leaf = snap.leaf
        def replaced(*args):
            result = real_leaf(*args)
            tree.alias.unlink(); tree.alias.write_bytes(b'#!/bin/sh\n')
            return result
        with patch.object(snap, 'leaf', side_effect=replaced):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_parent_rename_swap_is_refused_by_the_directory_identity_alone(self):
        # With every leaf comparison disabled, only the reopened chain's device/inode check sees the swap.
        for regular in (True, False):
            with self.subTest(regular=regular):
                tree = Tree(self, None if regular else snap.LINK.decode())
                if regular:
                    tree.alias.write_bytes(b'#!/bin/sh\n')
                parent = tree.root / ('usr/bin' if regular else 'usr/lib/snapd')
                real_leaf = snap.leaf
                def swapped(*args):
                    result = real_leaf(*args)
                    parent.rename(parent.with_name(parent.name + '-old'))
                    parent.mkdir()
                    return result
                with patch.object(snap, 'leaf', side_effect=swapped), patch.object(capture, 'same'):
                    self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_regular_alias_parent_mode_change_during_the_read_is_refused(self):
        tree = Tree(self, None)
        tree.alias.write_bytes(b'#!/bin/sh\n')
        real_leaf = snap.leaf
        def loosened(*args):
            bin_dir = tree.root / 'usr/bin'
            os.chmod(bin_dir, (os.stat(bin_dir).st_mode & 0o7777) ^ 0o020)
            return real_leaf(*args)
        with patch.object(snap, 'leaf', side_effect=loosened):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'CHANGED'})

    def test_regular_alias_is_streamed_under_the_target_cap(self):
        # Older snapd ships /usr/bin/snap as the binary itself, larger than the shared 8 MiB reader allows.
        tree = Tree(self, None)
        body = b'y' * (capture.LIMIT + 1)
        tree.alias.write_bytes(body)
        result = tree.run()
        self.assertEqual(result['state'], 'ok')
        value = result['value']
        self.assertEqual((value['format'], value['kind']), (2, 'regular'))
        self.assertEqual(value['file'], {**capture.metadata(os.stat(tree.alias)), 'bytes': len(body), 'sha256': digest(body)})
        self.assertIn('snap', tree.opened)
        with patch.object(snap, 'TARGET_LIMIT', 16):
            self.assertEqual(tree.run(), {'state': 'error', 'error': 'REGULAR_LIMIT'})

    def test_regular_alias_with_more_links_is_refused(self):
        tree = Tree(self, None)
        tree.alias.write_bytes(b'#!/bin/sh\n')
        os.link(tree.alias, tree.root / 'usr/bin/snap-second')
        self.assertEqual(tree.run(), {'state': 'error', 'error': 'REGULAR_UNSAFE'})

    def test_plain_value_errors_keep_the_class_name_and_drift_keeps_its_code(self):
        self.assertEqual(snap.operation(lambda: (_ for _ in ()).throw(ValueError('CHANGED'))), {'state': 'error', 'error': 'CHANGED'})
        self.assertEqual(snap.operation(lambda: (_ for _ in ()).throw(ValueError('other'))), {'state': 'error', 'error': 'ValueError'})
        self.assertEqual(snap.operation(lambda: (_ for _ in ()).throw(ValueError('CHANGED', 'x'))), {'state': 'error', 'error': 'ValueError'})
        self.assertEqual(snap.operation(lambda: b'\xff'.decode('ascii')), {'state': 'error', 'error': 'UnicodeError'})

    def test_recheck_keeps_the_primary_error_and_the_outer_deadline(self):
        tree = Tree(self)
        held = os.open(tree.root / 'usr/bin', os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, held)
        real_close, checked = os.close, []
        def close_then_fail(fd):
            real_close(fd)
            if checked:
                raise OSError(errno.EBADF, 'private')
        def deadline(_fd):
            checked.append(1)
            raise evidence.CollectionDeadline()
        def unreadable(_fd):
            checked.append(1)
            raise capture.ReadError('stat-alias', OSError(errno.EIO, 'private'))
        with patch.object(capture.os, 'close', side_effect=close_then_fail), \
             self.assertRaises(evidence.CollectionDeadline):
            snap.recheck(str(tree.root / 'usr/bin'), held, deadline)
        checked.clear()
        with patch.object(capture.os, 'close', side_effect=close_then_fail), \
             self.assertRaises(capture.ReadError) as raised:
            snap.recheck(str(tree.root / 'usr/bin'), held, unreadable)
        self.assertEqual((raised.exception.stage, raised.exception.errno, raised.exception.cleanup),
                         ('stat-alias', errno.EIO, [{'stage': 'close-parent', 'errno': errno.EBADF}]))

    def test_deadline_cleanup_and_outer_alarm(self):
        tree = Tree(self, body=b'x' * 100)
        before = fds()
        self.assertEqual(tree.run(deadline=time.monotonic() - 1), {'state': 'error', 'error': 'TimeoutError'})
        self.assertEqual(fds(), before)
        with patch.object(snap.os, 'read', side_effect=evidence.CollectionDeadline()), \
             self.assertRaises(evidence.CollectionDeadline):
            tree.run()
        self.assertEqual(fds(), before)
        real_close, failed = os.close, []
        def close_then_fail(fd):
            real_close(fd)
            if failed:
                raise OSError(errno.EBADF, 'private')
        def read_fails(fd, size):
            failed.append(1)
            raise OSError(errno.EIO, 'private')
        with patch.object(snap.os, 'read', side_effect=read_fails), \
             patch.object(capture.os, 'close', side_effect=close_then_fail):
            result = tree.run()
        self.assertEqual(result['context'], {'format': 2, 'stage': 'read', 'errno': errno.EIO, 'cleanup': [
            {'stage': 'close-file', 'errno': errno.EBADF}, {'stage': 'close-parent', 'errno': errno.EBADF},
            {'stage': 'close-parent', 'errno': errno.EBADF}]})
        doc = document_v2(); doc['sections'][snap.SECTION] = result
        self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'PARTIAL_REVIEW_REQUIRED')
        self.assertNotIn(b'private', encoded(result))


class Collect(unittest.TestCase):
    def collect(self, observations):
        with patch.object(evidence, 'command', side_effect=command), \
             patch.object(capture, 'file_record', side_effect=lambda path, body=False: release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), \
             patch.object(scope, 'unit_scope', side_effect=unit_scope), \
             patch.object(snap, 'observe', side_effect=observations):
            return evidence.collect(BINDING)

    def test_collector_writes_its_format_with_the_snap_section_and_late_resample(self):
        doc = self.collect([snap_record(), snap_record()])
        self.assertEqual(doc['format'], 3)
        self.assertNotIn('file:/usr/bin/snap', doc['sections'])
        self.assertEqual(doc['sections'][snap.SECTION], {'state': 'ok', 'value': snap_record()})
        self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'COLLECTED_REVIEW_REQUIRED')
        drifted = copy.deepcopy(snap_record()); drifted['target']['sha256'] = digest(b'other')
        doc = self.collect([snap_record(), drifted])
        self.assertEqual(doc['sections'][snap.SECTION], {'state': 'error', 'error': 'CHANGED', 'prior': snap_record()})
        self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'PARTIAL_REVIEW_REQUIRED')


class Validate(unittest.TestCase):
    def status(self, doc):
        return validator.validate(encoded(doc), BINDING)

    def test_complete_v2_and_v1_documents_share_facts(self):
        v1, v2 = self.status(document()), self.status(document_v2())
        self.assertEqual(v1['status'], v2['status'])
        self.assertEqual(v2['status'], 'COLLECTED_REVIEW_REQUIRED')
        self.assertEqual(v1['policy_input_hashes'], v2['policy_input_hashes'])
        self.assertNotIn('snap', encoded(v2['policy_input_hashes']).decode())

    def test_absent_and_regular_records_are_complete_under_root_parents(self):
        for value in ({'format': 1, 'kind': 'absent', 'alias': {'parent': META}},
                      {'format': 2, 'kind': 'absent', 'alias': {'parent': META}},
                      {'format': 1, 'kind': 'regular', 'alias': {'parent': META},
                       'file': {**META, 'bytes': 3, 'sha256': digest(b'abc')}},
                      {'format': 2, 'kind': 'regular', 'alias': {'parent': META},
                       'file': {**META, 'bytes': snap.TARGET_LIMIT, 'sha256': digest(b'abc')}}):
            doc = document_v2(); doc['sections'][snap.SECTION] = {'state': 'ok', 'value': value}
            self.assertEqual(self.status(doc)['status'], 'COLLECTED_REVIEW_REQUIRED')

    def test_regular_record_caps_follow_the_record_format(self):
        # Format 1 kept the shared 8 MiB reader's limit; format 2 streams under TARGET_LIMIT.
        for fmt, size in ((1, capture.LIMIT + 1), (2, snap.TARGET_LIMIT + 1)):
            value = {'format': fmt, 'kind': 'regular', 'alias': {'parent': META},
                     'file': {**META, 'bytes': size, 'sha256': digest(b'abc')}}
            doc = document_v2(); doc['sections'][snap.SECTION] = {'state': 'ok', 'value': value}
            with self.subTest(fmt=fmt), self.assertRaises(ValueError):
                self.status(doc)
        value = {'format': 2, 'kind': 'regular', 'alias': {'parent': META}, 'file': {**META, 'bytes': 3, 'sha256': digest(b'abc'), 'body': 'x'}}
        doc = document_v2(); doc['sections'][snap.SECTION] = {'state': 'ok', 'value': value}
        with self.assertRaises(ValueError):
            self.status(doc)

    def test_parent_ownership_predicate(self):
        for parent in ('alias', 'target'):
            for meta in ({**META, 'uid': 1000}, {**META, 'mode': 0o775}, {**META, 'mode': 0o757}):
                with self.subTest(parent=parent, meta=meta):
                    doc = document_v2(); value = doc['sections'][snap.SECTION]['value']
                    (value['alias'] if parent == 'alias' else value['target'])['parent'] = meta
                    result = self.status(doc)
                    self.assertEqual((result['status'], result['policy_input_hashes']), ('PARTIAL_REVIEW_REQUIRED', {}))

    def test_refusals_and_v2_context_are_partial(self):
        for item in [{'state': 'error', 'error': code} for code in (*snap.REFUSALS, 'ValueError', 'TimeoutError')] + [
                {'state': 'error', 'error': 'OSError', 'context': {'format': 2, 'stage': stage, 'errno': errno.ELOOP, 'cleanup': []}}
                for stage in snap.STAGES] + [
                {'state': 'error', 'error': 'OSError', 'context': {'format': 2, 'stage': 'read', 'errno': 5,
                 'cleanup': [{'stage': 'close-parent', 'errno': 9}] * 4}}, {'state': 'not_reached'},
                {'state': 'error', 'error': 'TimeoutError', 'prior': snap_record()}]:
            doc = document_v2(); doc['sections'][snap.SECTION] = item
            with self.subTest(item=item):
                self.assertEqual(self.status(doc)['status'], 'PARTIAL_REVIEW_REQUIRED')

    def test_forgeries_refused(self):
        def forged(change):
            value = snap_record(); change(value); return {'state': 'ok', 'value': value}
        cases = [
            forged(lambda v: v.update(format=True)), forged(lambda v: v.update(format=3)),
            forged(lambda v: v.update(kind='alias')), forged(lambda v: v.pop('target')),
            forged(lambda v: v.update(extra=1)), forged(lambda v: v['alias'].update(link='/usr/lib/snapd/snapd')),
            forged(lambda v: v['target'].update(bytes=True)), forged(lambda v: v['target'].update(bytes=snap.TARGET_LIMIT + 1)),
            forged(lambda v: v['target'].update(sha256='A' * 64)), forged(lambda v: v['target'].update(uid=-1)),
            forged(lambda v: v['alias']['parent'].update(mode=0o10000)), forged(lambda v: v['alias'].pop('leaf')),
            {'state': 'ok', 'value': {'format': 1, 'kind': 'absent', 'alias': {'parent': META}, 'target': snap_record()['target']}},
            {'state': 'error', 'error': 'UNEXPECTED_ALIAS', 'context': {'format': 2, 'stage': 'read', 'errno': 5, 'cleanup': []}},
            {'state': 'error', 'error': 'OSError', 'context': {'format': 1, 'stage': 'open-file', 'errno': 40, 'cleanup': []}},
            {'state': 'error', 'error': 'OSError', 'context': {'format': 2, 'stage': 'unknown', 'errno': 40, 'cleanup': []}},
            {'state': 'error', 'error': 'UNREVIEWED_PATH'}, {'state': 'error', 'error': 'OSError', 'message': 'secret'},
            {'state': 'error', 'error': 'UNEXPECTED_ALIAS', 'prior': snap_record()},
            {'state': 'ok', 'value': {'format': 1, 'kind': 'absent', 'alias': {'parent': META, 'leaf': META}}},
            {'state': 'ok', 'value': {'format': 1, 'kind': 'regular', 'alias': {'parent': META, 'leaf': META},
                                      'file': {**META, 'bytes': 3, 'sha256': digest(b'abc')}}},
            forged(lambda v: v['alias']['leaf'].update(mode=0o10000)),
            *[{'state': 'error', 'error': 'OSError', 'context': {'format': 2, 'stage': 'read', 'errno': errno_value, 'cleanup': []}}
              for errno_value in ('40', True, 0, 4096)],
            *[{'state': 'error', 'error': 'OSError', 'context': {'format': 2, 'stage': 'read', 'errno': 5, 'cleanup': cleanup}}
              for cleanup in ([{'stage': 'read', 'errno': 9}], [{'stage': 'close-file', 'errno': '9'}],
                              [{'stage': 'close-file', 'errno': 9}] * 5, [{'stage': 'close-file'}])]]
        for item in cases:
            doc = document_v2(); doc['sections'][snap.SECTION] = item
            with self.subTest(item=item), self.assertRaises(ValueError):
                self.status(doc)

    def test_v2_needs_its_section_and_never_the_old_file_section(self):
        doc = document_v2(); del doc['sections'][snap.SECTION]
        with self.assertRaises(ValueError): self.status(doc)
        doc = document_v2(); doc['sections']['file:/usr/bin/snap'] = {'state': 'ok', 'value': {'absent': True}}
        with self.assertRaises(ValueError): self.status(doc)
        doc = document(); doc['sections'][snap.SECTION] = {'state': 'ok', 'value': snap_record()}
        with self.assertRaises(ValueError): self.status(doc)
        doc = document_v2(); doc['format'] = 3
        with self.assertRaises(ValueError): self.status(doc)

    def test_packagekit_activation_still_refuses_completeness_of_installation(self):
        doc = document_v2()
        path = '/usr/share/dbus-1/system-services/org.freedesktop.PackageKit.service'
        value = {**META, 'mode': 0o644, 'bytes': 1, 'sha256': digest(b'x')}
        if path in evidence.BODIES:
            value['body'] = capture.blob(b'x')
        doc['sections']['file:' + path] = {'state': 'ok', 'value': value}
        doc['sections']['dbus-socket'] = {'state': 'ok', 'value': {'exists': True, 'socket': True}}
        self.assertIs(self.status(doc)['packagekit_activation_possible'], True)



class Closure(unittest.TestCase):
    """The guest and the packet source map must ship every module the collector imports."""
    def imports(self, name):
        tree = ast.parse((Path(snap.__file__).parent / (name + '.py')).read_text())
        found = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found |= {alias.name for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                found.add(node.module)
        return {name for name in found if name.startswith('r3_')}

    def test_collection_module_closures_are_complete(self):
        import r3_policy_packet
        import r3_noble_inputs
        modules = set(r3_policy_packet.MODULES)
        helpers = {name.removesuffix('.py') for name in r3_noble_inputs.HELPERS}
        for closure in (modules, helpers):
            self.assertIn('r3_policy_snap', closure)
            for name in closure:
                with self.subTest(module=name):
                    self.assertLessEqual(self.imports(name), closure)


def setUpModule():
    # Format-3 collection reads its PackageKit sections from a synthetic masked host.
    import r3_pk_fixtures
    r3_pk_fixtures.module_canned_sections()

if __name__ == '__main__':
    unittest.main()

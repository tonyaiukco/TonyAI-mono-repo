"""Synthetic same-attempt error context; never inspects a real guest or snap.

The snap section (format 2 evidence) produces context format 2; format 1
documents with the old file-section context must still validate as before.
"""
import copy
import errno
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_r3_policy_evidence import (BINDING, META, apt_scope, unit_scope, command,
    document, release_record, capture, evidence, validator, scope, snap, guest, host, encoded, write)


def context(stage='open-file', number=errno.ELOOP):
    """Context the current snap section produces."""
    return {'format': 2, 'stage': stage, 'errno': number, 'cleanup': []}


def v1_context(stage='open-file', number=errno.ELOOP):
    """Context retained in format 1 documents."""
    return {'format': 1, 'stage': stage, 'errno': number, 'cleanup': []}


class ErrorContext(unittest.TestCase):
    def test_real_leaf_and_parent_symlinks_remain_refused_without_target_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            leaf = root / 'snap'
            leaf.symlink_to('/never-follow-private-data')
            parent = root / 'parent'
            parent.symlink_to(root)
            for path, stage in ((leaf, 'open-file'), (parent / 'snap', 'resolve-parent')):
                with patch.object(capture.os, 'read', side_effect=AssertionError('body read')), \
                     patch.object(capture.os, 'readlink', side_effect=AssertionError('extra read')):
                    result = snap.operation(lambda: capture.file_record(str(path)))
                self.assertEqual(result['error'], 'OSError')
                self.assertEqual(result['context']['stage'], stage)
                self.assertIs(type(result['context']['errno']), int)
                self.assertNotIn(b'never-follow', encoded(result))
                self.assertNotIn(str(root).encode(), encoded(result))

    def test_syscall_stages_and_sanitized_errno(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve() / 'snap'
            path.write_bytes(b'input')
            original = os.fstat
            cases = [('stat-before', 'fstat', OSError(errno.EIO, 'secret', 'private-path')),
                     ('read', 'read', PermissionError(errno.EACCES, 'secret', 'private-path')),
                     ('stat-after', 'fstat', [None, OSError(errno.EIO, 'secret')]),
                     ('stat-path', 'stat', FileNotFoundError(errno.ENOENT, 'secret'))]
            for stage, name, failure in cases:
                calls = []
                def fail(*args, **kwargs):
                    calls.append(1)
                    if isinstance(failure, list) and len(calls) == 1:
                        return original(*args, **kwargs)
                    raise failure[-1] if isinstance(failure, list) else failure
                with self.subTest(stage=stage), patch.object(capture.os, name, side_effect=fail):
                    result = snap.operation(lambda: capture.file_record(str(path)))
                self.assertEqual(result['context']['stage'], stage)
                self.assertNotIn(b'secret', encoded(result))
                self.assertNotIn(b'private-path', encoded(result))

    def test_missing_parent_and_leaf_still_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            for path in (Path(tmp).resolve() / 'snap', Path(tmp).resolve() / 'missing/snap'):
                self.assertEqual(capture.file_record(str(path)), {'absent': True})

    def test_cleanup_preserves_primary_error_and_outer_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / 'snap'
            path.write_bytes(b'input')
            original_close = os.close
            for failure in (OSError(errno.EIO, 'private'), TimeoutError(), evidence.CollectionDeadline()):
                parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                def close_then_fail(fd):
                    original_close(fd)
                    raise OSError(errno.EBADF, 'cleanup-private')
                with patch.object(capture, 'directory', return_value=parent), \
                     patch.object(capture.os, 'read', side_effect=failure), \
                     patch.object(capture.os, 'close', side_effect=close_then_fail):
                    if isinstance(failure, evidence.CollectionDeadline):
                        with self.assertRaises(evidence.CollectionDeadline):
                            snap.operation(lambda: capture.file_record(str(path)))
                        continue
                    result = snap.operation(lambda: capture.file_record(str(path)))
                if isinstance(failure, TimeoutError):
                    self.assertEqual(result, {'state': 'error', 'error': 'TimeoutError'})
                else:
                    self.assertEqual(result['context'], {**context('read', errno.EIO), 'cleanup': [
                        {'stage': 'close-file', 'errno': errno.EBADF},
                        {'stage': 'close-parent', 'errno': errno.EBADF}]})

    def test_absence_with_failed_cleanup_is_not_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            original_close = os.close
            def fail(fd):
                original_close(fd)
                raise OSError(errno.EBADF, 'private')
            with patch.object(capture, 'directory', return_value=parent), \
                 patch.object(capture.os, 'close', side_effect=fail):
                result = snap.operation(lambda: capture.file_record(str(root / 'missing')))
            self.assertEqual(result['context'], context('close-parent', errno.EBADF))

    def test_unrelated_handled_exception_cannot_hide_cleanup_or_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            path = root / 'snap'
            path.write_bytes(b'input')
            original_close = os.close
            for failure in (OSError(errno.EIO, 'private'), TimeoutError()):
                parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                def fail(fd):
                    original_close(fd)
                    raise failure
                try:
                    raise ValueError('unrelated caller exception')
                except ValueError:
                    with patch.object(capture, 'directory', return_value=parent), \
                         patch.object(capture.os, 'close', side_effect=fail):
                        result = snap.operation(lambda: capture.file_record(str(path)))
                self.assertEqual(result['state'], 'error')
                self.assertEqual(result['error'], 'TimeoutError' if isinstance(failure, TimeoutError) else 'OSError')

    def test_context_opt_in_and_bounded_unknown_errno(self):
        for number in (None, True, -1, 0, 4096, 'EIO'):
            error = OSError()
            error.errno = number
            def fail():
                raise capture.ReadError('read', error)
            self.assertEqual(evidence.operation(fail), {'state': 'error', 'error': 'OSError'})
            self.assertIsNone(snap.operation(fail)['context']['errno'])

    def test_context_remains_partial_and_old_evidence_valid(self):
        for detail in (None, v1_context(), v1_context('read', None), {**v1_context('read'),
                'cleanup': [{'stage': 'close-file', 'errno': errno.EBADF}]}):
            doc = document()
            item = {'state': 'error', 'error': 'OSError'}
            if detail is not None:
                item['context'] = detail
            doc['sections']['file:/usr/bin/snap'] = item
            result = validator.validate(encoded(doc), BINDING)
            self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
            self.assertEqual(result['policy_input_hashes'], {})
            for key in ('qualification', 'installation_success', 'policy_generated'):
                self.assertIs(result[key], False)

    def test_context_forgeries_refused(self):
        bad = [{**v1_context(), key: value} for key, values in {
            'format': [True, 2], 'stage': ['unknown', None],
            'errno': [True, '40', 0, -1, 4096],
            'cleanup': [None, [{}], [{'stage': 'read', 'errno': 5}],
                [{'stage': 'close-file', 'errno': True}],
                [{'stage': 'close-file', 'errno': 5, 'message': 'secret'}],
                [{'stage': 'close-file', 'errno': 5}] * 3]}.items() for value in values]
        bad += [{**v1_context(), 'message': 'secret'}, {'format': 1}, None]
        for detail in bad:
            doc = document()
            doc['sections']['file:/usr/bin/snap'] = {'state': 'error', 'error': 'OSError', 'context': detail}
            with self.subTest(detail=detail), self.assertRaises(ValueError):
                validator.validate(encoded(doc), BINDING)

    def test_context_on_other_paths_commands_states_and_prior_refused(self):
        for name in document()['sections']:
            if name == 'file:/usr/bin/snap':
                continue
            doc = document()
            doc['sections'][name] = {'state': 'error', 'error': 'OSError', 'context': v1_context()}
            with self.subTest(name=name), self.assertRaises(ValueError):
                validator.validate(encoded(doc), BINDING)
        for item in ({'state': 'ok', 'value': {'absent': True}}, {'state': 'not_reached'},
                     {'state': 'error', 'error': 'TimeoutError'},
                     {'state': 'error', 'error': 'CHANGED', 'prior': {'absent': True}},
                     {'state': 'error', 'error': 'OSError', 'prior': {'absent': True}}):
            doc = document()
            doc['sections']['file:/usr/bin/snap'] = {**item, 'context': v1_context()}
            with self.assertRaises(ValueError):
                validator.validate(encoded(doc), BINDING)

    def test_collect_checkpoint_and_encrypted_frame_input_preserve_context(self):
        manifest = {'purpose': evidence.A_PURPOSE, 'source': BINDING['source'],
                    'image_sha256': BINDING['image_sha256'], 'fixture_uuid': BINDING['fixture_uuid'],
                    'files': {'r3-toolchain.lock.json': BINDING['toolchain_sha256']}}
        def file(path, body=False):
            self.assertNotEqual(path, '/usr/bin/snap')
            if path == '/usr/bin/mandb':
                raise capture.ReadError('open-file', OSError(errno.ELOOP, 'private'))
            return release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})
        points = []
        with patch.object(evidence, 'command', side_effect=command), \
             patch.object(capture, 'file_record', side_effect=file), \
             patch.object(capture, 'membership', return_value={'metadata': META, 'names': []}), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), patch.object(scope, 'unit_scope', side_effect=unit_scope), \
             patch.object(snap, 'observe', side_effect=capture.ReadError('stat-alias', OSError(errno.ELOOP, 'private'))):
            doc = evidence.collect(BINDING, lambda v: points.append(copy.deepcopy(v)))
        self.assertEqual(doc['sections'][snap.SECTION]['context'], context('stat-alias'))
        self.assertNotIn('file:/usr/bin/snap', doc['sections'])
        self.assertEqual(doc['sections']['file:/usr/bin/mandb'], {'state': 'error', 'error': 'OSError'})
        self.assertTrue(any('context' in v['sections'][snap.SECTION] for v in points))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output, port = root / 'output', root / 'port'
            def verified(_purpose):
                write(output / 'manifest.json', encoded(manifest))
                return manifest
            def synthetic_collect(binding, checkpoint):
                self.assertEqual(binding, BINDING)
                checkpoint(doc)
                return doc
            with patch.object(guest, 'OUTPUT', output), patch.object(guest, 'PORT', str(port)), \
                 patch.object(guest, 'verify_input', side_effect=verified), \
                 patch.object(evidence, 'collect', side_effect=synthetic_collect), \
                 patch.object(guest, 'run', side_effect=AssertionError('real command')), \
                 patch.object(guest, 'installation_main', side_effect=AssertionError('installation')):
                self.assertEqual(guest.collection_main(), 1)
            result = host.validate_frame(port.read_bytes(), manifest)
            self.assertEqual(result['status'], 'PARTIAL_REVIEW_REQUIRED')
            self.assertEqual(result['checks']['policy_input_hashes'], {})
            self.assertIs(result['install_attempted'], False)
            self.assertEqual(set(p.name for p in output.iterdir()), guest.COLLECTION_FILES)
            self.assertEqual(evidence.load((output / 'policy-evidence.json').read_bytes()), doc)


if __name__ == '__main__':
    unittest.main()

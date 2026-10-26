"""Kernel trigger-interest files: reviewed only for a kernel the same document's inventory records installed."""
import copy
import unittest
from unittest.mock import patch

from test_r3_policy_evidence import (BINDING, INVENTORY, META, apt_scope, unit_scope, release_record, document_v2,
    snap_record, capture, evidence, validator, scope, snap, encoded, digest)

KERNEL = '6.17.0-1022-azure'
TRIGGER = 'linux-update-' + KERNEL
PATH = evidence.TRIGGERS + '/' + TRIGGER
ROWS = INVENTORY + ('linux-image-%s\tamd64\t%s.22\tinstall ok installed\tno\t\t\t\n' % (KERNEL, KERNEL)).encode()


def inventory_section(stdout=ROWS, returncode=0, failure=None, state='ok'):
    if state != 'ok':
        return {'state': state}
    return {'state': 'ok', 'value': {'argv': evidence.COMMANDS['inventory'], 'stdout': capture.blob(stdout),
            'stderr': capture.blob(b''), 'returncode': returncode, 'failure': failure}}


def trigger_record():
    raw = b'interest-noawait /usr/lib/linux/triggers/' + KERNEL.encode() + b'\n'
    return {**META, 'mode': 0o644, 'bytes': len(raw), 'sha256': digest(raw), 'body': capture.blob(raw)}


class Helpers(unittest.TestCase):
    def test_installed_kernels_reads_only_fully_installed_image_packages(self):
        rows = ROWS + (b'linux-image-azure\tamd64\t6.17.0.1022.22\tinstall ok installed\tno\t\t\t\n'
                       b'linux-image-6.8.0-1-generic\tamd64\t6.8.0-1.1\tdeinstall ok config-files\tno\t\t\t\n'
                       b'linux-image-6.9.0-2-generic\tamd64\t6.9.0-2.2\tinstall ok half-configured\tno\t\t\t\n'
                       b'linux-headers-6.10.0-3-azure\tamd64\t6.10.0-3.3\tinstall ok installed\tno\t\t\t\n')
        self.assertEqual(evidence.installed_kernels(inventory_section(rows)), {KERNEL, 'azure'})

    def test_an_incomplete_inventory_reviews_no_kernel(self):
        for section in (inventory_section(returncode=1), inventory_section(failure='TimeoutError'),
                        inventory_section(returncode=None), inventory_section(b''), inventory_section(b'bad\n'),
                        inventory_section(ROWS[:-1]), inventory_section(state='not_reached'),
                        {'state': 'error', 'error': 'OSError'}, None,
                        {'state': 'ok', 'value': {'returncode': 0, 'failure': None, 'stdout': {'base64': '!!'}}}):
            with self.subTest(section=section):
                self.assertEqual(evidence.installed_kernels(section), frozenset())

    def test_reviewed_member_pattern_is_exact(self):
        kernels = frozenset({KERNEL, 'azure'})
        self.assertTrue(evidence.reviewed_member(evidence.TRIGGERS, 'Lock', frozenset()))
        self.assertTrue(evidence.reviewed_member(evidence.TRIGGERS, TRIGGER, kernels))
        self.assertFalse(evidence.reviewed_member(evidence.TRIGGERS, TRIGGER, frozenset()))
        # 'azure' is in the set (linux-image-azure is a metapackage), yet its name never matches the version pattern.
        for name in (TRIGGER + ' ', ' ' + TRIGGER, 'x' + TRIGGER, TRIGGER + '.dpkg-new', TRIGGER + '/x',
                     'linux-update-azure', 'linux-update-' + KERNEL.upper(), TRIGGER + '\n',
                     'linux-update-6.17.0-1023-azure', 'linux-update-\uff16.17.0-1022-azure'):
            with self.subTest(name=name):
                self.assertFalse(evidence.reviewed_member(evidence.TRIGGERS, name, kernels))
        # A hyphenated flavour stays unreviewed even when that kernel is installed (fail closed).
        self.assertFalse(evidence.reviewed_member(evidence.TRIGGERS, 'linux-update-6.8.0-1-generic-64k',
                                                  kernels | {'6.8.0-1-generic-64k'}))
        for path in ('/etc/apt/apt.conf.d', '/etc/dpkg/dpkg.cfg.d'):
            with self.subTest(path=path):
                self.assertFalse(evidence.reviewed_member(path, TRIGGER, kernels))


class Collection(unittest.TestCase):
    def collect(self, inventory=ROWS, names=(TRIGGER,)):
        def command(name, _deadline=0):
            if name == 'inventory':
                return inventory_section(inventory)['value']
            from test_r3_policy_evidence import command as base
            return base(name)
        def record(path, body=False):
            if path == PATH:
                return trigger_record()
            return release_record() if path == '/usr/lib/os-release' else unit_scope()['files'].get(path, {'absent': True})
        def membership(path):
            return {'metadata': META, 'names': list(names) if path == evidence.TRIGGERS else []}
        with patch.object(evidence, 'command', side_effect=command), \
             patch.object(capture, 'file_record', side_effect=record), \
             patch.object(capture, 'membership', side_effect=membership), \
             patch.object(capture, 'socket_record', return_value={'exists': False, 'socket': False}), \
             patch.object(capture, 'cache', return_value={'.': {'directory': True, **META}}), \
             patch.object(scope, 'apt_scope', side_effect=apt_scope), \
             patch.object(scope, 'unit_scope', side_effect=unit_scope), \
             patch.object(snap, 'observe', return_value=snap_record()):
            return evidence.collect(BINDING)

    def test_installed_kernel_trigger_is_read_and_complete(self):
        doc = self.collect()
        self.assertEqual(doc['sections']['file:' + PATH], {'state': 'ok', 'value': trigger_record()})
        self.assertEqual(validator.validate(encoded(doc), BINDING)['status'], 'COLLECTED_REVIEW_REQUIRED')

    def test_trigger_of_a_kernel_not_installed_stays_unreviewed(self):
        removed = ROWS.replace(b'.22\tinstall ok installed', b'.22\tdeinstall ok config-files')
        self.assertNotEqual(removed, ROWS)
        for inventory in (INVENTORY, removed, b'bad\n'):
            with self.subTest(inventory=inventory):
                doc = self.collect(inventory)
                self.assertEqual(doc['sections']['file:' + PATH], {'state': 'error', 'error': 'UNREVIEWED_PATH'})
                result = validator.validate(encoded(doc), BINDING)
                self.assertEqual((result['status'], result['policy_input_hashes']), ('PARTIAL_REVIEW_REQUIRED', {}))

    def test_lookalike_trigger_stays_unreviewed(self):
        doc = self.collect(names=('linux-update-' + KERNEL + '.dpkg-new',))
        self.assertEqual(doc['sections']['file:' + evidence.TRIGGERS + '/linux-update-' + KERNEL + '.dpkg-new'],
                         {'state': 'error', 'error': 'UNREVIEWED_PATH'})


class Validation(unittest.TestCase):
    def doc(self, inventory=ROWS, record=None):
        doc = document_v2()
        doc['sections']['inventory'] = inventory_section(inventory)
        doc['sections']['directory:' + evidence.TRIGGERS] = {'state': 'ok', 'value': {'metadata': META, 'names': [TRIGGER]}}
        doc['sections']['file:' + PATH] = {'state': 'ok', 'value': trigger_record()} if record is None else record
        return doc

    def test_reviewed_trigger_record_is_complete(self):
        self.assertEqual(validator.validate(encoded(self.doc()), BINDING)['status'], 'COLLECTED_REVIEW_REQUIRED')

    def test_a_read_record_for_an_unlisted_kernel_is_refused(self):
        bad = ROWS.replace(b'linux-image-' + KERNEL.encode(), b'linux-image-6.17.0-1023-azure')
        for inventory in (INVENTORY, bad):
            with self.subTest(inventory=inventory), self.assertRaises(ValueError):
                validator.validate(encoded(self.doc(inventory)), BINDING)

    def test_a_failed_inventory_reviews_no_kernel_and_is_partial(self):
        doc = self.doc(record={'state': 'error', 'error': 'UNREVIEWED_PATH'})
        doc['sections']['inventory'] = inventory_section(returncode=1)
        result = validator.validate(encoded(doc), BINDING)
        self.assertEqual((result['status'], result['policy_input_hashes']), ('PARTIAL_REVIEW_REQUIRED', {}))
        with self.assertRaises(ValueError):
            doc = self.doc()
            doc['sections']['inventory'] = inventory_section(returncode=1)
            validator.validate(encoded(doc), BINDING)

    def test_unreviewed_record_for_an_installed_kernel_is_refused(self):
        # The collector reads a reviewed member; an UNREVIEWED_PATH record for it is a forgery.
        with self.assertRaises(ValueError):
            validator.validate(encoded(self.doc(record={'state': 'error', 'error': 'UNREVIEWED_PATH'})), BINDING)



def setUpModule():
    # Format-3 collection reads its PackageKit sections from a synthetic masked host.
    import r3_pk_fixtures
    r3_pk_fixtures.module_canned_sections()

if __name__ == '__main__':
    unittest.main()

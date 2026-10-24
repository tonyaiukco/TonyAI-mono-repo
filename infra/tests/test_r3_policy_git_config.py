"""Git program-bearing configuration refusals in disposable local repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_r3_policy_target import source_git
from r3_noble_common import digest


class GitProgramConfiguration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**source_git.ENV, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                    'GIT_AUTHOR_NAME': 'Synthetic Test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                    'GIT_COMMITTER_NAME': 'Synthetic Test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'}
        self.git('init', '-q')
        self.path = self.root / 'source.py'
        self.path.write_bytes(b'synthetic\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'synthetic fixture')
        self.head = self.git('rev-parse', 'HEAD').decode().strip()
        self.files = {'source.py': digest(self.path.read_bytes())}
        self.marker = self.root / '.git/program-executed'
        program = self.root / '.git/filter-program'
        program.write_text('#!/bin/sh\nprintf invoked > "' + str(self.marker) + '"\ncat\n')
        program.chmod(0o700)
        self.program = str(program)

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], env=self.env, stderr=subprocess.DEVNULL)

    def verify(self):
        return source_git.verified_head(self.root, self.files)

    def test_clean_repository_still_verifies(self):
        self.assertEqual(self.verify(), self.head)

    def test_filter_cannot_execute_during_source_verification(self):
        (self.root / '.git/info/attributes').write_text('* filter=evil\n')
        self.git('config', 'filter.evil.clean', self.program)
        # Force status to reconsider raw bytes rather than trusting index stat.
        info = self.path.stat()
        os.utime(self.path, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
        with self.assertRaises(ValueError):
            self.verify()
        self.assertFalse(self.marker.exists(), 'source verification ran a filter')

    def test_program_config_namespaces_refused_without_execution(self):
        config = self.root / '.git/config'
        original = config.read_bytes()
        included = self.root / '.git/included-config'
        included.write_text('[filter "evil"]\n\tclean = ' + self.program + '\n')
        for key in ('filter.evil.clean', 'filter.evil.process', 'diff.evil.command',
                    'diff.evil.textconv', 'include.path', 'includeIf.gitdir:/.path',
                    'extensions.worktreeConfig', 'extensions.partialClone', 'remote.origin.promisor', 'core.worktree'):
            with self.subTest(key=key):
                value = 'true' if key in ('extensions.worktreeConfig', 'remote.origin.promisor') else self.program
                if key.startswith('include'): value = str(included)
                if key == 'core.worktree': value = str(self.root)
                try:
                    self.git('config', key, value)
                    with self.assertRaises(ValueError):
                        self.verify()
                    self.assertFalse(self.marker.exists())
                finally:
                    config.write_bytes(original)

    def test_info_attributes_nonempty_or_symlink_refused(self):
        attributes = self.root / '.git/info/attributes'
        attributes.write_bytes(b'')
        self.assertEqual(self.verify(), self.head)
        attributes.write_bytes(b'# no configured filters\n')
        with self.assertRaises(ValueError):
            self.verify()
        attributes.unlink()
        attributes.symlink_to(self.path)
        with self.assertRaises(ValueError):
            self.verify()

    def test_gitlink_filter_never_runs_even_when_status_would_refuse(self):
        child = self.root / 'child'
        child.mkdir()
        def git(*args):
            return subprocess.check_output(['git', '-C', str(child), *args], env=self.env, stderr=subprocess.DEVNULL)
        git('init', '-q')
        path = child / 'child.py'
        path.write_bytes(b'synthetic child\n')
        git('add', '.')
        git('commit', '-qm', 'synthetic child')
        child_head = git('rev-parse', 'HEAD').decode().strip()
        (child / '.git/info/attributes').write_text('* filter=evil\n')
        git('config', 'filter.evil.clean', self.program)
        self.git('update-index', '--add', '--cacheinfo', '160000,' + child_head + ',child')
        for state in ('index-only', 'committed', 'head-only'):
            with self.subTest(state=state):
                if state == 'committed': self.git('commit', '-qm', 'synthetic gitlink')
                if state == 'head-only': self.git('update-index', '--force-remove', 'child')
                info = path.stat()
                os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 2_000_000_000))
                with self.assertRaises(ValueError):
                    self.verify()
                self.assertFalse(self.marker.exists(), 'verification ran a child filter')

    def test_each_gitlink_listing_refuses_before_status(self):
        real_git = source_git.git
        for command in ('ls-files', 'ls-tree'):
            calls = []
            def controlled(root, *args):
                calls.append(args[0])
                if args[0] == command:
                    return b'160000 ' + b'a' * 40 + b' 0\tchild\0'
                return real_git(root, *args)
            with self.subTest(command=command), patch.object(source_git, 'git', side_effect=controlled):
                with self.assertRaises(ValueError):
                    self.verify()
            self.assertNotIn('status', calls)

"""Real harmless children exercise diagnostic lifetime; no Terraform or Azure calls."""
import contextlib
import io
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import replacement_run as runner

SCRIPTS = str(Path(runner.__file__).parent)
CHILD = r'''
import os, pathlib, signal, stat, sys, time
root = pathlib.Path(sys.argv[1])
# Python normally ignores SIGPIPE: restore it so a broken pipe kills this probe.
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
assert all(stat.S_ISREG(os.fstat(fd).st_mode) for fd in (1, 2))
(root / 'ready').write_text(str(os.getpid()))
end = time.monotonic() + 10
while not (root / 'continue').exists():
    if time.monotonic() > end: sys.exit(9)
    time.sleep(.01)
for fd in (1, 2):
    data = b'private-synthetic-output\n' * 16384
    while data:
        data = data[os.write(fd, data):]
(root / 'finished').write_text('complete')
'''


def wait_for(path):
    deadline = time.monotonic() + 10
    while not path.exists():
        if time.monotonic() > deadline:
            raise AssertionError('Synthetic child did not reach checkpoint')
        time.sleep(.01)


class ReplacementDiagnosticTests(unittest.TestCase):
    def test_success_returns_exact_bytes_without_disclosing_either_stream(self):
        with tempfile.TemporaryDirectory() as folder:
            original = os.umask(0)
            try:
                with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                    result = runner.terraform_capture([sys.executable, '-c',
                        "import os; os.write(1,b'private\\x00stdout'); os.write(2,b'private-stderr')"],
                        os.environ.copy(), folder, 'plan')
            finally:
                os.umask(original)
            self.assertEqual(result, b'private\x00stdout')
            self.assertEqual(out.getvalue() + err.getvalue(), '')
            for stream, value in (('stdout', result), ('stderr', b'private-stderr')):
                path = Path(folder) / ('plan.' + stream + '.log')
                self.assertEqual(path.read_bytes(), value)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(path.stat().st_nlink, 1)

    def test_real_failure_retains_both_streams_without_returning_secrets(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'No automatic retry') as error:
                runner.terraform_capture([sys.executable, '-c',
                    "import os; os.write(1,b'private-out'); os.write(2,b'private-err'); raise SystemExit(5)"],
                    os.environ.copy(), folder, 'apply')
            self.assertNotIn('private-out', str(error.exception))
            self.assertEqual((Path(folder) / 'apply.stdout.log').read_bytes(), b'private-out')
            self.assertEqual((Path(folder) / 'apply.stderr.log').read_bytes(), b'private-err')

    def test_existing_regular_symlink_hardlink_or_fifo_refuses_before_spawn(self):
        for stream in ('stdout', 'stderr'):
            for kind in ('regular', 'symlink', 'hardlink', 'fifo'):
                with self.subTest(stream=stream, kind=kind), tempfile.TemporaryDirectory() as folder:
                    root = Path(folder); target = root / 'original'; target.write_bytes(b'keep')
                    path = root / ('apply.' + stream + '.log')
                    if kind == 'regular': path.write_bytes(b'keep')
                    elif kind == 'symlink': path.symlink_to(target)
                    elif kind == 'hardlink': os.link(target, path)
                    else: os.mkfifo(path)
                    with patch.object(runner.subprocess, 'Popen') as spawn:
                        with self.assertRaises(FileExistsError):
                            runner.terraform_capture(['never-run'], {}, root, 'apply')
                        spawn.assert_not_called()
                    self.assertEqual(target.read_bytes(), b'keep')
                    if kind != 'fifo': self.assertEqual(path.read_bytes(), b'keep')
                    # Failure opening stderr leaves the newly reserved stdout in place.
                    if stream == 'stderr': self.assertEqual((root / 'apply.stdout.log').read_bytes(), b'')

    def test_public_foreign_or_symlinked_packet_refuses_before_spawn(self):
        for kind in ('public', 'foreign', 'symlink'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); packet = root / 'packet'; packet.mkdir(mode=0o700)
                selected = packet
                if kind == 'public': packet.chmod(0o755)
                if kind == 'symlink': selected = root / 'link'; selected.symlink_to(packet)
                with contextlib.ExitStack() as stack:
                    spawn = stack.enter_context(patch.object(runner.subprocess, 'Popen'))
                    if kind == 'foreign': stack.enter_context(patch.object(runner.os, 'getuid', return_value=os.getuid() + 1))
                    with self.assertRaises((ValueError, OSError)):
                        runner.terraform_capture(['never-run'], {}, selected, 'plan')
                    spawn.assert_not_called()
                self.assertEqual(list(packet.iterdir()), [])

    def test_spawn_failure_retains_reserved_private_files(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(FileNotFoundError):
                runner.terraform_capture(['/nonexistent/synthetic-terraform'], {}, folder, 'apply')
            for stream in ('stdout', 'stderr'):
                path = Path(folder) / ('apply.' + stream + '.log')
                self.assertEqual(path.read_bytes(), b'')
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_child_keeps_writing_after_wrapper_sigkill_and_real_terminal_closure(self):
        for loss in ('sigkill', 'terminal'):
            with self.subTest(loss=loss), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); child = root / 'child.py'; child.write_text(CHILD)
                terminal_setup = 'import fcntl, termios; fcntl.ioctl(0, termios.TIOCSCTTY, 0);' if loss == 'terminal' else ''
                wrapper = (terminal_setup + 'import sys; sys.path.insert(0,sys.argv[1]); '
                           'from replacement_run import terraform_capture; '
                           'terraform_capture([sys.executable,sys.argv[2],sys.argv[3]],{},sys.argv[3],"apply")')
                master = slave = None
                if loss == 'terminal': master, slave = os.openpty()
                process = subprocess.Popen([sys.executable, '-c', wrapper, SCRIPTS, str(child), folder],
                    stdin=slave if slave is not None else subprocess.DEVNULL,
                    stdout=slave if slave is not None else subprocess.PIPE,
                    stderr=slave if slave is not None else subprocess.PIPE, start_new_session=True)
                if slave is not None: os.close(slave)
                try:
                    wait_for(root / 'ready')
                    if loss == 'sigkill': process.kill()
                    else: os.close(master); master = None
                    self.assertEqual(process.wait(timeout=10), -signal.SIGKILL if loss == 'sigkill' else -signal.SIGHUP)
                    if process.stdout: process.stdout.close()
                    if process.stderr: process.stderr.close()
                    # All wrapper/terminal readers are gone before the child writes.
                    (root / 'continue').touch()
                    wait_for(root / 'finished')
                    for stream in ('stdout', 'stderr'):
                        path = root / ('apply.' + stream + '.log')
                        self.assertEqual(path.read_bytes(), b'private-synthetic-output\n' * 16384)
                        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                finally:
                    (root / 'continue').touch()
                    if master is not None: os.close(master)
                    if process.poll() is None: process.kill(); process.wait(timeout=10)
                    if process.stdout: process.stdout.close()
                    if process.stderr: process.stderr.close()

    def test_real_interrupt_waits_for_graceful_child_but_reports_interruption(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            child = root / 'child.py'
            child.write_text('''import os, pathlib, signal, sys, time
root = pathlib.Path(sys.argv[1])
def finish(*args):
    os.write(1, b'graceful-out'); os.write(2, b'graceful-err'); sys.exit(0)
signal.signal(signal.SIGINT, finish)
(root / 'ready').touch()
while True: time.sleep(.01)
''')
            wrapper = ('import sys; sys.path.insert(0,sys.argv[1]); from replacement_run import terraform_capture\n'
                       'try: terraform_capture([sys.executable,sys.argv[2],sys.argv[3]],{},sys.argv[3],"plan")\n'
                       'except ValueError: sys.exit(7)\n')
            process = subprocess.Popen([sys.executable, '-c', wrapper, SCRIPTS, str(child), folder],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
            try:
                wait_for(root / 'ready'); process.send_signal(signal.SIGINT)
                stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 7)
                self.assertEqual(stdout + stderr, b'')
                self.assertEqual((root / 'plan.stdout.log').read_bytes(), b'graceful-out')
                self.assertEqual((root / 'plan.stderr.log').read_bytes(), b'graceful-err')
            finally:
                if process.poll() is None: process.send_signal(signal.SIGINT); process.communicate(timeout=10)

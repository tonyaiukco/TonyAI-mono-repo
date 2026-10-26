"""Process lifecycle tests without invoking the real fixture/browser executables."""
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch, MagicMock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pooler import SafeFailure
from qa_smoke_child import child
from qa_cloud_smoke import interrupted


class SmokeChildTests(unittest.TestCase):
    def test_child_group_is_killed_and_reaped_on_exit_timeout_or_interruption(self):
        for result in (0, 1, subprocess.TimeoutExpired('node',600), KeyboardInterrupt()):
            process=MagicMock(); process.pid=12345
            process.__enter__.return_value=process
            process.wait.side_effect=[result, 0]
            with self.subTest(result=type(result).__name__), patch('qa_smoke_child.subprocess.Popen',return_value=process) as popen, patch('qa_smoke_child.os.killpg') as kill:
                if result == 0: child('image-smoke.mjs',{'SMOKE_PUBLIC_KEY':'public'})
                else:
                    with self.assertRaises((SafeFailure,subprocess.TimeoutExpired,KeyboardInterrupt)):
                        child('image-smoke.mjs',{'SMOKE_PUBLIC_KEY':'public'})
                kill.assert_called_once_with(12345,signal.SIGKILL)
                self.assertEqual(process.wait.call_args_list[-1].kwargs,dict(timeout=30))
                self.assertTrue(popen.call_args.kwargs['start_new_session'])
                self.assertEqual(popen.call_args.kwargs['stdout'],subprocess.DEVNULL)
                self.assertEqual(popen.call_args.kwargs['stderr'],subprocess.DEVNULL)

    def test_sigterm_enters_the_normal_exception_cleanup_path(self):
        with self.assertRaises(KeyboardInterrupt): interrupted(signal.SIGTERM,None)


if __name__ == '__main__': unittest.main()

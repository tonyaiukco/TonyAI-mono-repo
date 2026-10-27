from pathlib import Path
import sys
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
import ci_supabase_start as start


class Fake:
    def __init__(self, *results):
        self.results, self.calls, self.sleeps = list(results), [], []

    def run(self, command):
        self.calls.append(command)
        return (0, False) if command == start.STOP else self.results.pop(0)

    def sleep(self, seconds):
        self.sleeps.append(seconds)


class SupabaseStartTests(unittest.TestCase):
    def main(self, fake):
        return start.main(run=fake.run, sleep=fake.sleep)

    def test_a_clean_start_runs_once(self):
        fake = Fake((0, False))
        self.assertEqual(self.main(fake), 0)
        self.assertEqual((fake.calls, fake.sleeps), ([start.COMMAND], []))

    def test_any_other_failure_is_reported_at_once(self):
        fake = Fake((3, False))
        self.assertEqual(self.main(fake), 3)
        self.assertEqual((fake.calls, fake.sleeps), ([start.COMMAND], []))

    def test_a_throttled_start_stops_the_partial_stack_and_retries_after_backoff(self):
        fake = Fake((1, True), (0, False))
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.calls, [start.COMMAND, start.STOP, start.COMMAND])
        self.assertEqual(fake.sleeps, [30])

    def test_a_real_failure_after_a_throttled_attempt_is_not_retried(self):
        fake = Fake((1, True), (5, False))
        self.assertEqual(self.main(fake), 5)
        self.assertEqual(fake.sleeps, [30])

    def test_throttling_that_never_clears_fails_after_four_attempts(self):
        fake = Fake(*[(1, True)] * 4)
        self.assertEqual(self.main(fake), 1)
        self.assertEqual(fake.calls.count(start.COMMAND), 4)
        self.assertEqual(fake.sleeps, [30, 90, 180])

    def test_throttling_is_detected_in_the_streamed_output(self):
        code, throttled = start.run([sys.executable, '-c', 'print("Error response from daemon: toomanyrequests: retry-after: 1ms"); raise SystemExit(1)'])
        self.assertEqual((code, throttled), (1, True))
        self.assertEqual(start.run([sys.executable, '-c', 'print("ok")']), (0, False))

    def test_the_command_keeps_the_reviewed_exclusions(self):
        self.assertEqual(start.COMMAND, ['supabase', 'start', '-x', 'studio,mailpit,realtime,edge-runtime,supavisor'])
        action = yaml.load((ROOT / '.github/actions/supabase-stack/action.yml').read_text(), Loader=yaml.BaseLoader)
        steps = [s for s in action['runs']['steps'] if s.get('run') == 'python3 infra/scripts/ci_supabase_start.py']
        self.assertEqual(len(steps), 1)
        self.assertNotIn('continue-on-error', steps[0])


if __name__ == '__main__':
    unittest.main()

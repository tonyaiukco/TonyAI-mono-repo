from pathlib import Path
import sys
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'infra/scripts'))
import ci_supabase_start as start

# Verbatim shapes from the throttled CI runs on #251 (40586552198, 40586552375).
THROTTLED_START = (
    'failed to pull docker image from all registries: ghcr.io/supabase/storage-api:v1.82.1 attempt 1: '
    'v1.82.1: Pulling from supabase/storage-api\n'
    'toomanyrequests: retry-after: 961.244µs, allowed: 44000/minute; ghcr.io/supabase/storage-api:v1.82.1 attempt 2\n'
    'failed to pull docker image from all registries: ghcr.io/supabase/postgres-meta:v0.100.0 attempt 1: '
    'Error response from daemon: toomanyrequests: retry-after: 84.519µs, allowed: 44000/minute\n'
    'failed to pull docker image from all registries: ghcr.io/supabase/storage-api:v1.82.1 attempt 1: again\n')
THROTTLED_PULL = 'Error response from daemon: toomanyrequests: retry-after: 86.247µs, allowed: 44000/minute\n'


class Fake:
    """Scripted outcomes for `supabase start` and `docker pull`, with a clock that sleeps advance."""

    def __init__(self, starts, pulls=None, start_seconds=0, pull_seconds=0):
        self.starts, self.pulls = list(starts), {k: list(v) for k, v in (pulls or {}).items()}
        self.calls, self.sleeps, self.now = [], [], 0.0
        self.start_seconds, self.pull_seconds = start_seconds, pull_seconds

    def run(self, command):
        self.calls.append(command)
        if command == start.STOP:
            return 0, ''
        if command[:2] == ['docker', 'pull']:
            self.now += self.pull_seconds
            outcomes = self.pulls.get(command[2], [])
            return outcomes.pop(0) if outcomes else (0, 'Status: Downloaded newer image\n')
        self.now += self.start_seconds
        return self.starts.pop(0)

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds

    def clock(self):
        return self.now

    def pulled(self):
        return [c[2] for c in self.calls if c[:2] == ['docker', 'pull']]


class SupabaseStartTests(unittest.TestCase):
    def main(self, fake):
        return start.main(run=fake.run, sleep=fake.sleep, clock=fake.clock)

    def test_a_clean_start_runs_once(self):
        fake = Fake([(0, 'Started supabase local development setup.\n')])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual((fake.calls, fake.sleeps), ([start.COMMAND], []))

    def test_any_other_failure_is_reported_at_once(self):
        fake = Fake([(3, 'Error: port 54322 is already allocated\n')])
        self.assertEqual(self.main(fake), 3)
        self.assertEqual((fake.calls, fake.sleeps), ([start.COMMAND], []))

    def test_throttled_images_are_pulled_one_by_one_before_the_next_start(self):
        fake = Fake([(1, THROTTLED_START), (0, 'Started\n')])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.calls[:2], [start.COMMAND, start.STOP])
        self.assertEqual(fake.pulled(), ['ghcr.io/supabase/storage-api:v1.82.1', 'ghcr.io/supabase/postgres-meta:v0.100.0'])
        self.assertEqual(fake.calls[-1], start.COMMAND)
        self.assertEqual(fake.sleeps, [start.START_PAUSE[0]])

    def test_a_throttled_pull_is_retried_with_short_pauses(self):
        image = 'ghcr.io/supabase/storage-api:v1.82.1'
        fake = Fake([(1, THROTTLED_START), (0, 'Started\n')], {image: [(1, THROTTLED_PULL)] * 3})
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.pulled().count(image), 4)
        self.assertEqual(fake.sleeps, [start.PULL_PAUSE] * 3 + [start.START_PAUSE[0]])

    def test_pull_tries_are_bounded_and_the_next_start_still_runs(self):
        image = 'ghcr.io/supabase/storage-api:v1.82.1'
        fake = Fake([(1, THROTTLED_START), (0, 'Started\n')], {image: [(1, THROTTLED_PULL)] * (start.PULL_TRIES + 5)})
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.pulled().count(image), start.PULL_TRIES)
        # No pause after the last try: the next start follows at once.
        self.assertEqual(fake.sleeps.count(start.PULL_PAUSE), start.PULL_TRIES - 1)

    def test_a_pull_refused_for_another_reason_is_not_retried(self):
        image = 'ghcr.io/supabase/storage-api:v1.82.1'
        fake = Fake([(1, THROTTLED_START), (0, 'Started\n')], {image: [(1, 'manifest unknown\n')]})
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.pulled().count(image), 1)

    def test_only_ghcr_supabase_images_other_than_the_database_are_pulled(self):
        output = ''.join(f'failed to pull docker image from all registries: {name} attempt 1: x\n' for name in (
            'ghcr.io/supabase/postgres:17.6.1.159', 'docker.io/supabase/gotrue:v2.197.0',
            'ghcr.io/evil/gotrue:v2.197.0', 'ghcr.io/supabase/gotrue:v2.197.0;rm', 'ghcr.io/supabase/kong:2.8.1'))
        self.assertEqual(start.failed_images(output + THROTTLED_PULL), ['ghcr.io/supabase/kong:2.8.1'])

    def test_throttling_that_never_clears_stops_after_the_start_limit(self):
        fake = Fake([(1, THROTTLED_START)] * start.STARTS)
        self.assertEqual(self.main(fake), 1)
        self.assertEqual(fake.calls.count(start.COMMAND), start.STARTS)
        self.assertEqual(fake.calls.count(start.STOP), start.STARTS - 1)

    def test_the_deadline_ends_retrying(self):
        images = [f'ghcr.io/supabase/image{n}:v1' for n in range(7)]
        output = ''.join(f'failed to pull docker image from all registries: {i} attempt 1: x\n' for i in images) + THROTTLED_PULL
        fake = Fake([(1, output)] * start.STARTS, {i: [(1, THROTTLED_PULL)] * 1000 for i in images},
                    start_seconds=20, pull_seconds=10)
        self.assertEqual(self.main(fake), 1)
        self.assertLess(fake.calls.count(start.COMMAND), start.STARTS)
        # Every operation is followed by a check, so at most one pull or one pause and start run past it.
        self.assertLessEqual(fake.now, start.DEADLINE + max(start.PULL_PAUSE + 10, max(start.START_PAUSE) + 20))

    def test_the_deadline_also_ends_a_single_image_pull_loop(self):
        image = 'ghcr.io/supabase/storage-api:v1.82.1'
        fake = Fake([(1, THROTTLED_START)] * start.STARTS, {image: [(1, THROTTLED_PULL)] * 1000}, pull_seconds=100)
        self.assertEqual(self.main(fake), 1)
        self.assertLess(fake.pulled().count(image), start.PULL_TRIES)
        self.assertLessEqual(fake.now, start.DEADLINE + 100 + start.PULL_PAUSE)

    def test_real_output_is_streamed_and_captured(self):
        # The CLI reports pull refusals on stderr: they must reach the throttle check too.
        code, output = start.run([sys.executable, '-c', 'import sys; print("toomanyrequests: retry-after: 1ms", file=sys.stderr); raise SystemExit(1)'])
        self.assertEqual(code, 1)
        self.assertIn(start.THROTTLED, output)

    def test_the_command_keeps_the_reviewed_exclusions_and_wiring(self):
        self.assertEqual(start.COMMAND, ['supabase', 'start', '-x', 'studio,mailpit,realtime,edge-runtime,supavisor'])
        action = yaml.load((ROOT / '.github/actions/supabase-stack/action.yml').read_text(), Loader=yaml.BaseLoader)
        steps = [s for s in action['runs']['steps'] if s.get('run') == 'python3 infra/scripts/ci_supabase_start.py']
        self.assertEqual(len(steps), 1)
        self.assertNotIn('continue-on-error', steps[0])


if __name__ == '__main__':
    unittest.main()

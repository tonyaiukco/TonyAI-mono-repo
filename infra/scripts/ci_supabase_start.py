#!/usr/bin/env python3
"""Start the CI Supabase stack, retrying only when the registry throttles image pulls."""
import subprocess
import sys
import time

COMMAND = ['supabase', 'start', '-x', 'studio,mailpit,realtime,edge-runtime,supavisor']
STOP = ['supabase', 'stop', '--no-backup']
# Seconds before attempts 2-4. The CLI's own pull retries give up within seconds while
# GHCR answers `toomanyrequests` (#251); layers already pulled stay, so each retry pulls less.
DELAYS = (30, 90, 180)
THROTTLED = 'toomanyrequests'


def run(command):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    throttled = False
    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        throttled = throttled or THROTTLED in line
    return process.wait(), throttled


def main(run=run, sleep=time.sleep):
    code = 1
    for attempt, delay in enumerate((0,) + DELAYS, 1):
        if delay:
            print(f'Registry throttled the image pulls; retrying in {delay}s '
                  f'(attempt {attempt} of {len(DELAYS) + 1}).', flush=True)
            sleep(delay)
        code, throttled = run(COMMAND)
        # Any other failure is real: report it at once instead of retrying it away.
        if code == 0 or not throttled:
            return code
        run(STOP)  # remove the partial stack; pulled images stay for the next attempt
    return code


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
"""Start the CI Supabase stack, finishing registry-throttled image pulls before retrying."""
import re
import subprocess
import sys
import time

COMMAND = ['supabase', 'start', '-x', 'studio,mailpit,realtime,edge-runtime,supavisor']
STOP = ['supabase', 'stop', '--no-backup']
THROTTLED = 'toomanyrequests'
# Only the exact GHCR Supabase images the CLI itself failed to pull are pulled again. The
# reviewed database image is never pulled here: prepare tags it by digest and verify checks it.
FAILED_IMAGE = re.compile(
    r'failed to pull docker image from all registries: '
    r'(ghcr\.io/supabase/[a-z0-9][a-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*)\s')
DATABASE_REPOSITORY = 'ghcr.io/supabase/postgres:'
# GHCR's `toomanyrequests` carries a retry-after of microseconds (#251, runs 40586552198 and
# 40586552375): it refuses individual blob requests at saturated instants rather than for a
# window. Many short pull tries per image beat a few long sleeps; pulled layers persist.
STARTS = 6
PULL_TRIES = 15
PULL_PAUSE = 4
START_PAUSE = (10, 20, 40, 60, 60)
# Seconds of retrying. Checked after every start and pull and before every pause, so a
# throttled run ends with this message instead of api-integration's 20-minute job timeout.
DEADLINE = 480


def run(command):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines = []
    for line in process.stdout:
        sys.stdout.write(line)
        sys.stdout.flush()
        lines.append(line)
    return process.wait(), ''.join(lines)


def failed_images(output):
    return [image for image in dict.fromkeys(FAILED_IMAGE.findall(output))
            if not image.startswith(DATABASE_REPOSITORY)]


def pull(image, run, sleep, expired):
    for attempt in range(1, PULL_TRIES + 1):
        code, output = run(['docker', 'pull', image])
        # A refusal that is not throttling is left for the next start to report.
        if code == 0 or THROTTLED not in output or attempt == PULL_TRIES or expired():
            return code == 0
        print(f'GHCR throttled {image}; pull try {attempt + 1} of {PULL_TRIES} in {PULL_PAUSE}s.', flush=True)
        sleep(PULL_PAUSE)
    return False


def main(run=run, sleep=time.sleep, clock=time.monotonic):
    started = clock()
    expired = lambda: clock() - started > DEADLINE
    code = 1
    for attempt in range(1, STARTS + 1):
        code, output = run(COMMAND)
        # Any other failure is real: report it at once instead of retrying it away.
        if code == 0 or THROTTLED not in output or attempt == STARTS or expired():
            return code
        run(STOP)  # remove the partial stack; pulled images stay for the next attempt
        for image in failed_images(output):
            if expired():
                break
            pull(image, run, sleep, expired)
        if expired():
            print('Registry throttling outlasted the retry deadline.', flush=True)
            return code
        pause = START_PAUSE[attempt - 1]
        print(f'Registry throttled the stack start; starting again in {pause}s '
              f'(attempt {attempt + 1} of {STARTS}).', flush=True)
        sleep(pause)
    return code


if __name__ == '__main__':
    sys.exit(main())

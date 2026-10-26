"""Bounded smoke children; reap the process group before attempting Auth cleanup."""
import os
import signal
import subprocess
from qa_contract import ROOT, require


def child(script, env):
    require(script in ('smoke-fixtures.mjs', 'image-smoke.mjs'))
    with subprocess.Popen(['node', str(ROOT / 'infra/scripts' / script)], cwd=ROOT,
                          env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          start_new_session=True) as process:
        try:
            require(process.wait(timeout=600) == 0)
        finally:
            # Also reap descendants after a failing parent or interruption. No child
            # may continue fixture writes while exact-ID Auth cleanup is running.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=30)

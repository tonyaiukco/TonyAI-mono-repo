#!/usr/bin/env python3
"""Prepare/apply a private saved R1/R2 plan in the existing backend; never init/replan."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from replacement_bundle import (TF_ROOT, digest, private_read, write_new, encoded, sources,
                                clean_environment, backend_binding)
from replacement_contract import validate_inputs, state_projection
from replacement_plan import validate_plan
from replacement_discovery import check_collisions


def capture(command, env):
    result = subprocess.run(command, env=env, capture_output=True, timeout=900)
    if result.returncode:
        raise ValueError('Private command failed; diagnostics withheld. No automatic retry.')
    return result.stdout


def terraform_capture(command, env, directory, action):
    """Interrupt long writes once, then let Terraform finish and release its lock."""
    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    interrupted = False
    try:
        stdout, stderr = process.communicate(timeout=900)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        interrupted = True
        # A second SIGINT can make Terraform abandon its state write. Ignore
        # further operator interrupts while waiting; never escalate to SIGKILL.
        previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            process.send_signal(signal.SIGINT)
            stdout, stderr = process.communicate()
        finally:
            signal.signal(signal.SIGINT, previous)
    if interrupted or process.returncode:
        write_new(Path(directory) / (action + '.stdout.log'), stdout)
        write_new(Path(directory) / (action + '.stderr.log'), stderr)
        raise ValueError('Terraform failed/interrupted; private packet diagnostics retained. No automatic retry.')
    return stdout


def context(backend_path, input_path, phase):
    env = clean_environment(os.environ)
    backend_bytes = private_read(backend_path); input_bytes = private_read(input_path)
    backend = json.loads(backend_bytes); inputs = json.loads(input_bytes)
    config = validate_inputs(inputs, phase)
    if any(backend[k] != config[k] for k in ('tenant_id', 'subscription_id', 'environment')):
        raise ValueError('Backend and target identity mismatch.')
    binding = backend_binding(backend)
    terraform = shutil.which('terraform', path=env.get('PATH'))
    if not terraform:
        raise ValueError('Pinned Terraform is required.')
    account = json.loads(capture(['az', 'account', 'show', '-o', 'json'], env))
    if any(account[k] != config[v] for k, v in [('id', 'subscription_id'), ('tenantId', 'tenant_id')]):
        raise ValueError('Wrong CLI account.')
    version = json.loads(capture([terraform, 'version', '-json'], env))
    if version['terraform_version'] != '1.13.3':
        raise ValueError('Wrong Terraform version.')
    env.update(ARM_SUBSCRIPTION_ID=config['subscription_id'], ARM_TENANT_ID=config['tenant_id'])
    base = [terraform, '-chdir=' + str(TF_ROOT)]
    if capture(base + ['workspace', 'show'], env).strip() != b'default':
        raise ValueError('Unexpected workspace.')
    binding.update(inputs_sha256=digest(input_bytes), backend_sha256=digest(backend_bytes), phase=phase,
                   generation='r02', source=sources(), tool_sha256=digest(Path(terraform).read_bytes()),
                   tool_version=version, account={'subscription_id': account['id'], 'tenant_id': account['tenantId']})
    return base, env, binding, inputs


def state(base, env, inputs):
    raw = capture(base + ['state', 'pull'], env)
    projection = state_projection(json.loads(raw), inputs['config'])
    return {**projection, 'state_sha256': digest(raw)}


def prepare(backend, inputs_path, phase, directory):
    base, env, binding, inputs = context(backend, inputs_path, phase)
    directory = Path(directory).absolute()
    directory.mkdir(mode=0o700)  # Existing/incomplete packets are never overwritten.
    os.umask(0o077)
    before = state(base, env, inputs)
    if phase == 'R2':
        check_collisions(inputs)
    plan_path = directory / 'saved.tfplan'
    terraform_capture(base + ['plan', '-input=false', '-lock-timeout=60s', '-var-file=' + str(Path(inputs_path).resolve()), '-out=' + str(plan_path)], env, directory, 'plan')
    plan_bytes = private_read(plan_path)
    projection = json.loads(capture(base + ['show', '-json', str(plan_path)], env))
    changes = validate_plan(projection, inputs, phase)
    if state(base, env, inputs) != before:
        raise ValueError('State changed during planning; packet is not approvable.')
    # Re-read all inputs/source/backend/tool bindings after the plan command too.
    if context(backend, inputs_path, phase)[2] != binding:
        raise ValueError('Source or target changed during planning.')
    binding.update(state=before, plan_sha256=digest(plan_bytes), created_at=int(time.time()),
                   projection_sha256=digest(encoded(projection)))
    write_new(directory / 'plan.json', encoded(projection))
    write_new(directory / 'review.json', encoded({'phase': phase, 'changes': changes, 'binding': binding}))
    write_new(directory / 'binding.json', encoded(binding))
    print('PASS: private saved plan prepared; no apply. Review the private packet before separate approval.')
    print('Approval binding SHA256: ' + digest(encoded(binding)))


def apply(backend, inputs_path, phase, directory, approved_sha256):
    directory = Path(directory).absolute()
    binding_bytes = private_read(directory / 'binding.json')
    if digest(binding_bytes) != approved_sha256:
        raise ValueError('Explicit approved binding hash does not match.')
    binding = json.loads(binding_bytes)
    if not 0 <= time.time() - binding['created_at'] <= 7200:
        raise ValueError('Plan approval expired; obtain a newly reviewed packet.')
    base, env, current, inputs = context(backend, inputs_path, phase)
    if current != {k: v for k, v in binding.items() if k not in ('state', 'plan_sha256', 'created_at', 'projection_sha256')}:
        raise ValueError('Source/input/backend/tool/account binding changed.')
    plan_path = directory / 'saved.tfplan'
    if digest(private_read(plan_path)) != binding['plan_sha256'] or state(base, env, inputs) != binding['state']:
        raise ValueError('Saved plan or state changed after review.')
    projection = json.loads(capture(base + ['show', '-json', str(plan_path)], env))
    if digest(encoded(projection)) != binding['projection_sha256']:
        raise ValueError('Saved plan projection changed.')
    validate_plan(projection, inputs, phase)
    if phase == 'R2':
        check_collisions(inputs)
    # A saved-plan apply is inherently noninteractive: explicit hash is mandatory.
    # Terraform's own state lock/stale-plan check closes the state-pull/apply race.
    write_new(directory / 'apply-attempt.json', encoded({'approved_binding': approved_sha256, 'started_at': int(time.time())}))
    terraform_capture(base + ['apply', '-input=false', '-lock-timeout=60s', str(plan_path)], env, directory, 'apply')
    write_new(directory / 'apply-completed.json', encoded({'completed_at': int(time.time())}))
    print('PASS: exact saved plan applied. Live readback and acceptance remain required.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'apply'])
    parser.add_argument('--phase', choices=['R1', 'R2'], required=True)
    for name in ('backend', 'inputs', 'packet'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--approved-sha256')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.backend, args.inputs, args.phase, args.packet)
    else:
        if not args.approved_sha256:
            raise ValueError('A separately approved packet SHA256 is mandatory.')
        apply(args.backend, args.inputs, args.phase, args.packet, args.approved_sha256)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.exit('FAIL: replacement operation refused/interrupted; private diagnostics withheld. Preserve the packet; do not retry apply automatically.')

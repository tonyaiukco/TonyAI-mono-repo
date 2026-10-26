#!/usr/bin/env python3
"""Distribute the complete R3 registry without changing its mutation runner."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SHARDS = 4


def select(mutations, shard):
    if type(shard) is not int or not 0 <= shard < SHARDS or len(mutations) < SHARDS:
        raise ValueError('Invalid or empty mutation shard.')
    names = [(mutation[0], mutation[1]) for mutation in mutations]
    if len(names) != len(set(names)):
        raise ValueError('Duplicate mutation identities.')
    return mutations[shard::SHARDS]


def verify(report, selected):
    expected = [(mutation[0], mutation[1]) for mutation in selected]
    actual = [(item['file'], item['name']) for item in report['mutations']]
    if (actual != expected or not expected
            or any(item['result'] != 'KILLED' for item in report['mutations'])
            or report['killed'] != len(expected) or report['survived'] != []
            or report['invalid'] != 0 or report['baseline'] != 'PASS'
            or report['node_baseline'] != 'PASS' or report['source_unchanged'] is not True
            or not report['source_sha256']):
        raise ValueError('Incomplete or unsuccessful mutation shard.')


def run(runner, shard, output):
    selected = select(runner.MUTATIONS, shard)
    runner.install_sigterm()
    if runner.main(output, mutations=selected):
        raise ValueError('Mutation runner failed.')
    verify(json.loads(Path(output).read_text()), selected)
    print(f'Shard {shard + 1}/{SHARDS}: {len(selected)}/{len(runner.MUTATIONS)} mutations verified.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shard', type=int, required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(ROOT / 'infra/tests'))
    import r3_mutations
    run(r3_mutations, args.shard, args.output)

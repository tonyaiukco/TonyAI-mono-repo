"""Public, fixed-vocabulary failure status for the disposable composition smoke."""
from contextlib import contextmanager
import json
import sys

PHASES = frozenset({
    'ARGUMENTS', 'RUNNER_GUARD', 'ROOT_GUARD', 'NODE_VERSION', 'DOCKER_INFO',
    'IMAGE_STORE', 'DOCKER_VERSION', 'COMPOSE_VERSION', 'EMPTY_RUNNER',
    'STAGE_SOURCES', 'GENERATE_SETTINGS', 'BIND_DIRECTORIES', 'REDACT_GATEWAY',
    'COMPOSE_RENDER', 'COMPOSE_VALIDATE', 'IMAGE_PULL', 'IMAGE_IDENTITY',
    'DATABASE_POLICY', 'SEED_CREATE', 'SEED_COPY', 'SEED_CLEANUP',
    'SEED_METADATA', 'DATABASE_START', 'DATABASE_KEY', 'SERVICES_START',
    'SERVICES_INSPECT', 'SERVICES_VALIDATE', 'REPORT_BUILD', 'COMPOSE_CLEANUP',
    'REPORT_WRITE',
})
CLEANUP_STATES = frozenset({'NOT_STARTED', 'STARTED', 'SUCCEEDED', 'FAILED'})


class SmokeStatus:
    def __init__(self):
        self.phase = 'ARGUMENTS'
        self.seed_cleanup = 'NOT_STARTED'
        self.compose_cleanup = 'NOT_STARTED'

    def at(self, phase):
        if phase not in PHASES:
            raise ValueError('Unknown smoke phase.')
        self.phase = phase

    @contextmanager
    def cleanup(self, kind):
        if kind not in ('seed', 'compose'):
            raise ValueError('Unknown cleanup scope.')
        primary, unwinding = self.phase, sys.exc_info()[0] is not None
        self.at('SEED_CLEANUP' if kind == 'seed' else 'COMPOSE_CLEANUP')
        field = kind + '_cleanup'
        setattr(self, field, 'STARTED')
        try:
            yield
        except Exception:
            setattr(self, field, 'FAILED')
            raise
        else:
            setattr(self, field, 'SUCCEEDED')
        finally:
            if unwinding:
                self.phase = primary

    def failure(self):
        # Never interpolate exception/command/runtime data, even on an unexpected
        # state. Cleanup success means that command returned zero, not host proof.
        return 'FAIL: composition smoke ' + json.dumps({
            'phase': self.phase if self.phase in PHASES else 'UNKNOWN',
            'seed_cleanup': self.seed_cleanup if self.seed_cleanup in CLEANUP_STATES else 'UNKNOWN',
            'compose_cleanup': self.compose_cleanup if self.compose_cleanup in CLEANUP_STATES else 'UNKNOWN',
        }, sort_keys=True)

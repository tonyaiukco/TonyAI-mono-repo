# Spec Delta

## Purpose

Defines how the API process ends when it cannot boot, so an orchestrator and an operator always see a failed start as a failure.

## ADDED Requirements

### Requirement: A failed boot exits non-zero

When the API cannot boot, the process SHALL exit with code 1, whether or not Sentry is configured. When Sentry is configured, the failure SHALL be reported and flushed first, within a bound. Neither a slow nor a failing flush SHALL change the exit code or keep the process alive past the bound. The log SHALL NOT carry a connection string.

#### Scenario: Database down with Sentry on

- **WHEN** the API boots with the database down and a Sentry DSN set
- **THEN** the failure reaches Sentry and the process exits 1

#### Scenario: Database down with Sentry off

- **WHEN** the API boots with the database down and no DSN
- **THEN** the process exits 1

#### Scenario: The flush fails

- **WHEN** the flush rejects or times out
- **THEN** the process still exits 1

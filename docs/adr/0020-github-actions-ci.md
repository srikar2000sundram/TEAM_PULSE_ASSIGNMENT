# ADR-0020: GitHub Actions for continuous integration

**Status:** Proposed

## Context

The project already has one command, `npm run verify`, that proves a change is sound. It only helps if
it runs on every change, on a clean machine, and cannot be skipped.

## Decision

1. **GitHub Actions** runs `npm run verify` on every push to `main` and every pull request.
2. A separate **audit** job fails on high or critical advisories in production dependencies.
3. An **images** job builds both image targets and scans them with Trivy.
4. **Dependabot** proposes weekly updates for npm, actions and base images.
5. Workflows get read-only permissions and cancel superseded runs.

## Alternatives considered

- **Another CI system.** Nothing in the repository ties us to GitHub, but the code will be hosted
  there and Actions needs no extra account.
- **Only local checks.** Easy to forget or skip.

## Consequences

- (+) Every change is checked the same way, on a clean machine.
- (+) Known vulnerable dependencies and images are caught early.
- (-) The workflow is unproven until its first run.
- (-) Running the whole suite takes a few minutes per push.

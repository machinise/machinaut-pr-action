# Changelog

Notable changes to this action. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Consumers should pin the moving major alias
(`@v1`), which the release workflow re-points at each `v1.x.y` release.

## [Unreleased]

### Added

- Release workflow that re-points the `v1` major alias at each published
  `v1.x.y` release — and refuses to do so if the tagged tree's `dist/` bundle is
  stale, since consumers execute `dist/index.js` directly.
- Dependabot for the workflows' actions and for npm dependencies.
- This changelog.

### Changed

- Marketplace-facing copy in `action.yml` (the listing blurb and input help) no
  longer uses internal roadmap jargon, while keeping the sign-in-walled framing
  explicit.
- CI now uses `actions/checkout@v7` / `actions/setup-node@v7`, clearing the
  Node 20 deprecation warning.

## [1.0.0] - 2026-07-20

Tagged (`v1.0.0`, aliased by `v1`), but **not yet listed on the GitHub
Marketplace** and **not yet exercised against a production Machinaut control
plane** — that live run on a real agent-authored PR remains the outstanding
validation.

### Added

- Sticky pull-request comment carrying an agent-authored PR's Lodestar evidence
  trail: headline chips (events · agents · verdict · wall-clock) derived from the
  session projection, a verbatim teaser quoted from the Lodestar trust report, and
  a deep link to the session in Machinaut.
- Idempotent behaviour — the comment is keyed by a hidden marker and updated in
  place on re-runs, so a PR carries exactly one evidence comment. A marker comment
  the token cannot edit is skipped rather than allowed to block posting.
- Trigger by shipped session: an empty `session-id` is a clean no-op, so the
  action only speaks up when CI actually shipped a session for the run.
- PR resolution across `pull_request`, `pull_request_target`, `issue_comment`,
  `workflow_run`, `push`, and `merge_group`, using each event's real head commit
  and skipping events where no PR can be determined.
- Inputs: `machinaut-api-key`, `project-id`, `session-id`, `api-url`,
  `console-url`, `github-token`, `fail-on-error`.
- Outputs: `comment-id`, `comment-url`, `session-url`, `status`.
- `fail-on-error` defaults to `false` so a non-critical evidence comment never
  turns a PR check red; genuine failures are still surfaced as warnings.

### Notes

- Verified by 55 unit tests plus five end-to-end scenarios driven through the
  bundled `dist/index.js` against a stubbed Machinaut and GitHub API (comment
  creation, idempotent update, PR-lookup failure vs. clean skip, an uneditable
  marker comment, and event gating).
- The console link is sign-in-walled by design: a project key is read-only and
  cannot mint a public share, so this release links to your team's console
  session rather than a public page.

# Changelog

Notable changes to this action. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Consumers should pin the moving major alias
(`@v1`), which the release workflow re-points at each `v1.x.y` release.

## Unreleased

### Added

- **Public post-mortem link (planned; the control-plane endpoint is not deployed yet).** New
  optional input `machinaut-publish-token`: a separate, owner-minted CI publish token (`mp_…`).
  When set, comment mode calls `POST /v1/publish/shares` with `{ project_id, session_id, subject }`
  (subject `github.com/<owner>/<repo>/pull/<n>`; no label, because a label is public), and leads the
  sticky comment with the public `/s/:token` link, labelled "Public post-mortem link (Beta). Anyone
  with the link can view it. Expires `<date>`." A reuse (200) and a new link (201) are both
  success. The console deep link stays below it.
- New outputs `share-url` and `publish` (`published`, `reused`, or `skipped:<reason>`).
- Forks never publish, on any event (`pull_request`, `pull_request_target`, `workflow_run`,
  `issue_comment` — the last checked through the GitHub API, refusing if that check fails).
- No token, a fork, or any refusal or error (400/401/402/403/404/409/429/5xx, network) falls back to
  the console deep link, plus one line saying why when the token is set. A publish problem never
  fails the step, whatever `fail-on-error` says. With the token unset the comment is unchanged.
- The token is masked as soon as it is read; a value without the `mp_` prefix (for example a
  project key) is refused locally and never sent. Gate mode ignores the input.

### Changed

- Internal: comment mode moved from `main.ts` to `commentRun.ts` with injected dependencies, so it
  is unit-tested like gate mode. Its existing behaviour is unchanged.

## 2.0.2 — 2026-11-07

### Changed

- PR comments: footer link, ref tags and docs links (issues 15, 16, 17; #18).

## 2.0.1 — 2026-11-06

### Fixed

- Gate mode, reusable workflows (#12): the sticky comment's `gh attestation verify
  … --signer-workflow` recipe is now read from the bundle's own signing
  certificate (its SAN URI, which Fulcio issues from the job's
  `job_workflow_ref`), instead of from `GITHUB_WORKFLOW_REF`. Inside a reusable
  workflow the two differ — `GITHUB_WORKFLOW_REF` names the caller — so the old
  recipe could fail to verify. Only a bundle with no readable certificate falls
  back to `GITHUB_WORKFLOW_REF`, and the comment then labels the value "(derived
  from the workflow ref; may differ for reusable workflows)".

### Added

- Gate output `signer-identity`: the signing certificate's SAN URI
  (`https://github.com/<owner>/<repo>/.github/workflows/<file>@<ref>`), when
  signed. The verdict comment shows it as **Signer identity** and says that the
  Machinaut console's signer-identity pin (beta) must equal it exactly. The
  README documents that for a reusable workflow the pin must name the reusable
  workflow's file.

## [2.0.0] - 2026-11-06

Floating tag `v2`. Gate mode
asks for new job permissions and pins a signed predicate, so it gets its own major;
comment mode is unchanged and `v1` consumers are unaffected. Gate mode is **beta**.
First live run (2026-11-06): test PR #9, signed run `42055483871`, attestation
<https://github.com/machinise/machinaut-pr-action/attestations/64097467>; the
decision was `fail` for the demo session's unresolved hold — an honest result,
not a bug.

### Added

- **Gate mode (beta)** — `mode: gate` (Track G, slice G1). Fetches the session's
  governance summary with the project key, evaluates the repo's policy in CI,
  builds an in-toto Statement v1 (predicate type
  `https://machinaut.ai/attestation/governed-run/v1`, subjects = the PR head
  commit + the evaluated summary's sha256), signs it Sigstore-keyless with the
  workflow's own OIDC identity via `@actions/attest`, stores it in the repo's
  GitHub attestation store, refreshes a sticky verdict comment, and **fails the
  step on `decision: fail`**. Machinaut serves facts only — it never decides and
  never signs.
- Gate inputs: `mode`, `require-holds-resolved` (default `true`; `relay_only` /
  `unavailable` holds and a truncated hold list fail), `require-bound-approvals`
  (default `false`), `max-sentinel-severity` (default `warning`),
  `allow-unreadable` (default `false`: records withheld below the `secret`
  ceiling fail closed), `dry-run` (default `false`).
- Gate outputs: `decision`, `reasons` (JSON), `attestation`
  (`signed | signed-not-stored | skipped:dry-run | skipped:fork |
  skipped:permissions | failed`), `attestation-url`, `bundle-path`,
  `statement-path`, `summary-path`.
- Signing is skipped — visibly, in the comment, the log and the outputs — on
  dry-run, fork `pull_request` runs, and missing `id-token: write`; a signing
  failure is reported as such and never passed off as signed.
- `examples/governed-run-gate.yml`; README "Gate mode (beta)" section (permissions,
  required-check setup, `gh attestation verify` recipe, candor).
- Attestation intake upload (Track G, G2 follow-up, **beta**): after signing, the
  bundle is POSTed to `/v1/projects/:p/sessions/:s/attestations` (project key,
  `application/vnd.dev.sigstore.bundle.v0.3+json`, 415 falls back to
  `application/json`, 15 s timeout, one retry on network error). New input
  `post-attestation` (default `true`) and output `intake` (`recorded |
  not_available | rejected | failed | not_attempted`); the sticky comment gains a
  "Recorded in Machinaut" line. Reporting only: the outcome never changes the
  decision or fails the step, and the action does not claim Machinaut verified
  anything — verification status appears in the console.

- The signed sticky comment now includes the exact `gh attestation verify
  machinaut-governance-summary.json --repo … --predicate-type … --signer-workflow …`
  recipe (one fenced line) and names the `machinaut-governed-run` artifact file.
- Predicate `gate.action_ref` (`GITHUB_ACTION_REF`) and `gate.action_repository`
  (`GITHUB_ACTION_REPOSITORY`): how the action was actually invoked (e.g. a bare
  SHA), alongside the `gate.action` version. Omitted when GitHub does not set them.

### Changed

- `fail-on-error` default is now mode-dependent: still `false` in comment mode
  (behaviour unchanged), `true` in gate mode, so a required check that could not
  read the facts or produce its attestation does not go green.

### Release tooling

- The release workflow refuses a tag that differs from `src/version.ts`, the
  version gate mode records in every signed statement (`gate.action`).

## [1.0.0] - 2026-07-21

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

### Release tooling

- Release workflow that re-points the `v1` major alias at each published
  `v1.x.y` release — and refuses to do so if the tagged tree's `dist/` bundle is
  stale, since consumers execute `dist/index.js` directly.
- Dependabot for the workflows' actions and for npm dependencies.
- CI runs on `actions/checkout@v7` / `actions/setup-node@v7` (no Node 20
  deprecation warning).
- Marketplace-facing copy in `action.yml` avoids internal roadmap jargon while
  keeping the sign-in-walled framing explicit.

### Notes

- Verified by 55 unit tests plus five end-to-end scenarios driven through the
  bundled `dist/index.js` against a stubbed Machinaut and GitHub API (comment
  creation, idempotent update, PR-lookup failure vs. clean skip, an uneditable
  marker comment, and event gating).
- The console link is sign-in-walled by design: a project key is read-only and
  cannot mint a public share, so this release links to your team's console
  session rather than a public page.

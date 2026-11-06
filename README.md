# machinaut-pr-action

A GitHub Action for [Machinaut](https://machinaut.ai): it posts governance evidence from the
session behind a PR; in gate mode it fails the check when the repo's gate policy is not met,
signed by the repo's own CI.

> **Status: comment mode shipped — `v1` tagged; Marketplace listing pending.** The action is
> implemented and unit-tested (CI green: typecheck · test · build · check-dist), and verified
> end-to-end against a **stubbed** API (create + idempotent update). Comment mode has **not
> yet been exercised on a live agent-authored PR** — that run is the remaining validation before
> calling it battle-tested. Gate mode, by contrast, has run live (see below).
>
> **[Gate mode](#gate-mode-beta) — beta, released in `v2.0.0` (floating tag `v2`):** evaluate a run's governance
> facts against your policy, sign the decision with your CI's Sigstore identity, and fail a
> required check. First live run: see [below](#first-live-run-2026-11-06).

## What it does

When a CI run has shipped a Lodestar session for a PR (via `lodestar ship` to Machinaut),
this action posts — and on re-runs **updates in place** — a single sticky comment carrying the
agent's evidence trail:

- headline chips derived from the session's structured projection — **events · agents · verdict · wall-clock**;
- a short **report preview**, quoted *verbatim* from the Lodestar report (never parsed as data);
- a **deep link** to the Machinaut console session, honestly labeled as **login-walled** (team
  members already in your org) — **not** a public post-mortem.

The action is a **read-only API client**. In comment mode it calls exactly one endpoint,
`GET /v1/projects/:p/sessions/:s?report=1`, with your existing project key (gate mode calls
`GET …/sessions/:s/governance` instead). It never runs the agent writer, and it holds no secrets of
its own (you supply your Machinaut credential as a repo secret). See [Invariants](#invariants).

## Usage

Add this to the **consumer** repo (full example in [`examples/`](./examples/machinaut-evidence.yml)):

```yaml
permissions:
  contents: read
  pull-requests: write   # required so the action can post/update the sticky comment

steps:
  # Your agent runs and ships its Lodestar session, exporting the id it just shipped:
  - id: ship
    run: echo "session-id=$SESSION_ID" >> "$GITHUB_OUTPUT"
    env: { MACHINAUT_API_KEY: ${{ secrets.MACHINAUT_API_KEY }} }

  - uses: machinise/machinaut-pr-action@v1
    with:
      machinaut-api-key: ${{ secrets.MACHINAUT_API_KEY }}
      project-id: your-project-id
      session-id: ${{ steps.ship.outputs.session-id }}
```

**Trigger:** the *presence of a shipped session is the signal* that a PR is
agent-authored. When `session-id` is empty (nothing shipped this run), the action cleanly
no-ops — no heuristic, no false positives.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `machinaut-api-key` | yes | — | Your Machinaut project key (a repo secret). Used **read-only**. |
| `project-id` | yes | — | The Machinaut project the shipped session belongs to. |
| `session-id` | yes | — | The Lodestar session id CI just shipped. Empty → the action no-ops. |
| `api-url` | no | `https://console.machinaut.ai` | Base origin of your Machinaut deployment (API + console). |
| `console-url` | no | = `api-url` | Console origin for the deep link, if it differs from the API. |
| `github-token` | no | `${{ github.token }}` | Token used to post/update the comment. |
| `fail-on-error` | no | `false` | When `false`, problems log a warning and exit 0 so a non-critical evidence comment never red-Xes a PR. (Gate mode defaults to `true` — see [Gate mode](#gate-mode-beta).) |
| `mode` | no | `comment` | `comment` (this section) or `gate` ([beta](#gate-mode-beta)). |

### Outputs

| Output | Description |
|---|---|
| `comment-id` | Numeric id of the sticky comment (empty if skipped). |
| `comment-url` | `html_url` of the sticky comment (empty if skipped). |
| `session-url` | The console deep link to the session. |
| `status` | `created`, `updated`, or `skipped:<reason>`. |

## Gate mode (beta)

> **Status: beta, released in `v2.0.0` (floating tag `v2`).** Gate mode needs a control plane that
> serves `GET /v1/projects/:p/sessions/:s/governance` (`governance_summary@1`, itself **beta**); the
> hosted console (v0.5.0) serves it and the attestation route. Live-verified on 2026-11-06 with both
> outcomes: `fail` in [PR #9](https://github.com/machinise/machinaut-pr-action/pull/9) and `pass`
> (signed, recorded, console `verified`) in
> [PR #11](https://github.com/machinise/machinaut-pr-action/pull/11), with its
> [attestation](https://github.com/machinise/machinaut-pr-action/attestations/64302344). Still
> **beta**.

`mode: gate` turns the action into a **required check** for agent-authored PRs:
*an agent PR merges only when your own CI has fetched the governance facts for the run that
produced it, decided they meet your repo's bar, and signed that decision with your CI's identity.*

```
your CI (this action)                         Machinaut                       your kernel (Lodestar OSS)
fetch the facts ───── GET …/governance ─────▶ serves facts only               adjudicates holds, verifies
evaluate YOUR policy                          (never a merge verdict)         signatures, records quorum —
build the in-toto statement                                                   all shipped as events
SIGN it (Sigstore keyless, this workflow)
pass / fail the check  ◀── GitHub branch protection enforces it
```

- **Facts come from Machinaut; the decision and the signature are yours.** The action evaluates
  the summary against *your* inputs, decides, and signs with this workflow's GitHub OIDC identity
  via [`@actions/attest`](https://github.com/actions/toolkit/tree/main/packages/attest). Machinaut
  never signs and never emits "mergeable".
- **The signature verifies without Machinaut** — see [Verify without Machinaut](#verify-without-machinaut).
- **Only PRs with a shipped session are gated.** With an empty `session-id` the step skips as
  not-applicable (and passes), exactly like comment mode: the gate cannot detect an agent-authored
  PR that shipped nothing.

### Permissions

```yaml
permissions:
  contents: read
  pull-requests: write   # the sticky verdict comment
  id-token: write        # Sigstore keyless signing with this workflow's OIDC identity
  attestations: write    # store the signed attestation in this repo's attestation store
```

GitHub artifact attestations need a **public repository or GitHub Enterprise Cloud**. On a private
repo the toolkit signs with GitHub's own Sigstore instance (no public Rekor entry).

### Usage

Full workflow: [`examples/governed-run-gate.yml`](./examples/governed-run-gate.yml).

```yaml
name: machinaut
on: pull_request
jobs:
  governed-run:                 # → check name `machinaut / governed-run`
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, id-token: write, attestations: write }
    steps:
      - id: ship
        run: echo "session-id=$SESSION_ID" >> "$GITHUB_OUTPUT"   # your agent + `lodestar ship`
      - id: gate
        uses: machinise/machinaut-pr-action@v2                    # floating tag; pin an exact tag or SHA for reproducibility
        with:
          mode: gate
          machinaut-api-key: ${{ secrets.MACHINAUT_API_KEY }}
          project-id: your-project-id
          session-id: ${{ steps.ship.outputs.session-id }}
          dry-run: true          # start here: evaluate + comment, never sign, never fail
```

### Gate inputs

| Input | Default | Meaning |
|---|---|---|
| `mode` | `comment` | `gate` turns this on. |
| `require-holds-resolved` | `true` | Every hold must be `granted` or `denied` **with `evidence: host_record`** (your kernel shipped the record). `relay_only` and `unavailable` count as unresolved . A truncated hold list (`holds_truncated: true`; the summary caps `holds[]` at 50) fails. |
| `require-bound-approvals` | `false` | Every granted hold must carry an ADR-0042 `action_representation_hash` (`sha256:<inputs_hash hex>`) — the approval is bound to the exact action. A truncated hold list fails this rule too. |
| `max-sentinel-severity` | `warning` | Highest sentinel severity tolerated: `warning` → any `critical` fails; `info` → any `warning` or `critical` fails; `critical` → sentinels never fail. |
| `allow-unreadable` | `false` | Below the `secret` ceiling the shipper withholds approval and sentinel records, so Machinaut reports them only as counts (`unreadable.approval_requests`, `unreadable.sentinel_alerts`) — a withheld critical alert would otherwise read as `critical: 0`. **Default: fail closed** — unreadable approval requests fail the hold rules, unreadable sentinel alerts fail the sentinel rule. `true` records them as a stated reason that does not fail. |
| `post-attestation` | `true` | After signing, POST the Sigstore bundle to Machinaut's attestation intake (`/v1/projects/:p/sessions/:s/attestations`, project key) so the console can verify and label it. **Beta.** `false` skips the upload. The outcome never changes the decision or fails the step. |
| `dry-run` | `false` | Evaluate, write the statement and comment — but **do not sign** and **never fail the step**. |
| `fail-on-error` | `true` in gate mode | Infrastructure errors — Machinaut unreachable, an unsupported summary version, a signing failure, a comment failure — fail the step (fail closed). `false` downgrades them to warnings (fail open). |

**Step outcome.** `decision: fail` always fails the step, whatever `fail-on-error` says — that is
what makes the check meaningful. Infrastructure errors follow `fail-on-error`. `dry-run` never fails
the step. When the facts can't be read the comment says so and **no decision is made and nothing is
signed**.

### Gate outputs

| Output | Description |
|---|---|
| `decision` | `pass` or `fail` (empty if the gate could not evaluate). |
| `reasons` | JSON array: failure reasons first, then any stated non-failing caveats (`allow-unreadable`). `[]` on a clean pass. |
| `attestation` | `signed`, `signed-not-stored`, `skipped:dry-run`, `skipped:fork`, `skipped:permissions`, or `failed`. |
| `intake` | `recorded`, `not_available` (this console has no intake yet), `rejected` (401/403/409/413), `failed`, or `not_attempted` (dry-run, unsigned, or `post-attestation: false`). Reporting only. |
| `attestation-url` | The GitHub attestation page, when stored. |
| `bundle-path` | The Sigstore bundle (JSON), when signed — for offline `gh attestation verify --bundle`. |
| `signer-identity` | The signing certificate's SAN URI, when signed — `https://github.com/<owner>/<repo>/.github/workflows/<file>@<ref>`, the workflow that actually signed (for a [reusable workflow](#reusable-workflows), the reusable one). Your Machinaut console's signer-identity pin must equal it exactly. Empty when the bundle has no readable certificate. |
| `statement-path` | The in-toto statement that was (or, unsigned, would be) signed — byte-identical to the signed payload. |
| `summary-path` | The canonical governance summary the gate evaluated (the statement's sha256 subject). |
| `status`, `comment-id`, `comment-url`, `session-url` | As in comment mode (the gate posts its own sticky verdict comment). |

### When signing is skipped — or fails

Signing is skipped, and labelled **unsigned** in the comment, the log and `attestation`, in exactly
three cases: **`dry-run`**, a **`pull_request` from a fork** (GitHub gives fork PR runs no OIDC token
and no secrets), and **missing `id-token: write`** (warned, with the fix). Anything that goes wrong
once signing starts is a **signing failure** — reported as `attestation: failed` and, under the gate
default, a failed step; never passed off as signed. If GitHub signs but refuses to *store* the
attestation (missing `attestations: write`, or a private repo without Enterprise Cloud), the output is
`signed-not-stored`, the bundle is still written to `bundle-path`, and the comment says so.

When signed, the bundle is also sent to Machinaut's attestation intake (`post-attestation`, default
`true`, **beta**). The sticky comment reports only whether the upload happened
(`Recorded in Machinaut: yes / not available on this console / rejected / failed / not attempted`);
Machinaut's own verification status appears in the console, not here. The upload is display, never
authority — a failed or unavailable intake changes neither the decision nor the step result, and the
signature verifies without Machinaut.

### Make it a required check

1. Commit the workflow (workflow `name: machinaut`, job `governed-run`) and let it run once on a PR,
   so GitHub knows the check.
2. **Settings → Rules → Rulesets** (or **Branches → Branch protection rules**) for your default
   branch → **Require status checks to pass** → add **`governed-run`** — shown on PRs as
   `machinaut / governed-run`.
3. Recommended: also require the branch to be up to date, so the gated commit is the one that merges.

GitHub enforces this rule; Machinaut cannot block (or unblock) a merge.

### The statement

An [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md),
predicate type `https://machinaut.ai/attestation/governed-run/v1`:

- **Subjects:** (1) the PR head commit — `{"name": "<owner>/<repo>", "digest": {"gitCommit": "<sha>"}}`;
  (2) the evidence document the gate evaluated — `{"name": "machinaut-governance-summary.json",
  "digest": {"sha256": …}}`. The second subject exists because GitHub's attestation store and
  `gh attestation verify` look attestations up by an artifact's sha256 and cannot match a
  `gitCommit`-only subject; it adds no data (it is the predicate minus `gate`).
- **Predicate:** the `governance_summary@1` facts verbatim — `machinaut` (console, project/session
  ids, `as_of`), `chain` (event counts, redacted commitments, `chain_digest`, seq bounds), `holds[]`
  (request id, ADR-0042 hash, outcome, evidence, ADR-0041 quorum `k`/`m`/`record_digest`),
  `holds_truncated`, `sentinels` (counts by severity), `unreadable` (counts) — plus a `gate` block
  written by this action: `action` (this build's release version, e.g.
  `machinise/machinaut-pr-action@v2.0.0`), `action_ref` (`GITHUB_ACTION_REF` — how the action was
  actually invoked: a tag, branch or bare SHA; omitted when GitHub does not set it),
  `action_repository` (`GITHUB_ACTION_REPOSITORY`; omitted when unset), `policy`, `decision`,
  `reasons`. `action` states the version the build claims; `action_ref` states what was really
  pinned — they differ when the action is invoked by SHA.
- **Privacy:** digests, ids, counts, enums and timestamps only — never payloads, prompts, approval
  reason text or actor names. Unknown fields in the summary are dropped before signing (and logged;
  the summary's own `beta: true` endpoint label is ignored silently),
  and the action refuses to sign a predicate carrying any field outside this schema. Public-repo
  statements land in the public Rekor transparency log.

### Verify without Machinaut

With the evidence files the example workflow uploads as an artifact (`machinaut-governed-run`):

```bash
gh attestation verify machinaut-governance-summary.json \
  --repo <owner>/<repo> \
  --predicate-type https://machinaut.ai/attestation/governed-run/v1 \
  --signer-workflow <owner>/<repo>/.github/workflows/governed-run.yml
```

This checks — against GitHub and Sigstore, not Machinaut — that your workflow signed a governed-run
statement over that exact summary. Then confirm *which commit* and *what decision* it covers (a
signed `fail` verifies too):

```bash
gh attestation verify machinaut-governance-summary.json --repo <owner>/<repo> \
  --predicate-type https://machinaut.ai/attestation/governed-run/v1 --format json \
  --jq '.[].verificationResult.statement | {commit: .subject[0].digest.gitCommit, decision: .predicate.gate.decision}'
```

- **Offline:** add `--bundle governed-run.sigstore.json`.
- **No summary file?** Rebuild it byte-for-byte from the signed statement:
  `jq -cjS '.predicate | del(.gate)' governed-run.intoto.json > machinaut-governance-summary.json`
  (from a bundle: `jq -r .dsseEnvelope.payload governed-run.sigstore.json | base64 -d | jq -cjS '.predicate | del(.gate)'`).
- **The facts re-derive too:** `chain_digest` is recomputable from your own local NDJSON; the recipe
  lives in the control-plane reference docs alongside the `/governance` route.

When the run is signed, the sticky comment carries this same recipe as one fenced line (with your
repo and workflow filled in) and names the `machinaut-governance-summary.json` file in the
`machinaut-governed-run` artifact to verify. Its `--signer-workflow` is **read from the signing
certificate** — the SAN Fulcio issued from the job's `job_workflow_ref` claim, which is exactly
what `gh attestation verify --signer-workflow` matches — not guessed from `GITHUB_WORKFLOW_REF`.
The comment also shows that SAN as **Signer identity** (and the action outputs it as
`signer-identity`). Only if a bundle carries no readable certificate does the recipe fall back to
`GITHUB_WORKFLOW_REF`, and the comment then says it is *derived from the workflow ref; may differ
for reusable workflows*.

#### Reusable workflows

If the gate step runs inside a [reusable workflow](https://docs.github.com/actions/sharing-automations/reusing-workflows),
the certificate names the **reusable** workflow (`<owner>/<repo>/.github/workflows/<reusable>.yml@<ref
it was called at>`), not the caller — while `GITHUB_WORKFLOW_REF` names the caller. So:

- `gh attestation verify` needs `--signer-workflow <owner>/<repo>/.github/workflows/<reusable>.yml`
  (the comment's recipe already says this); `--repo` stays the repo the PR is in.
- The Machinaut console's signer-identity pin (**beta**) is matched exactly against the SAN, so it
  must name the **reusable workflow's file** and the ref it was called at (e.g. `refs/heads/main`
  or `refs/tags/v1`) — not the caller workflow. Copy both from the comment's **Signer identity**
  line or the `signer-identity` output.

### First live run (2026-11-06)

Gate mode has now run against a live Machinaut control plane: test
[PR #9](https://github.com/machinise/machinaut-pr-action/pull/9) (dry run
`42055217054`, signed run `42055483871`), with the
[attestation](https://github.com/machinise/machinaut-pr-action/attestations/64097467) stored in
GitHub. The decision was `fail` because the demo session's hold is unresolved — an honest result,
not a bug. Gate mode remains **beta**.

### What the gate is *not*

- It proves **what your CI asserted about what Machinaut held at `as_of`**, signed by your CI's
  identity. It does not prove the agent *could not* have misbehaved, and it does not prove the event
  log is complete (the shipper ships what the writer wrote; a writer bypass is invisible here).
- Hash verification, approval signature verification, quorum adjudication, redaction and sentinel
  detection are **[Lodestar](https://github.com/qmilab/lodestar) OSS** properties. Machinaut's value
  here is the hosted summary, the predicate standard and this gate workflow (verification display
  and the fleet view of attested PRs are **planned**).
- A `relay_only` hold is **not** a verified approval. A session with redacted records is attested by
  commitment, not content. Records withheld below the `secret` ceiling are counted, not evaluated.
- GitHub enforces the required check (branch protection is yours); Machinaut cannot block a merge
  and never claims to.

## Why the link is login-walled (and a public share, planned)

Machinaut deliberately forbids a **machine** credential from minting a **public** share — the
posture that "a leaked ingest key can't publish to the internet." So today the comment links to the
login-walled console session, honestly labeled. This still drives real adoption: a PR's reviewers
are the exact devs already in your tenant.

- **Today (shipped):** read `GET …/sessions/:s?report=1` with the project
  key → post the sticky comment with a verdict teaser + console deep link.
- **Later (planned):** once the control plane grows a CI-scoped, mint-only *publish token*,
  swap the console link for a real public `/s/:token` share so an unauthenticated onlooker can
  click through. That needs a backend change first.

## Versioning

Releases follow [SemVer](https://semver.org/) and are tagged `vMAJOR.MINOR.PATCH`.

- **Pin the major alias** — `machinise/machinaut-pr-action@v1` — to pick up fixes
  automatically. A release workflow re-points `v1` at each new `v1.x.y`.
- **`v2` (released as `v2.0.0`, beta)** carries gate mode: it adds a mode that asks for new job
  permissions (`id-token: write`, `attestations: write`) and pins a signed predicate, so it gets its
  own major. Comment mode is unchanged and `v1` consumers are unaffected. `src/version.ts` must match
  the tag (gate mode records it in every statement); the release workflow enforces this.
- **Pin an exact tag** (`@v1.0.0`) or a commit SHA if you want fully reproducible runs.

Because a runner executes the committed `dist/` bundle directly, the release workflow
refuses to move the major alias when the tagged tree's `dist/` is out of date.
See [CHANGELOG.md](./CHANGELOG.md).

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # bundle src/ -> dist/index.js (committed; a runner executes it directly)
npm run all         # typecheck + test + build
```

`dist/` is **committed** — GitHub runs the bundled `dist/index.js` with no install step. The CI
workflow's *check-dist* step fails if the bundle drifts from `src/`, so always `npm run build`
and commit after changing source.

## Design decisions

- **Trigger:** a Lodestar session was shipped for the PR head SHA (no heuristic).
- **Session binding:** the CI step exports the session id it just shipped.
- **Comment content:** short verdict teaser + link (never parse `renderReport` markdown as data).
- **Home:** this dedicated repo (clean Marketplace publish; keeps write-side code out of the control plane).

## Invariants (from Machinaut `CLAUDE.md`)

- **Candor:** label shipped / beta / planned honestly; the console link is named
  as login-walled, not sold as a public post-mortem.
- **Never claim an OSS feature as Machinaut's:** the chain / report / projection are Lodestar
  OSS ([`@qmilab/lodestar-trace`](https://github.com/qmilab/lodestar), Apache-2.0); Machinaut
  adds hosting, the public link, and tenancy.
- **Never parse `renderReport` markdown as data:** the preview is a verbatim quote only.
- **Never host the writer:** this action is a read-only API client.
- **Machinaut never signs and never decides (gate mode):** the facts come from Machinaut; the
  decision is computed in your CI and signed with your CI's identity. No managed signing.
- **Predicate privacy:** digests / ids / counts / outcomes only — no payloads, prompts or reasons.
- **Positioning:** *"your team governs your agent fleet: approve, audit, prove."*

## License

[MIT](./LICENSE).

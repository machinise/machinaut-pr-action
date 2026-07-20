# machinaut-pr-action

A GitHub Action that posts the **Machinaut agent post-mortem** on agent-authored PRs —
*"this PR was written by an agent; here's exactly what it did and why."* Part of
[Machinaut](https://console.machinaut.ai)'s distribution / PLG work (Track C, build-loop #2).

> **Status: ✅ Increment 1 built — not yet published.** The action is implemented, unit-tested,
> and verified end-to-end against a stubbed API (create + idempotent update). Remaining before
> Marketplace publish: a live run on one real agent-authored PR, then flip the repo public.

## What it does

When a CI run has shipped a Lodestar session for a PR (via `lodestar ship` to Machinaut),
this action posts — and on re-runs **updates in place** — a single sticky comment carrying the
agent's evidence trail:

- headline chips derived from the session's structured projection — **events · agents · verdict · wall-clock**;
- a short **report preview**, quoted *verbatim* from the Lodestar report (never parsed as data);
- a **deep link** to the Machinaut console session, honestly labeled as **login-walled** (team
  members already in your org) — **not** a public post-mortem.

The action is a **read-only API client**. It calls exactly one endpoint,
`GET /v1/projects/:p/sessions/:s?report=1`, with your existing project key. It never runs the
agent writer, and it holds no secrets of its own (you supply your Machinaut credential as a repo
secret). See [Invariants](#invariants).

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

**Trigger (plan D1/D2):** the *presence of a shipped session is the signal* that a PR is
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
| `fail-on-error` | no | `false` | When `false`, problems log a warning and exit 0 so a non-critical evidence comment never red-Xes a PR. |

### Outputs

| Output | Description |
|---|---|
| `comment-id` | Numeric id of the sticky comment (empty if skipped). |
| `comment-url` | `html_url` of the sticky comment (empty if skipped). |
| `session-url` | The console deep link to the session. |
| `status` | `created`, `updated`, or `skipped:<reason>`. |

## Why the link is login-walled (and Increment 2)

Machinaut deliberately forbids a **machine** credential from minting a **public** share — the
posture that "a leaked ingest key can't publish to the internet." So Increment 1 links to the
login-walled console session, honestly labeled. This still drives real adoption: a PR's reviewers
are the exact devs already in your tenant.

- **Increment 1 (this repo, shipped here):** read `GET …/sessions/:s?report=1` with the project
  key → post the sticky comment with a verdict teaser + console deep link.
- **Increment 2 (later):** once the control plane grows a CI-scoped, mint-only *publish token*,
  swap the console link for a real public `/s/:token` share so an unauthenticated onlooker can
  click through. That's a backend slice tracked in the control-plane plan.

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

The full, ratified plan lives in the control-plane repo:
**`machinaut/docs/plans/track-c-pr-comment-bot.md`** (§3 Increment 1, §4 ratified decisions).

## Ratified decisions (plan §4)

- **Trigger:** a Lodestar session was shipped for the PR head SHA (no heuristic).
- **Session binding:** the CI step exports the session id it just shipped.
- **Comment content:** short verdict teaser + link (never parse `renderReport` markdown as data).
- **Home:** this dedicated repo (clean Marketplace publish; keeps write-side code out of the control plane).

## Invariants (from Machinaut `CLAUDE.md`)

- **Candor:** label shipped / beta / planned honestly; the Increment-1 console link is named
  as login-walled, not sold as a public post-mortem.
- **Never claim an OSS feature as Machinaut's:** the chain / report / projection are Lodestar
  OSS ([`@qmilab/lodestar-trace`](https://github.com/qmilab/lodestar), Apache-2.0); Machinaut
  adds hosting, the public link, and tenancy.
- **Never parse `renderReport` markdown as data:** the preview is a verbatim quote only.
- **Never host the writer:** this action is a read-only API client.
- **Positioning:** *"your team governs your agent fleet: approve, audit, prove."*

## License

[MIT](./LICENSE).

# machinaut-pr-action

A GitHub Action that posts the **Machinaut agent post-mortem** on agent-authored PRs —
*"this PR was written by an agent; here's exactly what it did and why."* Part of
[Machinaut](https://console.machinaut.ai)'s distribution / PLG work (Track C, build-loop #2).

> **Status: 🚧 scaffolding (Increment 1).** Not yet published. Do not add to a workflow yet.

## What it does

When a CI run has shipped a Lodestar session for a PR (via `lodestar ship` to Machinaut),
this action posts (and updates, idempotently) a single sticky comment on the PR carrying the
agent's evidence trail and a link to the hosted post-mortem.

The action is a **read/publish API client** — it never runs the agent writer, and it holds
no secrets of its own (the consumer supplies their own Machinaut credential as a repo
secret). See [Invariants](#invariants).

## Build plan

The full, ratified plan lives in the control-plane repo:
**`machinaut/docs/plans/track-c-pr-comment-bot.md`** (§3 Increment 1, §4 ratified decisions).
Read it before building — clone `machinise/machinaut` alongside this repo, or reference it
with `--add-dir`.

- **Increment 1 (this repo, zero backend):** authenticate with the consumer's existing
  project key → read `GET /v1/projects/:p/sessions/:s?report=1` → post a sticky comment with
  a verdict teaser + a (login-walled) console deep-link, honestly labeled.
- **Increment 2 (later):** swap the console link for a real public `/s/:token` share, once
  the control plane grows a CI-scoped, mint-only publish token.

## Ratified decisions (plan §4)

- **Trigger:** a Lodestar session was shipped for the PR head SHA (no heuristic).
- **Session binding:** the CI step exports the session id it just shipped.
- **Comment content:** short verdict teaser + link (never parse `renderReport` markdown as data).
- **Home:** this dedicated repo (clean Marketplace publish; keeps write-side code out of the control plane).

## Invariants (from Machinaut `CLAUDE.md`)

- **Candor:** label shipped / beta / planned honestly; an Increment-1 console link is named
  as login-walled, not sold as a public post-mortem.
- **Never claim an OSS feature as Machinaut's:** the chain / report / projection are Lodestar
  OSS (`projectChain` / `renderReport`); Machinaut adds hosting, the public link, tenancy.
- **Never host the writer:** this action is an API client only.
- **Positioning:** *"your team governs your agent fleet: approve, audit, prove."*

## License

TBD before publish.

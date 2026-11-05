import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findPrNumberForSha, headShaFromPayload, isForkPullRequest, type PrPayload, prTargetFromPayload } from "./events"
import { evaluateGate, type GateResult, predicatePolicy } from "./gate"
import { type AttestationState, CHECK_NAME, GATE_STICKY_MARKER, renderGateComment, renderGateErrorComment } from "./gateComment"
import { fetchGovernanceSummary, GovernanceSchemaError } from "./governance"
import type { Inputs } from "./inputs"
import { submitBundleToIntake } from "./intake"
import { normalizeBaseUrl } from "./machinaut"
import {
  type AttestationStoreApi,
  type AttestFn,
  githubStore,
  planSigning,
  type SignResult,
  SigningError,
  signStatement,
  STORE_HINT,
} from "./signing"
import { buildStatement, summaryDocument } from "./statement"
import { type CommentApi, upsertStickyComment } from "./sticky"

/**
 * Gate mode (Track G, slice G1 — beta).
 *
 * fetch the governance facts Machinaut holds for the session → evaluate THIS
 * repo's policy → build the in-toto Statement → sign it with this workflow's own
 * Sigstore identity → fail the step on `decision: fail` → refresh the sticky
 * verdict comment. Machinaut serves facts; the decision and the signature are
 * made here, in the customer's CI (plan §2.1).
 *
 * Step outcome:
 *  - `decision: fail` FAILS the step regardless of `fail-on-error` — that is what
 *    makes `machinaut / governed-run` a meaningful required check.
 *  - Infrastructure errors (API down, unsupported summary, signing failure,
 *    comment failure) honour `fail-on-error`, which defaults to TRUE in gate mode
 *    so the check fails closed.
 *  - `dry-run: true` never fails the step.
 */

/** The narrow Actions-core surface gate mode uses (faked in tests). */
export interface ActionsCore {
  info(message: string): void
  notice(message: string): void
  warning(message: string): void
  setOutput(name: string, value: string): void
  setFailed(message: string): void
}

/** Octokit, narrowed to what gate mode calls: comments, PR lookup, PR head, attestation store. */
export interface GateGitHubApi extends CommentApi, AttestationStoreApi {
  rest: CommentApi["rest"] & {
    pulls: {
      get: (params: { owner: string; repo: string; pull_number: number }) => Promise<{
        data: { head: { sha: string } }
      }>
    }
  }
}

export interface GateContext {
  eventName: string
  sha: string
  payload: Record<string, unknown>
  repo: { owner: string; repo: string }
  serverUrl: string
}

export interface GateDeps {
  core: ActionsCore
  context: GateContext
  /** Lazily built so a missing token is reported as an input error, not a crash. */
  octokit: () => GateGitHubApi
  attest: AttestFn
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  writeFile?: (path: string, data: string) => Promise<void>
}

/** What happened, for tests and logs. Outputs are the contract; this mirrors them. */
export interface GateOutcome {
  decision?: GateResult["decision"]
  reasons: string[]
  attestation?: string
  status: string
}

const HEAD_SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/

export async function runGate(inputs: Inputs, deps: GateDeps): Promise<GateOutcome> {
  const { core, context } = deps
  const outcome: GateOutcome = { reasons: [], status: "" }
  const write = deps.writeFile ?? defaultWriteFile

  const setStatus = (status: string) => {
    outcome.status = status
    core.setOutput("status", status)
  }

  /** An infrastructure error: never a decision. dry-run → warn; else fail-on-error decides. */
  const infra = (reason: string, message: string) => {
    const text = `machinaut-pr-action gate (${reason}): ${message}`
    if (inputs.dryRun) core.warning(`${text} — not failing the step (dry-run)`)
    else if (inputs.failOnError) core.setFailed(text)
    else core.warning(`${text} — continuing (fail-on-error is false)`)
  }
  const stop = (reason: string, message: string): GateOutcome => {
    setStatus(`skipped:${reason}`)
    infra(reason, message)
    return outcome
  }

  // A shipped session is the signal that a PR is agent-authored (Track C D1).
  // No session → nothing to gate; the step passes as not-applicable.
  if (!inputs.sessionId) {
    setStatus("skipped:no-session")
    core.notice(
      "machinaut-pr-action gate skipped (no-session): no session id supplied — nothing was shipped for this run, " +
        "so there is no agent run to gate",
    )
    return outcome
  }

  const fork = isForkPullRequest(context.payload as never, context.eventName)
  if (!inputs.apiKey) {
    return stop(
      "no-api-key",
      fork
        ? "machinaut-api-key is empty — this is a pull_request from a fork, and GitHub does not pass repository " +
            "secrets to fork PR runs"
        : "machinaut-api-key is required",
    )
  }
  if (!inputs.projectId) return stop("no-project-id", "project-id is required")
  if (!inputs.githubToken) return stop("no-github-token", "github-token is required to comment and attest")

  let sessionUrl: string
  try {
    const base = normalizeBaseUrl(inputs.consoleUrl)
    sessionUrl = `${base}/projects/${encodeURIComponent(inputs.projectId)}/sessions/${encodeURIComponent(inputs.sessionId)}`
  } catch (err) {
    return stop("bad-console-url", errMessage(err))
  }
  core.setOutput("session-url", sessionUrl)

  const octokit = deps.octokit()
  const { owner, repo } = context.repo

  // Which PR, and which commit the statement is about.
  let prNumber: number | undefined
  let headSha: string | undefined
  try {
    ;({ prNumber, headSha } = await resolvePrAndHead(octokit, context))
  } catch (err) {
    return stop("pr-lookup-failed", errMessage(err))
  }
  if (prNumber === undefined) {
    setStatus("skipped:no-pr")
    core.notice("machinaut-pr-action gate skipped (no-pr): no pull request is associated with this run — nothing to gate")
    return outcome
  }
  if (!headSha || !HEAD_SHA.test(headSha)) {
    return stop("no-head-sha", `could not determine the PR head commit for #${prNumber} (got '${headSha ?? ""}')`)
  }

  const postComment = async (body: string): Promise<boolean> => {
    try {
      const res = await upsertStickyComment(octokit, { owner, repo, issueNumber: prNumber!, marker: GATE_STICKY_MARKER, body })
      core.setOutput("comment-id", String(res.id))
      core.setOutput("comment-url", res.html_url)
      setStatus(res.action)
      core.info(`${res.action} gate comment on ${owner}/${repo}#${prNumber}: ${res.html_url}`)
      return true
    } catch (err) {
      setStatus("skipped:comment-failed")
      infra("comment-failed", errMessage(err))
      return false
    }
  }

  // 1. Facts — from Machinaut, read-only, with the project key.
  let parsed
  try {
    parsed = await fetchGovernanceSummary(
      { apiUrl: inputs.apiUrl, apiKey: inputs.apiKey, projectId: inputs.projectId, sessionId: inputs.sessionId },
      { fetch: deps.fetch },
    )
  } catch (err) {
    const reason = err instanceof GovernanceSchemaError ? "unsupported-summary" : "api-error"
    const message = errMessage(err)
    await postComment(renderGateErrorComment({ sessionUrl, message, dryRun: inputs.dryRun }))
    // The comment step may have set a status; the run's real outcome is this error.
    setStatus(`skipped:${reason}`)
    infra(reason, `${message} — no decision was made and nothing was signed`)
    return outcome
  }
  const { summary } = parsed
  if (parsed.dropped.length > 0) {
    core.notice(
      `governance summary fields not in governance_summary@1 were left out of the statement: ${parsed.dropped.join(", ")}`,
    )
  }

  // 2. Decision — this repo's policy, evaluated here.
  const policy = predicatePolicy(inputs.policy)
  const result = evaluateGate(summary, inputs.policy)
  outcome.decision = result.decision
  outcome.reasons = result.reasons
  core.setOutput("decision", result.decision)
  core.setOutput("reasons", JSON.stringify(result.reasons))
  core.info(`${CHECK_NAME}: decision ${result.decision}${inputs.dryRun ? " (dry run)" : ""}`)
  for (const r of result.failures) core.info(`  - ${r}`)
  for (const n of result.notes) core.notice(`${CHECK_NAME}: ${n}`)

  // 3. Statement — written to disk whether or not it is signed.
  const statement = buildStatement({ owner, repo, headSha, summary, policy, decision: result.decision, reasons: result.reasons })
  const outDir = join(deps.env.RUNNER_TEMP || tmpdir(), "machinaut-governed-run", safeSegment(inputs.sessionId))
  try {
    const summaryPath = join(outDir, "machinaut-governance-summary.json")
    const statementPath = join(outDir, "governed-run.intoto.json")
    await write(summaryPath, summaryDocument(summary))
    await write(statementPath, JSON.stringify(statement))
    core.setOutput("summary-path", summaryPath)
    core.setOutput("statement-path", statementPath)
  } catch (err) {
    infra("write-failed", `could not write the statement files: ${errMessage(err)}`)
  }

  // 4. Signature — Sigstore keyless, this workflow's identity. Skips are visible.
  let attestation: AttestationState
  let signed: SignResult | undefined
  const plan = planSigning({ dryRun: inputs.dryRun, eventName: context.eventName, payload: context.payload as never, env: deps.env })
  if (!plan.sign) {
    attestation = { kind: "skipped", reason: plan.reason, detail: plan.detail }
    outcome.attestation = `skipped:${plan.reason}`
    const text = `governed-run statement NOT signed (${plan.reason}): ${plan.detail}`
    if (plan.reason === "permissions") core.warning(text)
    else core.notice(text)
  } else {
    try {
      signed = await signStatement(
        statement,
        { attest: deps.attest, store: githubStore(octokit, owner, repo) },
        { token: inputs.githubToken, serverUrl: context.serverUrl, owner, repo },
      )
      attestation = { kind: "signed", attestationUrl: signed.attestationUrl, tlogId: signed.tlogId, storeError: signed.storeError }
      outcome.attestation = signed.storeError ? "signed-not-stored" : "signed"
      try {
        const bundlePath = join(outDir, "governed-run.sigstore.json")
        await write(bundlePath, JSON.stringify(signed.bundle))
        core.setOutput("bundle-path", bundlePath)
      } catch (err) {
        infra("write-failed", `could not write the Sigstore bundle: ${errMessage(err)}`)
      }
      if (signed.attestationUrl) core.setOutput("attestation-url", signed.attestationUrl)
      core.info(
        `governed-run statement signed via Sigstore${signed.tlogId ? ` (Rekor log index ${signed.tlogId})` : ""}` +
          `${signed.attestationUrl ? `: ${signed.attestationUrl}` : ""}`,
      )
      if (signed.storeError) {
        core.warning(`governed-run statement signed but NOT stored in GitHub (${signed.storeError}) — ${STORE_HINT}`)
      }
      const intake = await submitBundleToIntake({
        apiUrl: inputs.apiUrl,
        apiKey: inputs.apiKey,
        projectId: inputs.projectId,
        sessionId: inputs.sessionId,
        bundle: signed.bundle,
      })
      core.info(intake.message)
    } catch (err) {
      const message = err instanceof SigningError ? err.message : `signing failed: ${errMessage(err)}`
      attestation = { kind: "failed", message }
      outcome.attestation = "failed"
      infra("signing-failed", message)
    }
  }
  core.setOutput("attestation", outcome.attestation ?? "")

  // 5. Verdict comment (sticky, updated in place).
  await postComment(
    renderGateComment({ summary, result, policy, dryRun: inputs.dryRun, headSha, sessionUrl, attestation }),
  )

  // 6. The check itself.
  if (result.decision === "fail") {
    const why = result.failures.join("; ")
    if (inputs.dryRun) core.notice(`${CHECK_NAME} (dry run): would FAIL — ${why}`)
    else core.setFailed(`${CHECK_NAME}: gate failed — ${why}`)
  } else {
    core.info(`${CHECK_NAME}: policy decision pass${inputs.dryRun ? " (dry run)" : ""}`)
  }
  return outcome
}

async function resolvePrAndHead(
  octokit: GateGitHubApi,
  ctx: GateContext,
): Promise<{ prNumber?: number; headSha?: string }> {
  const payload = ctx.payload as PrPayload
  const target = prTargetFromPayload(payload, ctx.sha, ctx.eventName)
  let prNumber = target.prNumber
  if (prNumber === undefined && target.sha) {
    prNumber = await findPrNumberForSha(octokit, { owner: ctx.repo.owner, repo: ctx.repo.repo, sha: target.sha })
  }
  if (prNumber === undefined) return {}
  let headSha = headShaFromPayload(payload, ctx.sha, ctx.eventName)
  if (!headSha) {
    // e.g. issue_comment: the payload names the PR but not its head.
    const { data } = await octokit.rest.pulls.get({ owner: ctx.repo.owner, repo: ctx.repo.repo, pull_number: prNumber })
    headSha = data.head.sha
  }
  return { prNumber, headSha }
}

async function defaultWriteFile(path: string, data: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, data, "utf8")
}

/** A session id as a single safe path segment. */
function safeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128)
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "session" : cleaned
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

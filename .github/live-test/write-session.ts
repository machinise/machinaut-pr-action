/**
 * LIVE TEST ONLY (do not merge). Writes one small, synthetic Lodestar session to a
 * local event log with the Lodestar OSS writer (`EventLogWriter`), exactly as an
 * instrumented agent's host would. The workflow then ships it with the real
 * `lodestar ship --sensitivity-ceiling public` CLI.
 *
 * The resulting share page is PUBLIC, so every payload here is harmless, synthetic
 * and labelled as a test. Observations, the claim, the belief and the action are
 * labelled `public`, so the shipper sends them readable; the decision and the
 * outcome are not content records, so the shipper withholds them at the `public`
 * ceiling (structure + payload hash only). That is the OSS shipper's rule, applied
 * on this runner before anything leaves it.
 *
 * Env: PROJECT_ID, SESSION_ID, LOG_ROOT (required); GITHUB_REPOSITORY,
 * GITHUB_RUN_ID, PR_NUMBER (optional, only quoted into the test notice).
 */
import { EventLogWriter } from "@qmilab/lodestar-event-log"

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    process.stderr.write(`${name} is required\n`)
    process.exit(2)
  }
  return value
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/
const projectId = required("PROJECT_ID")
const sessionId = required("SESSION_ID")
const logRoot = required("LOG_ROOT")
for (const [name, value] of [
  ["PROJECT_ID", projectId],
  ["SESSION_ID", sessionId],
] as const) {
  if (!SAFE_ID.test(value)) {
    process.stderr.write(`${name} must match ${SAFE_ID}\n`)
    process.exit(2)
  }
}
const repository = process.env.GITHUB_REPOSITORY?.trim() || "local"
const runId = process.env.GITHUB_RUN_ID?.trim() || "local"
const prNumber = process.env.PR_NUMBER?.trim() || "none"

const NOTICE =
  "LIVE TEST: synthetic demo data written by a CI test of the Machinaut PR action. " +
  "No real agent ran, nothing outside this session changed, and nothing here is real activity."

const actor = "live-test-agent"
const scope = { level: "session" as const, identifier: sessionId }
const start = Date.now()
const at = (step: number) => new Date(start + step * 1000).toISOString()

const writer = new EventLogWriter(logRoot)
const ids: string[] = []

async function emit(type: string, payload: unknown): Promise<void> {
  const step = ids.length
  const id = `${sessionId}-${step}`
  await writer.append({
    id,
    type,
    schema_version: "1.0.0",
    project_id: projectId,
    session_id: sessionId,
    actor_id: actor,
    timestamp: at(step),
    causal_parent_ids: step > 0 ? [ids[step - 1]!] : [],
    payload,
    versions: {},
  })
  ids.push(id)
}

const context = { session_id: sessionId, project_id: projectId, actor_id: actor }

await emit("observation.recorded", {
  id: "obs-test-notice",
  schema: "live-test.notice@1",
  payload: { notice: NOTICE, repository, workflow_run: runId, pull_request: prNumber },
  source: { tool: "live-test.fixture", invocation_id: `inv-${runId}-1`, captured_at: at(0) },
  context,
  trust: "synthetic",
  sensitivity: "public",
})

await emit("observation.recorded", {
  id: "obs-test-plan",
  schema: "live-test.plan@1",
  payload: {
    steps: [
      "ship this session at the public sensitivity ceiling",
      "mint a public, expiring share with a CI publish token",
      "post the sticky evidence comment on the test pull request",
    ],
  },
  source: { tool: "live-test.fixture", invocation_id: `inv-${runId}-2`, captured_at: at(1) },
  context,
  trust: "synthetic",
  sensitivity: "public",
})

await emit("claim.extracted", {
  id: "claim-test-only",
  statement: "This session is a synthetic live test of the public post-mortem link and carries no real agent activity",
  source_observation_ids: ["obs-test-notice", "obs-test-plan"],
  extraction_method: "tool",
  extracted_by: actor,
  status: "accepted",
  scope,
  sensitivity: "public",
  authors: [actor],
  created_at: at(2),
})

await emit("belief.adopted", {
  id: "belief-test-only",
  claim_id: "claim-test-only",
  confidence: 0.99,
  calibration_class: "live-test",
  scope,
  sensitivity: "public",
  authority: "observed",
  truth_status: "supported",
  retrieval_status: "normal",
  security_status: "clean",
  freshness_status: "fresh",
  observed_at: at(3),
})

// Not a content record: the shipper withholds it at the `public` ceiling.
await emit("decision.made", {
  id: "dec-test-noop",
  question: "Record a no-op test step?",
  selected_option_id: "record",
  chosen_option: { action: "noop" },
  belief_dependencies: ["belief-test-only"],
  made_by: actor,
  made_at: at(4),
})

await emit("action.completed", {
  id: "act-test-noop",
  decision_id: "dec-test-noop",
  intent: "Record a no-op test step (changes nothing outside this session)",
  tool: "live-test.noop",
  inputs: { note: "no-op" },
  contract: {
    required_level: 1,
    blast_radius: "session",
    reversibility: "reversible",
    scope,
    data_sensitivity: "public",
    preconditions: [],
  },
  phase: "completed",
  audit: [
    { phase: "proposed", by_actor_id: actor, at: at(5) },
    { phase: "executing", by_actor_id: actor, at: at(5) },
    { phase: "completed", by_actor_id: actor, at: at(5) },
  ],
  outcome_id: "out-test-noop",
  proposed_at: at(5),
  proposed_by: actor,
})

// Not a content record: the shipper withholds it at the `public` ceiling.
await emit("outcome.observed", {
  id: "out-test-noop",
  action_id: "act-test-noop",
  result: "success",
  effect_observation_ids: [],
  side_effects_observed: [],
  duration_ms: 0,
  observed_at: at(6),
})

process.stdout.write(`wrote ${ids.length} synthetic events for ${projectId}/${sessionId} under ${logRoot}\n`)

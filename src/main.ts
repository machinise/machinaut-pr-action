import { attest } from "@actions/attest"
import * as core from "@actions/core"
import * as github from "@actions/github"
import { type CommentGitHubApi, runComment } from "./commentRun"
import { type GateGitHubApi, runGate } from "./gateRun"
import { readInputs } from "./inputs"

/**
 * Entrypoint: read the inputs and run the selected mode. Comment mode (the
 * default) lives in `commentRun.ts`; gate mode (beta, Track G G1) in `gateRun.ts`.
 * Both take their GitHub/Actions dependencies injected, so they are unit-tested
 * without this module's import-time side effect.
 */
export async function run(): Promise<void> {
  const inputs = readInputs()

  // Gate mode (beta, Track G G1) is opt-in; the default `mode: comment` below is
  // Increment 1 (plus the planned public link), unchanged by gate mode.
  if (inputs.mode === "gate") {
    if (inputs.publishToken) {
      core.notice("machinaut-publish-token is used in comment mode only; gate mode does not publish a public link")
    }
    await runGate(inputs, {
      core,
      context: github.context,
      octokit: () => github.getOctokit(inputs.githubToken) as unknown as GateGitHubApi,
      attest,
      env: process.env,
    })
    return
  }

  await runComment(inputs, {
    core,
    context: github.context,
    octokit: () => github.getOctokit(inputs.githubToken) as unknown as CommentGitHubApi,
  })
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Entrypoint. Any unexpected throw becomes a warning/failure per fail-on-error;
// but readInputs() can throw before we know that flag, so guard defensively.
run().catch((err) => {
  core.setFailed(`machinaut-pr-action: unexpected error: ${errMessage(err)}`)
})

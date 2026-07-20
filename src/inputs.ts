import * as core from "@actions/core"

export interface Inputs {
  apiKey: string
  projectId: string
  sessionId: string
  apiUrl: string
  consoleUrl: string
  githubToken: string
  failOnError: boolean
}

/** Read and normalise the action inputs. `console-url` falls back to `api-url`. */
export function readInputs(): Inputs {
  const apiUrl = core.getInput("api-url").trim() || "https://console.machinaut.ai"
  const consoleUrl = core.getInput("console-url").trim() || apiUrl
  return {
    apiKey: core.getInput("machinaut-api-key").trim(),
    projectId: core.getInput("project-id").trim(),
    sessionId: core.getInput("session-id").trim(),
    apiUrl,
    consoleUrl,
    githubToken: core.getInput("github-token").trim(),
    failOnError: core.getBooleanInput("fail-on-error"),
  }
}

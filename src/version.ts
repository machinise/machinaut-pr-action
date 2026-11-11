/**
 * This build's release version, recorded in every governed-run statement as
 * `gate.action` (plan §2.2). Bump it in the same commit that prepares a release:
 * the release workflow refuses to alias a tag whose version does not match.
 */
export const ACTION_VERSION = "2.1.0"

export const ACTION_REPOSITORY = "machinise/machinaut-pr-action"

export const ACTION_REF = `${ACTION_REPOSITORY}@v${ACTION_VERSION}`

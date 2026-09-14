import { createSignalDigest } from "./normalize"
import { redactedSignals } from "./redacted-fixtures"
import { renderDailyDigest, type SlackDigestMessage } from "./digest"

export const ALLOWED_SLACK_CHANNEL_ID = "C0C1GJNPV0V"

export type SlackCommand = "status" | "test_digest" | "digest" | "help" | null

export type SlackCommandResponse = {
  command: Exclude<SlackCommand, null>
  message: SlackDigestMessage
}

const leadingMention = /^<@[A-Z0-9]+>\s*/i
const syntheticWindowStartedAt = "2026-09-13T09:00:00.000Z"
const syntheticWindowEndedAt = "2026-09-14T09:00:00.000Z"
const syntheticGeneratedAt = "2026-09-14T09:00:01.000Z"

export function isAllowedSlackChannel(channelId: string): boolean {
  return channelId === ALLOWED_SLACK_CHANNEL_ID
}

/**
 * Classifies only exact supported commands. It removes one leading Slack user
 * mention, but does not search for commands inside arbitrary message text.
 */
export function classifySlackCommand(text: string): SlackCommand {
  const command = text.replace(leadingMention, "").trim().toLowerCase()
  switch (command) {
    case "status":
      return "status"
    case "help":
      return "help"
    case "test digest":
    case "demo digest":
      return "test_digest"
    case "digest":
      return "digest"
    default:
      return null
  }
}

const statusMessage: SlackDigestMessage = {
  text: "Account Signals is connected. Use `test digest` for a synthetic renderer check or `digest` for the live pipeline status.",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Account Signals is connected. Use `test digest` for a synthetic renderer check or `digest` for the live pipeline status.",
      },
    },
  ],
}

const helpMessage: SlackDigestMessage = {
  text: "Commands: `status`, `help`, `test digest`, `demo digest`, `digest`.",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Commands: `status`, `help`, `test digest`, `demo digest`, `digest`.",
      },
    },
  ],
}

const liveUnavailableMessage: SlackDigestMessage = {
  text: "The live account-signals digest pipeline is not connected yet. No live digest was generated or reported.",
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "The live account-signals digest pipeline is not connected yet. No live digest was generated or reported.",
      },
    },
  ],
}

function syntheticDigestMessage(): SlackDigestMessage {
  const digest = createSignalDigest(
    redactedSignals,
    syntheticWindowStartedAt,
    syntheticWindowEndedAt,
    syntheticGeneratedAt,
  )
  const rendered = renderDailyDigest(digest)
  const heading = "*TEST / SYNTHETIC — not live account data*"
  const text = `${heading}\n\n${rendered.slack.text}`

  return {
    text,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "TEST / SYNTHETIC — not live data" },
      },
      ...rendered.slack.blocks,
    ],
  }
}

export function responseForSlackCommand(command: Exclude<SlackCommand, null>): SlackCommandResponse {
  switch (command) {
    case "status":
      return { command, message: statusMessage }
    case "help":
      return { command, message: helpMessage }
    case "test_digest":
      return { command, message: syntheticDigestMessage() }
    case "digest":
      return { command, message: liveUnavailableMessage }
  }
}

export function slackCommandResponse(text: string): SlackCommandResponse | null {
  const command = classifySlackCommand(text)
  return command ? responseForSlackCommand(command) : null
}

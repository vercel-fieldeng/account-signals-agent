export type DiagnosticMessageParts = {
  bluf: string
  detail: string
}

export type DiagnosticSlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "divider" }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }

export type DiagnosticSlackPost = {
  text: string
  blocks: readonly DiagnosticSlackBlock[]
}

/**
 * Scheduled Slack diagnostics use one model turn but two Slack messages:
 * the BLUF becomes the thread root and the detail becomes its reply.
 */
export function splitDiagnosticMessage(message: string): DiagnosticMessageParts | null {
  const marker = "\nDETAIL:"
  if (!message.startsWith("BLUF:")) return null
  const markerIndex = message.indexOf(marker)
  if (markerIndex < 0) return null

  const bluf = message.slice(0, markerIndex).trim()
  const detail = message.slice(markerIndex + marker.length).trim()
  if (!bluf || !detail) return null
  return { bluf, detail }
}

export function isWaitingDiagnosticBluf(bluf: string): boolean {
  return /(?:^|\n)Status:\s*WAITING_FOR_(?:D0|CONTEXT)\b/u.test(bluf)
}

function plainText(value: string): string {
  return value
    .replace(/^BLUF:\s*/u, "")
    .replace(/<https?:\/\/[^|>]+\|([^>]+)>/gu, "$1")
    .replace(/[\*_`~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
}

function convertMarkdownText(value: string): string {
  return value
    .replace(/\*\*\*([^*\n]+)\*\*\*/gu, "*$1*")
    .replace(/\*\*([^*\n]+)\*\*/gu, "*$1*")
    .replace(/__([^_\n]+)__/gu, "*$1*")
    .replace(/~~([^~\n]+)~~/gu, "~$1~")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (_match, label: string, url: string) => `<${url}|${label}>`)
    .replace(/^#{1,6}\s+(.+)$/gmu, "*$1*")
    .replace(/^(\s*)[-+]\s+/gmu, (_match, indentation: string) => `${indentation ? "◦" : "•"} `)
    .replace(/^(\s*)\*\s+(?=\S)/gmu, (_match, indentation: string) => `${indentation ? "◦" : "•"} `)
}

/** Convert GitHub-style Markdown to Slack mrkdwn while preserving code spans/fences. */
export function markdownToSlackMrkdwn(markdown: string): string {
  const code = /```[\s\S]*?```|`[^`\n]+`/gu
  let result = ""
  let cursor = 0

  for (const match of markdown.matchAll(code)) {
    const start = match.index ?? 0
    result += convertMarkdownText(markdown.slice(cursor, start))
    result += match[0]
    cursor = start + match[0].length
  }

  return result + convertMarkdownText(markdown.slice(cursor))
}

function splitSlackParagraphs(body: string): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  const flush = () => {
    const paragraph = current.join("\n").trim()
    if (paragraph) paragraphs.push(paragraph)
    current = []
  }

  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      continue
    }
    if (/^(?:\d+\.\s+)?\*Account:\*/u.test(trimmed) && current.length > 0) flush()
    current.push(line)
  }
  flush()
  return paragraphs
}

/** Render compact Slack blocks with Slack-native mrkdwn syntax. */
export function diagnosticSlackPost(markdown: string): DiagnosticSlackPost {
  const lines = markdown.split("\n")
  const first = lines.shift()?.trim() ?? ""
  const title = plainText(first) || "Account Signals"
  const body = lines.join("\n").trim()
  const paragraphs = splitSlackParagraphs(body)
  const metadata: string[] = []
  const sections: string[] = []

  for (const paragraph of paragraphs) {
    const paragraphLines = paragraph.split("\n")
    if (paragraphLines.every((line) => /^(?:\*{0,2})(?:Comparison|Scope|Status|Data status|Action)(?:\*{0,2}):/u.test(line.trim()))) {
      metadata.push(markdownToSlackMrkdwn(paragraph))
    } else {
      sections.push(markdownToSlackMrkdwn(paragraph))
    }
  }

  const blocks: DiagnosticSlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
  ]
  if (metadata.length > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: metadata.join("\n") }] })
  }
  let accountCards = 0
  for (const section of sections) {
    const isAccountCard = /^(?:\d+\.\s+)?\*Account:\*/u.test(section)
    if (isAccountCard && accountCards > 0) blocks.push({ type: "divider" })
    blocks.push({ type: "section", text: { type: "mrkdwn", text: section.slice(0, 3000) } })
    if (isAccountCard) accountCards += 1
  }

  return { text: markdownToSlackMrkdwn(markdown), blocks: blocks.slice(0, 50) }
}

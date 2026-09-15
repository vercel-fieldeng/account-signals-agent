export type SlackRootMessage = {
  ts: string
  threadTs: string
}

export function isSlackThreadRoot(message: SlackRootMessage | undefined, threadTs: string): boolean {
  return Boolean(message && message.ts === threadTs && message.threadTs === message.ts)
}

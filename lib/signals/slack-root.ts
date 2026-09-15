export type SlackRootMessage = {
  ts: string
  threadTs: string
  botId?: string
  isMe?: boolean
}

export function isSlackThreadRoot(message: SlackRootMessage | undefined, threadTs: string): boolean {
  return Boolean(message && message.ts === threadTs && message.threadTs === message.ts)
}

export function isAutonomousSlackThreadRoot(message: SlackRootMessage | undefined, threadTs: string): boolean {
  return isSlackThreadRoot(message, threadTs) && Boolean(message?.botId || message?.isMe)
}

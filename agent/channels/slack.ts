import { connectSlackCredentials } from '@vercel/connect/eve';
import {
  defaultSlackAuth,
  slackChannel,
  type SlackEventContext,
} from 'eve/channels/slack';
import {
  isAllowedSlackChannel,
  slackCommandResponse,
} from '../../lib/signals/slack-commands';
import { AutomationAdmissionError, classifyAutomationCommand } from '../../lib/signals/automation-policy';
import { handleAutomationControl } from '../../lib/signals/automation-control';
import {
  diagnosticSlackPost,
  isWaitingDiagnosticBluf,
  splitDiagnosticMessage,
} from '../../lib/signals/autonomous-diagnostic-output';
import { isAutonomousSlackThreadRoot } from '../../lib/signals/slack-root';

async function isAutonomousDiagnosticThread(ctx: SlackEventContext): Promise<boolean> {
  await ctx.thread.refresh();
  const root = ctx.thread.recentMessages.find((message) => message.ts === ctx.slack.threadTs);
  // Session-rehydrated Slack bindings cannot reliably classify messages with
  // `isMe`; botId remains the stable signal for an autonomous bot-owned root.
  return isAutonomousSlackThreadRoot(root, ctx.slack.threadTs);
}

async function updateDiagnosticRoot(ctx: SlackEventContext, post: ReturnType<typeof diagnosticSlackPost>): Promise<boolean> {
  try {
    if (!await isAutonomousDiagnosticThread(ctx)) return false;
    const response = await ctx.slack.request('chat.update', {
      channel: ctx.slack.channelId,
      ts: ctx.slack.threadTs,
      text: post.text,
      blocks: post.blocks,
    });
    if (!response.ok) {
      console.warn('diagnostic_root_update_failed');
      return false;
    }
    return true;
  } catch {
    console.warn('diagnostic_root_update_failed');
    return false;
  }
}

export default slackChannel({
  credentials: connectSlackCredentials('slack/account-signals-slack'),
  async onAppMention(ctx, message) {
    if (!isAllowedSlackChannel(message.channelId)) {
      return null;
    }

    if (classifyAutomationCommand(message.text)) {
      try {
        const control = await handleAutomationControl(
          message.text,
          defaultSlackAuth(message, ctx),
          message.ts,
        );
        if (control?.kind === 'setup') {
          return { auth: control.auth, context: control.context, title: 'Automation authorization setup' };
        }
        if (control?.kind === 'reply') await ctx.thread.post(control.text);
      } catch (error) {
        const code = error instanceof AutomationAdmissionError ? error.code : 'state_or_message';
        console.warn(`automation_control_failed: ${code}`);
        await ctx.thread.post(`Automation control could not proceed (${code}). No new run was armed. Ask the operator to check this code; no credentials or authorization links need to be shared.`);
      }
      return null;
    }

    const response = slackCommandResponse(message.text);
    if (response) {
      await ctx.thread.post(response.message);
      return null;
    }

    return { auth: defaultSlackAuth(message, ctx) };
  },
  onDirectMessage() {
    return null;
  },
  events: {
    // Scheduled diagnostics return a two-part envelope. Keep the root message
    // glancable and put evidence/hypotheses/limitations in one reply.
    async 'message.completed'(event, ctx) {
      if (event.finishReason === 'tool-calls') return;
      if (!event.message) {
        await ctx.thread.startTyping();
        return;
      }
      const parts = splitDiagnosticMessage(event.message);
      if (!parts) {
        if (await isAutonomousDiagnosticThread(ctx)) {
          console.info('diagnostic_interim_message_suppressed');
          return;
        }
        await ctx.thread.post(event.message);
        return;
      }
      const rootUpdated = await updateDiagnosticRoot(ctx, diagnosticSlackPost(parts.bluf));
      if (!rootUpdated) await ctx.thread.post(diagnosticSlackPost(parts.bluf));
      if (!isWaitingDiagnosticBluf(parts.bluf)) await ctx.thread.post(diagnosticSlackPost(parts.detail));
    },
  },
});

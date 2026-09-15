import { connectSlackCredentials } from '@vercel/connect/eve';
import {
  defaultSlackAuth,
  slackChannel,
} from 'eve/channels/slack';
import {
  isAllowedSlackChannel,
  slackCommandResponse,
} from '../../lib/signals/slack-commands';
import { AutomationAdmissionError, classifyAutomationCommand } from '../../lib/signals/automation-policy';
import { handleAutomationControl } from '../../lib/signals/automation-control';
import {
  diagnosticSlackPost,
  splitDiagnosticMessage,
} from '../../lib/signals/autonomous-diagnostic-output';

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
        await ctx.thread.post(event.message);
        return;
      }
      await ctx.thread.post(diagnosticSlackPost(parts.bluf));
      await ctx.thread.post(diagnosticSlackPost(parts.detail));
    },
  },
});

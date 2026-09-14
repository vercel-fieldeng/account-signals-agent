import { connectSlackCredentials } from '@vercel/connect/eve';
import {
  defaultSlackAuth,
  slackChannel,
} from 'eve/channels/slack';
import {
  isAllowedSlackChannel,
  slackCommandResponse,
} from '../../lib/signals/slack-commands';

export default slackChannel({
  credentials: connectSlackCredentials('slack/account-signals-slack'),
  async onAppMention(ctx, message) {
    if (!isAllowedSlackChannel(message.channelId)) {
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
});

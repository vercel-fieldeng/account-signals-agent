import { connectSlackCredentials } from '@vercel/connect/eve';
import {
  defaultSlackAuth,
  slackChannel,
} from 'eve/channels/slack';

const allowedChannelId = 'C0C1GJNPV0V';

export default slackChannel({
  credentials: connectSlackCredentials('slack/account-signals-slack'),
  onAppMention(ctx, message) {
    if (message.channelId !== allowedChannelId) {
      return null;
    }

    return { auth: defaultSlackAuth(message, ctx) };
  },
  onDirectMessage() {
    return null;
  },
});

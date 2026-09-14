import { connect } from '@vercel/connect/eve';
import { defineMcpClientConnection } from 'eve/connections';

export default defineMcpClientConnection({
  url: 'https://d0-web.vercel.tools/eve/v1/mcp',
  description:
    'd0 read-only account statistics and source-coverage analysis. Start exactly one bounded invocation, then poll it to completion for the verified Salesforce account and requested UTC period.',
  auth: connect('d0-web.vercel.tools/d0'),
  tools: {
    allow: ['agent_start', 'agent_get', 'agent_update', 'agent_cancel'],
  },
});

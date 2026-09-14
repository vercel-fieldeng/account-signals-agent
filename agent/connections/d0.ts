import { connect } from '@vercel/connect/eve';
import { defineMcpClientConnection } from 'eve/connections';

export default defineMcpClientConnection({
  url: 'https://d0-web.vercel.tools/eve/v1/mcp',
  description:
    'd0 read-only account statistics and source-coverage analysis. Resolve the Salesforce account first, then run one bounded request and poll that invocation to completion.',
  auth: connect('d0-web.vercel.tools/d0'),
  tools: {
    allow: ['agent_start', 'agent_get', 'agent_update', 'agent_cancel'],
  },
});

import { connect } from '@vercel/connect/eve';
import { defineMcpClientConnection } from 'eve/connections';
import { D0_CONNECTOR_UID, D0_MCP_RESOURCE, d0TokenParams } from '../../lib/signals/d0-authorization';

export default defineMcpClientConnection({
  url: D0_MCP_RESOURCE,
  description:
    'd0 read-only account statistics and source-coverage analysis. Resolve the Salesforce account first, then run one bounded request and poll that invocation to completion.',
  auth: connect({ connector: D0_CONNECTOR_UID, tokenParams: d0TokenParams() }),
  tools: {
    allow: ['agent_start', 'agent_get', 'agent_update', 'agent_cancel'],
  },
});

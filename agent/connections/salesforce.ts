import { connect } from '@vercel/connect/eve';
import { defineMcpClientConnection } from 'eve/connections';

export default defineMcpClientConnection({
  url: 'https://api.salesforce.com/platform/mcp/v1/custom/vercel',
  description:
    'Salesforce read-only account lookup and object data. Resolve a company name to its Salesforce Account ID before delegating account statistics work.',
  auth: connect('api.salesforce.com/salesforce-mcp'),
  tools: {
    allow: [
      'findplatform_sobject_reads',
      'soqlQueryplatform_sobject_reads',
      'getObjectSchemaplatform_sobject_reads',
      'getRelatedRecordsplatform_sobject_reads',
      'listRecentSobjectRecordsplatform_sobject_reads',
    ],
  },
});

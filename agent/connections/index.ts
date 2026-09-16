import { defineMcpClientConnection } from 'eve/connections';

const INDEX_MCP_URL = 'https://index.vercel.sh/api/mcp';

export default defineMcpClientConnection({
  url: INDEX_MCP_URL,
  description:
    'Read-only account context from Index meetings and transcripts, plus Salesforce account/activity lookup by verified SFDC Account ID. Use only after d0 surfaces an account; cap enrichment to the strongest candidates.',
  auth: {
    principalType: 'app',
    async getToken() {
      const token = process.env.INDEX_ACCESS_TOKEN;
      if (!token) throw new Error('Index authorization is unavailable');
      return { token };
    },
  },
  headers: () => {
    const bypass = process.env.INDEX_PROTECTION_BYPASS;
    if (!bypass) throw new Error('Index connection is unavailable');
    return { 'x-vercel-protection-bypass': bypass };
  },
  tools: {
    allow: ['search_meetings', 'get_meeting_transcript', 'sfdc_lookup'],
  },
});

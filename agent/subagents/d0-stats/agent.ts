import { defineAgent } from 'eve';

export default defineAgent({
  description:
    'Retrieve complete, reproducible d0 statistics and source-coverage evidence for a verified Salesforce account in DISCOVER or REFRESH mode. Use for account adoption evidence, source mapping, grouped extraction, completeness checks, and refresh requests; this specialist never communicates with customers directly.',
  model: 'anthropic/claude-opus-4.8',
});

# Issue 6: compliant careers and company-post/news sources

## Scope and contract alignment

This strategy covers the two externally collected signal families currently represented by the contracts:

| Signal family | Category | Evidence kinds | Approved source systems |
| --- | --- | --- | --- |
| IT hiring | `it_hiring` | `job_posting` | `careers_page`, `ats_feed` |
| Company posts/news | `it_company_news` | `company_article`, `company_post` | `company_news`, optionally `sitemap` for discovery |

The source system names above are the existing `sourceSystemSchema` values. This document does not change the shared contracts. Every emitted observation or signal must retain a `sourceReference` with a non-empty `recordId`, the canonical public URL when available, and `collectedAt`; evidence must use the same source system as its observation/signal. A source record’s publication time is `observedAt`, while retrieval time is `collectedAt`/`capturedAt` and receipt time is `receivedAt`.

The active policy is first-party and public-only. “Approved” means approved for this strategy when the source is publicly reachable, permitted by its terms and robots policy, and collected at the cadence below. A source must not be treated as approved merely because it is technically accessible.

## Approved job-source strategy

1. Start with the account’s `careersUrl` from the account contract. Fetch the public careers page and follow only clearly linked job listings or ATS links on the same company-controlled careers journey.
2. Prefer a company-operated or company-authorized ATS feed or public ATS job-detail page (`ats_feed`) when one is discoverable. A feed may be JSON, XML, RSS, or a documented public listing endpoint; it must not require a login, session cookie, CAPTCHA bypass, or access token.
3. Use `careers_page` for a first-party job listing when no usable ATS feed exists. Use `ats_feed` only when the record was obtained from the public ATS endpoint, not when a crawler inferred or copied it from an unrelated aggregator.
4. Emit an `it_hiring` signal only for a new or materially changed IT/infrastructure/engineering posting that has a stable public job URL or stable public source identifier. Preserve the title, team or department, location, publication/update time when available, and canonical URL as evidence attributes or excerpt; do not infer an IT role solely from a generic company-wide hiring page.
5. Do not use job aggregators, employee-submitted listings, search-result snippets, or scraped social profiles as primary evidence. They may be discovery hints only and cannot independently produce a signal.

### Testable source for the hiring family

For each account, the acceptance test is a public `careersUrl` that returns a company careers page and links to either (a) a stable job-detail URL or (b) a public ATS listing/feed. A fixture or integration test should assert that one listing can be collected into an `ats_feed` or `careers_page` source reference, normalized as `job_posting`, and re-collected without changing its stable identity unless its source record, account, category, or observation time changes. If neither the careers page nor a permitted public ATS endpoint is usable, the expected result is an explicit unsupported/partial outcome—not an inferred hiring signal.

## Approved company-post/news strategy

1. Prefer the company’s own public newsroom, blog, press-release, engineering blog, or investor/company updates page. Represent the resulting records as `company_news`; use `company_article` for an article and `company_post` for a first-party post format.
2. Use a public company sitemap, RSS/Atom feed, or linked archive (`sitemap`) only to discover or enumerate first-party URLs. The sitemap itself is not the evidence of a company announcement; the linked public article/post is. The emitted source reference should point to the article/post when available.
3. Emit an `it_company_news` signal only when a first-party post contains a material IT, infrastructure, platform, security, engineering, or technology-business change. Capture the canonical URL, author/publisher if public, publication time if public, title, and a short attributable excerpt. Do not convert ordinary marketing, reposts, or third-party coverage into company-news evidence.
4. A public company post mirrored on a third-party platform is not an approved primary source unless the company’s own page links to or identifies that mirror as its official publication. Do not use LinkedIn posts as an active source under this strategy.

### Testable source for the company-news family

For each account, the acceptance test is a public first-party news/article URL, discovered directly or through a permitted public sitemap/feed, that can be fetched and parsed into a `company_news` source reference with `company_article` or `company_post` evidence. The test should verify that the stored URL is canonical when a canonical link exists, the excerpt is traceable to the page, and a re-fetch deduplicates the same source record. If no qualifying first-party article/post is available, produce no news signal and record unsupported/partial status as applicable.

## Explicit LinkedIn exclusion and approval gate

Authenticated LinkedIn scraping is explicitly out of scope. Do not log in, reuse a user session, automate a browser against an authenticated LinkedIn page, bypass access controls, or collect LinkedIn content with cookies or personal credentials. The account’s `linkedinCompanyUrl` is metadata/discovery context only and must not be used as evidence by the active collectors.

The `linkedin_api` source system is a future, disabled-by-default option. It may be enabled only after documented legal/privacy review, written product approval, and an approved LinkedIn API/commercial access path with credentials handled by the deployment environment. Until all three approvals exist, LinkedIn absence is unsupported coverage, never a reason to scrape or downgrade source provenance.

## Collection controls

### Robots, terms, and rate limits

- Check and honor `robots.txt` for every host before fetching. A disallowed path is not fetched; robots permission does not override terms, law, authentication requirements, or provider-specific restrictions.
- Follow the site’s published terms, API terms, and feed usage guidance. Stop on an explicit prohibition or access-control challenge and record the source error.
- Use a descriptive user agent with an operational contact where permitted. Do not rotate identities to evade limits.
- Honor `Retry-After` and documented provider limits. Otherwise use at most one request per host per 15 minutes during normal polling, with exponential backoff for `429`, `5xx`, timeouts, and connection failures. Do not retry `401`, `403`, CAPTCHA, or robots denial automatically.
- Bound each run to the account’s configured public URLs plus explicitly linked first-party paths. Do not perform broad crawling or search-engine scraping.

### Fetch cadence and windows

- Poll careers/ATS sources at most every 6 hours per host; poll company news feeds/pages at most every 6 hours per host. A deployment may poll less often.
- Use the run’s explicit UTC window as the collection boundary. A first run may backfill at most 30 days; subsequent runs should request only changes since the last successful cursor or watermark.
- Record the actual retrieval time in `collectedAt`/`capturedAt` and preserve the source’s publication/update time as `observedAt` when available. Do not claim freshness beyond the last successful fetch.
- A failed or partial fetch must not be represented as an empty source or as proof that no jobs/news exist.

### Retention and attribution

- Retain only the minimum metadata needed for deduplication, audit, and the signal contract: source system, stable public record ID or canonical URL, account ID, timestamps, title, classification, and a short excerpt.
- Do not retain authentication material, cookies, session headers, raw HTML dumps, or personal data not necessary for the signal. Redact contact details and applicant information from excerpts and attributes.
- Retain source references and derived evidence for 90 days after last use, unless a stricter account or legal policy applies; retain aggregate signal history only as permitted by the governing retention policy. Deletion requests and legal holds override this default.
- Attribute every signal to the originating company/ATS and canonical URL. Excerpts must be short, factual, and clearly marked as quotations where applicable. Do not imply company endorsement of the derived signal.

## Fallback, unsupported, and error behavior

Source selection is ordered: public ATS feed or public job detail, then the company careers page; for news, the first-party article/post, discovered through its own page or public sitemap/feed. Fallback must remain first-party/public and must not silently switch to an aggregator or LinkedIn.

- **Unsupported:** no public approved endpoint exists, the page requires authentication, robots/terms prohibit collection, or the source cannot provide a stable attributable record. Emit no signal. Record the source as unsupported with the reason in the run’s error/reporting layer.
- **Partial:** at least one approved source was collected but another configured source failed, was rate-limited, or was unavailable. Emit only validated records and mark the run `partial` with a retryable error where appropriate. Never turn the missing portion into zero results.
- **Failed:** no approved source could be collected for the requested family, or a non-retryable policy/access error prevents safe collection. Mark the run `failed` with a non-empty error identifying the source and reason; do not fabricate snapshots or signals.
- **Duplicate or changed record:** deduplicate by stable source record ID, canonical URL, or a deterministic fallback based on source URL plus provider ID. Preserve the original source reference and update observation time only when the provider indicates a material change.
- **Malformed or unverifiable content:** quarantine the item, do not emit evidence, and report a non-retryable parse/attribution error. A malformed item must not make the entire unrelated source family appear empty.

These outcomes map to the existing run statuses `succeeded`, `partial`, and `failed`; they do not require changes to the contracts. A successful run may contain no signals only when the approved source was fetched successfully and the bounded window genuinely contained no qualifying records.

## Assumptions

- Legal/privacy and security review has approved public first-party collection under the controls above; this document does not grant that approval.
- The runtime can enforce per-host cadence, robots checks, bounded windows, retention deletion, and source attribution. If it cannot, the source is unsupported until those controls exist.
- The current contract’s `sitemap` value is used for discovery metadata, while `company_news` remains the source of company-post/news evidence. No new source-system or evidence-kind value is introduced.

'use strict';

/**
 * GET /docs/search?q={query}
 *
 * Full-text search across the three official documents (CC&Rs, Bylaws, Rules).
 * Any signed-in user. Returns ranked hits with snippets.
 *
 * Ranking:
 *   - Title match heavily boosted
 *   - Word match count
 *   - Phrase match boosts further
 */

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { ok, badRequest, serverError, getClaims, forbidden } = require('./shared/auth');

const OFFICIAL_CYCLES = {
  ccrs: { id: 'Cycle-02-CCRs',   label: 'CC&Rs' },
  bylaws: { id: 'Cycle-02-Bylaws', label: 'Bylaws' },
  rules: { id: 'Cycle-02-Rules',  label: 'Rules of Conduct' },
};

const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 80;

async function fetchSections(cycleId) {
  // Fetch CONTENT (titles, classification) and DOCTEXT (legal text) and merge.
  async function queryByPrefix(prefix) {
    const items = [];
    let lastKey;
    do {
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': prefix,
        },
        ExclusiveStartKey: lastKey,
      }));
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
  }

  const [contentItems, textItems] = await Promise.all([
    queryByPrefix('CONTENT#'),
    queryByPrefix('DOCTEXT#'),
  ]);

  // Build a lookup of text by ART#SEC key
  const textBy = {};
  for (const t of textItems) {
    const m = (t.SK || '').match(/^DOCTEXT#(ART-\d+#SEC-[\dA-Za-z]+)$/);
    if (m) textBy[m[1]] = t.text || '';
  }

  // Merge text into content items
  return contentItems.map(c => {
    const key = `ART-${String(c.articleNumber).padStart(2, '0')}#SEC-${String(c.sectionNumber).padStart(2, '0')}`;
    return Object.assign({}, c, { text: c.text || textBy[key] || '' });
  });
}

function makeSnippet(text, queryTerms) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }
  if (bestIdx === -1) {
    return text.slice(0, SNIPPET_RADIUS * 2) + (text.length > SNIPPET_RADIUS * 2 ? '…' : '');
  }
  const start = Math.max(0, bestIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, bestIdx + SNIPPET_RADIUS * 2);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

function scoreSection(section, queryTerms, fullQuery) {
  const title = (section.sectionTitle || '').toLowerCase();
  const text = (section.text || '').toLowerCase();
  let score = 0;

  // Phrase match in title
  if (fullQuery && title.includes(fullQuery)) score += 50;
  // Phrase match in text
  if (fullQuery && text.includes(fullQuery)) score += 20;

  for (const term of queryTerms) {
    if (!term) continue;
    const inTitle = title.split(/\W+/).filter(t => t === term).length;
    const inText = (text.match(new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')) || []).length;
    score += inTitle * 10;
    score += Math.min(inText, 10); // cap text matches per term
  }

  return score;
}

exports.handler = async (event) => {
  // Sign-in enforced by API Gateway; just verify claims exist.
  try {
    getClaims(event);
  } catch (e) {
    return forbidden('Sign-in required');
  }

  const qs = event.queryStringParameters || {};
  const q = (qs.q || '').trim();
  if (!q) return badRequest('Query parameter q is required');
  if (q.length < 2) return badRequest('Query must be at least 2 characters');

  const fullQuery = q.toLowerCase();
  const queryTerms = fullQuery
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);

  if (queryTerms.length === 0) return ok({ hits: [] });

  try {
    const [ccrItems, bylawItems, ruleItems] = await Promise.all([
      fetchSections(OFFICIAL_CYCLES.ccrs.id),
      fetchSections(OFFICIAL_CYCLES.bylaws.id),
      fetchSections(OFFICIAL_CYCLES.rules.id),
    ]);

    const allHits = [];

    function processItems(items, cycleKey) {
      for (const it of items) {
        const score = scoreSection(it, queryTerms, fullQuery);
        if (score <= 0) continue;
        const secId = `ART-${String(it.articleNumber).padStart(2, '0')}#SEC-${String(it.sectionNumber).padStart(2, '0')}`;
        allHits.push({
          cycle: cycleKey,
          cycleId: OFFICIAL_CYCLES[cycleKey].id,
          docLabel: OFFICIAL_CYCLES[cycleKey].label,
          secId,
          articleNumber: it.articleNumber,
          articleTitle: it.articleTitle || '',
          sectionNumber: it.sectionNumber,
          sectionTitle: it.sectionTitle || '',
          score,
          snippet: makeSnippet(it.text || '', queryTerms),
        });
      }
    }

    processItems(ccrItems,   'ccrs');
    processItems(bylawItems, 'bylaws');
    processItems(ruleItems,  'rules');

    allHits.sort((a, b) => b.score - a.score);

    return ok({
      query: q,
      total: allHits.length,
      hits: allHits.slice(0, MAX_RESULTS),
    });
  } catch (err) {
    console.error('[docs-search] error:', err);
    return serverError(err.message);
  }
};

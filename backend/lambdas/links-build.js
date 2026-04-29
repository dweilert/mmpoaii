'use strict';

/**
 * POST /docs/links/rebuild
 *
 * Admin-only. Recomputes auto-linkages between sections in the three official
 * documents (CC&Rs, Bylaws, Rules of Conduct) and stores them in DynamoDB.
 *
 * Algorithm:
 *   1. Fetch all CONTENT items for each cycle.
 *   2. Tokenize each section's title + text into significant words.
 *   3. Compute Jaccard similarity between every pair across documents.
 *   4. Keep top N matches per source section above a minimum threshold.
 *   5. Replace existing AUTO links; preserve MANUAL links.
 *
 * Storage:
 *   PK = `LINK#{srcCycle}`
 *   SK = `{srcSec}#{tgtCycle}#{tgtSec}`
 *   attrs: score, source ('auto'|'manual'), createdAt
 */

const { QueryCommand, BatchWriteCommand, DeleteCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { ok, forbidden, serverError, requireGroup } = require('./shared/auth');

const OFFICIAL_CYCLES = {
  ccrs: 'Cycle-02-CCRs',
  bylaws: 'Cycle-02-Bylaws',
  rules: 'Cycle-02-Rules',
};

const MIN_SCORE = 0.10;
const MAX_LINKS_PER_SECTION = 5;

// Words to drop because they appear nearly everywhere in HOA docs and add noise.
const STOP_WORDS = new Set([
  // English stopwords
  'a','an','the','and','or','but','if','then','else','of','at','by','for','with','about','against',
  'between','into','through','during','before','after','above','below','to','from','up','down','in',
  'out','on','off','over','under','again','further','is','am','are','was','were','be','been','being',
  'have','has','had','do','does','did','doing','this','that','these','those','i','you','he','she',
  'it','we','they','them','their','his','her','our','your','my','me','us','him','as','it','its',
  'such','any','all','some','no','not','only','own','same','so','than','too','very','can','will',
  'just','dont','should','now','also','may','must','shall','each','every','one','two','three',
  // HOA-ubiquitous
  'owner','owners','association','lot','lots','property','properties','member','members','board',
  'directors','community','section','article','articles','sections','provision','provisions',
  'declaration','bylaws','rules','common','area','areas','meadow','mountain','mmpoa','poa','hoa',
  'shall','include','includes','including','within','upon','herein','thereof','thereto','therein',
  'such','meaning','means','defined','definitions','title','number','reference','referenced',
]);

function tokenize(text) {
  if (!text) return new Set();
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  );
}

function jaccard(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function fetchSections(cycleId) {
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

  const textBy = {};
  for (const t of textItems) {
    const m = (t.SK || '').match(/^DOCTEXT#(ART-\d+#SEC-[\dA-Za-z]+)$/);
    if (m) textBy[m[1]] = t.text || '';
  }

  return contentItems.map(it => {
    const secId = `ART-${String(it.articleNumber).padStart(2, '0')}#SEC-${String(it.sectionNumber).padStart(2, '0')}`;
    const text = it.text || textBy[secId] || '';
    return {
      cycleId,
      secId,
      articleNumber: it.articleNumber,
      sectionNumber: it.sectionNumber,
      sectionTitle: it.sectionTitle || '',
      text,
      tokens: tokenize((it.sectionTitle || '') + ' ' + text),
    };
  });
}

async function deleteAutoLinks(srcCycle) {
  // Query existing links for this srcCycle
  let lastKey;
  let deleted = 0;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `LINK#${srcCycle}` },
      ExclusiveStartKey: lastKey,
    }));

    const autoOnly = (result.Items || []).filter(it => it.source !== 'manual');

    // BatchWrite up to 25 at a time
    for (let i = 0; i < autoOnly.length; i += 25) {
      const batch = autoOnly.slice(i, i + 25);
      await ddb.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: batch.map(it => ({
            DeleteRequest: { Key: { PK: it.PK, SK: it.SK } },
          })),
        },
      }));
      deleted += batch.length;
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return deleted;
}

async function writeLinks(srcCycle, links) {
  // BatchWrite up to 25 at a time
  for (let i = 0; i < links.length; i += 25) {
    const batch = links.slice(i, i + 25);
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: batch.map(l => ({
          PutRequest: {
            Item: {
              PK: `LINK#${srcCycle}`,
              SK: `${l.srcSec}#${l.tgtCycle}#${l.tgtSec}`,
              srcCycle,
              srcSec: l.srcSec,
              tgtCycle: l.tgtCycle,
              tgtSec: l.tgtSec,
              score: l.score,
              source: 'auto',
              createdAt: new Date().toISOString(),
            },
          },
        })),
      },
    }));
  }
}

exports.handler = async (event) => {
  try {
    requireGroup(event, ['review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  try {
    console.log('[links-build] fetching sections...');
    const ccrs   = await fetchSections(OFFICIAL_CYCLES.ccrs);
    const bylaws = await fetchSections(OFFICIAL_CYCLES.bylaws);
    const rules  = await fetchSections(OFFICIAL_CYCLES.rules);

    console.log(`[links-build] CC&Rs=${ccrs.length} Bylaws=${bylaws.length} Rules=${rules.length}`);

    // Pairs to consider:
    //   CC&Rs <-> Bylaws  (bidirectional)
    //   Bylaws <-> Rules  (bidirectional)
    //   CC&Rs <-> Rules   (bidirectional, optional but useful)
    function buildLinks(srcDocs, tgtDocs, srcCycle, tgtCycle) {
      const links = [];
      for (const src of srcDocs) {
        const matches = [];
        for (const tgt of tgtDocs) {
          const score = jaccard(src.tokens, tgt.tokens);
          if (score >= MIN_SCORE) {
            matches.push({ tgtSec: tgt.secId, score });
          }
        }
        matches.sort((a, b) => b.score - a.score);
        const top = matches.slice(0, MAX_LINKS_PER_SECTION);
        for (const m of top) {
          links.push({ srcSec: src.secId, tgtCycle, tgtSec: m.tgtSec, score: parseFloat(m.score.toFixed(4)) });
        }
      }
      return links;
    }

    const ccrToBylaws = buildLinks(ccrs, bylaws, OFFICIAL_CYCLES.ccrs, OFFICIAL_CYCLES.bylaws);
    const bylawToCcr  = buildLinks(bylaws, ccrs, OFFICIAL_CYCLES.bylaws, OFFICIAL_CYCLES.ccrs);
    const bylawToRule = buildLinks(bylaws, rules, OFFICIAL_CYCLES.bylaws, OFFICIAL_CYCLES.rules);
    const ruleToBylaw = buildLinks(rules, bylaws, OFFICIAL_CYCLES.rules, OFFICIAL_CYCLES.bylaws);
    const ccrToRule   = buildLinks(ccrs, rules, OFFICIAL_CYCLES.ccrs, OFFICIAL_CYCLES.rules);
    const ruleToCcr   = buildLinks(rules, ccrs, OFFICIAL_CYCLES.rules, OFFICIAL_CYCLES.ccrs);

    console.log(`[links-build] CCR->Bylaws=${ccrToBylaws.length} Bylaws->CCR=${bylawToCcr.length}`);
    console.log(`[links-build] Bylaws->Rules=${bylawToRule.length} Rules->Bylaws=${ruleToBylaw.length}`);
    console.log(`[links-build] CCR->Rules=${ccrToRule.length} Rules->CCR=${ruleToCcr.length}`);

    // Clear existing auto links per source cycle
    await deleteAutoLinks(OFFICIAL_CYCLES.ccrs);
    await deleteAutoLinks(OFFICIAL_CYCLES.bylaws);
    await deleteAutoLinks(OFFICIAL_CYCLES.rules);

    // Write new links grouped by source cycle
    await writeLinks(OFFICIAL_CYCLES.ccrs,  ccrToBylaws.concat(ccrToRule));
    await writeLinks(OFFICIAL_CYCLES.bylaws, bylawToCcr.concat(bylawToRule));
    await writeLinks(OFFICIAL_CYCLES.rules,  ruleToBylaw.concat(ruleToCcr));

    return ok({
      counts: {
        ccrs: ccrs.length,
        bylaws: bylaws.length,
        rules: rules.length,
      },
      links: {
        ccrToBylaws: ccrToBylaws.length,
        bylawToCcr:  bylawToCcr.length,
        bylawToRule: bylawToRule.length,
        ruleToBylaw: ruleToBylaw.length,
        ccrToRule:   ccrToRule.length,
        ruleToCcr:   ruleToCcr.length,
      },
    });
  } catch (err) {
    console.error('[links-build] error:', err);
    return serverError(err.message);
  }
};

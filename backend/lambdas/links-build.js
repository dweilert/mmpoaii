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

const MIN_SCORE = 0.05;          // base threshold for auto-suggested matches
const MAX_LINKS_PER_SECTION = 8;  // cap per source section
const MIN_FALLBACK_SCORE = 0.01;  // when forcing a guarantee link, require at least this much

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
      articleTitle: it.articleTitle || '',
      sectionNumber: it.sectionNumber,
      sectionTitle: it.sectionTitle || '',
      text,
      tokens: tokenize((it.sectionTitle || '') + ' ' + text),
    };
  });
}

// CC&R Definitions sections (Article 1 in standard CC&Rs) are excluded from
// linkage requirements — they're glossary entries, not enforceable covenants.
function isDefinitionSection(s) {
  const t = (s.articleTitle || '').toLowerCase();
  return t.includes('definition');
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

    // For each source section, score every target and return them sorted desc.
    // Skip CC&R definition sections from being potential targets — they're
    // glossary entries, not enforceable covenants.
    function scoreAll(src, tgtDocs, isCcrTarget) {
      const matches = [];
      for (const tgt of tgtDocs) {
        if (isCcrTarget && isDefinitionSection(tgt)) continue;
        const score = jaccard(src.tokens, tgt.tokens);
        if (score > 0) matches.push({ tgtSec: tgt.secId, score });
      }
      matches.sort((a, b) => b.score - a.score);
      return matches;
    }

    function buildLinks(srcDocs, tgtDocs, srcCycle, tgtCycle, options) {
      const opts = options || {};
      const links = [];
      for (const src of srcDocs) {
        if (opts.skipDefinitionSrc && isDefinitionSection(src)) continue;
        const all = scoreAll(src, tgtDocs, opts.skipDefinitionTargetIfCcrs);
        const above = all.filter(m => m.score >= MIN_SCORE).slice(0, MAX_LINKS_PER_SECTION);
        for (const m of above) {
          links.push({ srcSec: src.secId, tgtCycle, tgtSec: m.tgtSec, score: parseFloat(m.score.toFixed(4)) });
        }
      }
      return links;
    }

    const ccrToBylaws = buildLinks(ccrs,   bylaws, OFFICIAL_CYCLES.ccrs,   OFFICIAL_CYCLES.bylaws, { skipDefinitionSrc: true });
    const bylawToCcr  = buildLinks(bylaws, ccrs,   OFFICIAL_CYCLES.bylaws, OFFICIAL_CYCLES.ccrs,   { skipDefinitionTargetIfCcrs: true });
    const bylawToRule = buildLinks(bylaws, rules,  OFFICIAL_CYCLES.bylaws, OFFICIAL_CYCLES.rules);
    const ruleToBylaw = buildLinks(rules,  bylaws, OFFICIAL_CYCLES.rules,  OFFICIAL_CYCLES.bylaws);
    const ccrToRule   = buildLinks(ccrs,   rules,  OFFICIAL_CYCLES.ccrs,   OFFICIAL_CYCLES.rules,  { skipDefinitionSrc: true });
    const ruleToCcr   = buildLinks(rules,  ccrs,   OFFICIAL_CYCLES.rules,  OFFICIAL_CYCLES.ccrs,   { skipDefinitionTargetIfCcrs: true });

    // ── Guarantee parent linkage where the hierarchy demands it ───────────────
    // Every Bylaw should have at least one CC&R parent (excluding Definitions).
    // Every Rule should have at least one Bylaw OR CC&R parent.
    // If the threshold-based scan didn't produce one, force the best match
    // (still requires MIN_FALLBACK_SCORE so we don't connect totally unrelated text).

    function hasLinkBetween(srcCycleKey, srcSec, tgtCycleKey, allLinkLists) {
      for (const list of allLinkLists) {
        for (const l of list) {
          if (l._src === srcCycleKey && l.srcSec === srcSec && l._tgt === tgtCycleKey) return true;
          if (l._src === tgtCycleKey && l.srcSec === l.srcSec && l._tgt === srcCycleKey && l.tgtSec === srcSec) return true;
        }
      }
      return false;
    }

    // Tag with src/tgt cycle keys so the helper above can match in any direction
    function tagKey(arr, srcKey, tgtKey) {
      arr.forEach(l => { l._src = srcKey; l._tgt = tgtKey; });
      return arr;
    }
    tagKey(ccrToBylaws, 'ccrs',   'bylaws');
    tagKey(bylawToCcr,  'bylaws', 'ccrs');
    tagKey(bylawToRule, 'bylaws', 'rules');
    tagKey(ruleToBylaw, 'rules',  'bylaws');
    tagKey(ccrToRule,   'ccrs',   'rules');
    tagKey(ruleToCcr,   'rules',  'ccrs');

    // Build a quick lookup of "section X has a link to any Y in cycle Z" (either direction)
    function hasCrossLink(node, otherCycleKey, allLinks) {
      const myCycle = node.cycleKey;
      const mySec   = node.secId;
      for (const l of allLinks) {
        if (l._src === myCycle && l.srcSec === mySec && l._tgt === otherCycleKey) return true;
        if (l._tgt === myCycle && l.tgtSec === mySec && l._src === otherCycleKey) return true;
      }
      return false;
    }

    function withCycleKey(arr, key) {
      return arr.map(s => Object.assign({}, s, { cycleKey: key }));
    }
    const allCcrs   = withCycleKey(ccrs,   'ccrs');
    const allBylaws = withCycleKey(bylaws, 'bylaws');
    const allRules  = withCycleKey(rules,  'rules');

    const everyLink = [].concat(ccrToBylaws, bylawToCcr, bylawToRule, ruleToBylaw, ccrToRule, ruleToCcr);

    // Fallback for Bylaws with no CC&R link
    let forcedBylawCcr = 0;
    for (const b of allBylaws) {
      if (hasCrossLink(b, 'ccrs', everyLink)) continue;
      const all = scoreAll(b, ccrs, true /* skip definition CC&Rs */);
      if (all.length === 0) continue;
      const best = all[0];
      if (best.score < MIN_FALLBACK_SCORE) continue;
      const fallback = {
        srcSec: b.secId, tgtCycle: OFFICIAL_CYCLES.ccrs, tgtSec: best.tgtSec,
        score: parseFloat(best.score.toFixed(4)),
        _src: 'bylaws', _tgt: 'ccrs',
      };
      bylawToCcr.push(fallback);
      everyLink.push(fallback);
      forcedBylawCcr++;
    }

    // Fallback for Rules with no Bylaw OR CC&R link
    let forcedRuleParent = 0;
    for (const r of allRules) {
      if (hasCrossLink(r, 'bylaws', everyLink)) continue;
      if (hasCrossLink(r, 'ccrs',   everyLink)) continue;
      // Choose best between Bylaw and CC&R candidates
      const bylawMatches = scoreAll(r, bylaws, false);
      const ccrMatches   = scoreAll(r, ccrs,   true /* skip definitions */);
      let best = null;
      let target = null;
      if (bylawMatches.length > 0) { best = bylawMatches[0]; target = 'bylaws'; }
      if (ccrMatches.length > 0 && (!best || ccrMatches[0].score > best.score)) {
        best = ccrMatches[0]; target = 'ccrs';
      }
      if (!best || best.score < MIN_FALLBACK_SCORE) continue;
      const fallback = {
        srcSec: r.secId,
        tgtCycle: target === 'bylaws' ? OFFICIAL_CYCLES.bylaws : OFFICIAL_CYCLES.ccrs,
        tgtSec: best.tgtSec,
        score: parseFloat(best.score.toFixed(4)),
        _src: 'rules', _tgt: target,
      };
      if (target === 'bylaws') ruleToBylaw.push(fallback);
      else                     ruleToCcr.push(fallback);
      everyLink.push(fallback);
      forcedRuleParent++;
    }

    // Strip helper props before writing
    [ccrToBylaws, bylawToCcr, bylawToRule, ruleToBylaw, ccrToRule, ruleToCcr].forEach(arr => {
      arr.forEach(l => { delete l._src; delete l._tgt; });
    });

    console.log(`[links-build] CCR->Bylaws=${ccrToBylaws.length} Bylaws->CCR=${bylawToCcr.length}`);
    console.log(`[links-build] Bylaws->Rules=${bylawToRule.length} Rules->Bylaws=${ruleToBylaw.length}`);
    console.log(`[links-build] CCR->Rules=${ccrToRule.length} Rules->CCR=${ruleToCcr.length}`);
    console.log(`[links-build] forced Bylaw->CCR fallbacks=${forcedBylawCcr}, Rule->parent fallbacks=${forcedRuleParent}`);

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
      forced: {
        bylawToCcr: forcedBylawCcr,
        ruleToParent: forcedRuleParent,
      },
    });
  } catch (err) {
    console.error('[links-build] error:', err);
    return serverError(err.message);
  }
};

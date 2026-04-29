'use strict';

/**
 * GET /docs/links?cycle={cycleId}&secId={ART-NN#SEC-NN}
 *
 * Returns related sections in the other documents for a given section.
 * Any signed-in user. Includes title metadata for each linked section so
 * the frontend can render them without an extra round trip.
 */

const { QueryCommand, BatchGetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { ok, badRequest, serverError, getClaims, forbidden } = require('./shared/auth');

const ALLOWED_CYCLES = new Set([
  'Cycle-02-CCRs',
  'Cycle-02-Bylaws',
  'Cycle-02-Rules',
]);

const CYCLE_LABELS = {
  'Cycle-02-CCRs':   'CC&Rs',
  'Cycle-02-Bylaws': 'Bylaws',
  'Cycle-02-Rules':  'Rules of Conduct',
};

const CYCLE_KEY = {
  'Cycle-02-CCRs':   'ccrs',
  'Cycle-02-Bylaws': 'bylaws',
  'Cycle-02-Rules':  'rules',
};

exports.handler = async (event) => {
  try {
    getClaims(event);
  } catch (e) {
    return forbidden('Sign-in required');
  }

  const qs = event.queryStringParameters || {};
  const cycleId = qs.cycle;
  const secId   = qs.secId;
  if (!cycleId || !secId) return badRequest('cycle and secId are required');
  if (!ALLOWED_CYCLES.has(cycleId)) return badRequest('Invalid cycle');

  try {
    // Query all links from this source section
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `LINK#${cycleId}`,
        ':sk': `${secId}#`,
      },
    }));

    const links = result.Items || [];
    if (links.length === 0) {
      return ok({ cycle: cycleId, secId, links: [] });
    }

    // Resolve metadata for each linked target by BatchGet on CONTENT items.
    const keys = links.map(l => {
      const m = l.tgtSec.match(/^ART-(\d+)#SEC-(\w+)$/);
      const artPad = m ? String(parseInt(m[1], 10)).padStart(2, '0') : '';
      const secPad = m ? String(parseInt(m[2], 10)).padStart(2, '0') : '';
      return {
        PK: `CYCLE#${l.tgtCycle}`,
        SK: `CONTENT#ART-${artPad}#SEC-${secPad}`,
      };
    });

    // Dedup keys
    const seen = new Set();
    const uniqueKeys = [];
    for (const k of keys) {
      const sig = k.PK + '|' + k.SK;
      if (!seen.has(sig)) {
        seen.add(sig);
        uniqueKeys.push(k);
      }
    }

    // BatchGet up to 100 at a time
    const metaMap = {};
    for (let i = 0; i < uniqueKeys.length; i += 100) {
      const batch = uniqueKeys.slice(i, i + 100);
      const r = await ddb.send(new BatchGetCommand({
        RequestItems: {
          [TABLE_NAME]: { Keys: batch },
        },
      }));
      const got = (r.Responses && r.Responses[TABLE_NAME]) || [];
      for (const it of got) {
        metaMap[it.PK + '|' + it.SK] = it;
      }
    }

    const enriched = links.map(l => {
      const m = l.tgtSec.match(/^ART-(\d+)#SEC-(\w+)$/);
      const artPad = m ? String(parseInt(m[1], 10)).padStart(2, '0') : '';
      const secPad = m ? String(parseInt(m[2], 10)).padStart(2, '0') : '';
      const sig = `CYCLE#${l.tgtCycle}|CONTENT#ART-${artPad}#SEC-${secPad}`;
      const meta = metaMap[sig];
      return {
        tgtCycle: l.tgtCycle,
        tgtCycleKey: CYCLE_KEY[l.tgtCycle] || l.tgtCycle,
        tgtDocLabel: CYCLE_LABELS[l.tgtCycle] || l.tgtCycle,
        tgtSec: l.tgtSec,
        articleNumber: meta ? meta.articleNumber : null,
        articleTitle:  meta ? (meta.articleTitle || '') : '',
        sectionNumber: meta ? meta.sectionNumber : null,
        sectionTitle:  meta ? (meta.sectionTitle || '') : '',
        score: l.score,
        source: l.source || 'auto',
      };
    });

    // Sort by target cycle, then by score desc
    enriched.sort((a, b) => {
      if (a.tgtCycle !== b.tgtCycle) return a.tgtCycle.localeCompare(b.tgtCycle);
      return (b.score || 0) - (a.score || 0);
    });

    return ok({
      cycle: cycleId,
      cycleKey: CYCLE_KEY[cycleId] || cycleId,
      docLabel: CYCLE_LABELS[cycleId] || cycleId,
      secId,
      links: enriched,
    });
  } catch (err) {
    console.error('[links-get] error:', err);
    return serverError(err.message);
  }
};

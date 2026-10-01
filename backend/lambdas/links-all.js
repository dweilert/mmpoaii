'use strict';

/**
 * GET /docs/links/all
 *
 * Returns a complete relationship graph for the audit report:
 *   - Every section in CC&Rs, Bylaws, and Rules of Conduct
 *   - Every cross-document link
 *
 * Group: board, reviewers, or review-admins.
 */

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { ok, forbidden, serverError, requireGroup } = require('./shared/auth');

const OFFICIAL_CYCLES = {
  ccrs:   { id: 'Cycle-02-CCRs',   label: 'CC&Rs' },
  bylaws: { id: 'Cycle-02-Bylaws', label: 'Bylaws' },
  rules:  { id: 'Cycle-02-Rules',  label: 'Rules of Conduct' },
};

const CYCLE_TO_KEY = {
  'Cycle-02-CCRs':   'ccrs',
  'Cycle-02-Bylaws': 'bylaws',
  'Cycle-02-Rules':  'rules',
};

async function queryAll(pk, prefix) {
  const items = [];
  let lastKey;
  do {
    const params = {
      TableName: TABLE_NAME,
      ExclusiveStartKey: lastKey,
    };
    if (prefix && prefix.length > 0) {
      params.KeyConditionExpression = 'PK = :pk AND begins_with(SK, :sk)';
      params.ExpressionAttributeValues = { ':pk': pk, ':sk': prefix };
    } else {
      // Empty prefix means "all items under this PK"
      params.KeyConditionExpression = 'PK = :pk';
      params.ExpressionAttributeValues = { ':pk': pk };
    }
    const result = await ddb.send(new QueryCommand(params));
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function fetchSections(cycleId) {
  const items = await queryAll(`CYCLE#${cycleId}`, 'CONTENT#');
  return items
    .map(it => ({
      cycleId,
      cycleKey: CYCLE_TO_KEY[cycleId],
      secId: `ART-${String(it.articleNumber).padStart(2, '0')}#SEC-${String(it.sectionNumber).padStart(2, '0')}`,
      articleNumber: it.articleNumber,
      articleTitle:  it.articleTitle || '',
      sectionNumber: it.sectionNumber,
      sectionTitle:  it.sectionTitle || '',
      classification: it.classification || null,
    }))
    .sort((a, b) => {
      if (a.articleNumber !== b.articleNumber) return a.articleNumber - b.articleNumber;
      const an = parseInt(a.sectionNumber, 10) || 0;
      const bn = parseInt(b.sectionNumber, 10) || 0;
      return an - bn;
    });
}

async function fetchLinks(cycleId) {
  const items = await queryAll(`LINK#${cycleId}`, '');
  return items.map(it => ({
    srcCycle: cycleId,
    srcCycleKey: CYCLE_TO_KEY[cycleId],
    srcSec: it.srcSec,
    tgtCycle: it.tgtCycle,
    tgtCycleKey: CYCLE_TO_KEY[it.tgtCycle],
    tgtSec: it.tgtSec,
    score: it.score || 0,
    source: it.source || 'auto',
  }));
}

exports.handler = async (event) => {
  try {
    requireGroup(event, ['board', 'reviewers', 'review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  try {
    const [ccrs, bylaws, rules, ccrLinks, bylawLinks, ruleLinks] = await Promise.all([
      fetchSections(OFFICIAL_CYCLES.ccrs.id),
      fetchSections(OFFICIAL_CYCLES.bylaws.id),
      fetchSections(OFFICIAL_CYCLES.rules.id),
      fetchLinks(OFFICIAL_CYCLES.ccrs.id),
      fetchLinks(OFFICIAL_CYCLES.bylaws.id),
      fetchLinks(OFFICIAL_CYCLES.rules.id),
    ]);

    const allLinks = ccrLinks.concat(bylawLinks).concat(ruleLinks);

    return ok({
      sections: { ccrs, bylaws, rules },
      links: allLinks,
      counts: {
        ccrs: ccrs.length,
        bylaws: bylaws.length,
        rules: rules.length,
        links: allLinks.length,
      },
    });
  } catch (err) {
    console.error('[links-all] error:', err);
    return serverError(err.message);
  }
};

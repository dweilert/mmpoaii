'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/summary
 * Returns full summary view: all sections with aggregate votes and admin final decisions.
 * Group: review-admins
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, 'review-admins');
  } catch (e) {
    return forbidden(e.message);
  }

  const cycleId = event.pathParameters?.cycleId;
  if (!cycleId) return badRequest('cycleId is required');

  try {
    // Get content, votes, and summary decisions in parallel
    const [contentResult, voteResult, summaryResult] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': 'CONTENT#' },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': 'VOTE#' },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': 'SUMMARY#' },
      })),
    ]);

    // Aggregate votes per section
    const sectionVotes = {};
    for (const item of (voteResult.Items || [])) {
      const match = item.SK.match(/VOTE#(ART-\d+#SEC-\d+)#USER#/);
      if (!match) continue;
      const key = match[1];
      if (!sectionVotes[key]) {
        sectionVotes[key] = { approve: 0, disapprove: 0, discuss: 0, notes: [] };
      }
      if (item.vote) sectionVotes[key][item.vote]++;
      if (item.notes) sectionVotes[key].notes.push(item.notes);
    }

    // Index summary decisions
    const summaryMap = {};
    for (const item of (summaryResult.Items || [])) {
      const key = item.SK.replace('SUMMARY#', '');
      summaryMap[key] = {
        finalVote: item.finalVote,
        decidedBy: item.decidedBy,
        decidedAt: item.decidedAt,
      };
    }

    // Build article-grouped results with summary
    const articleMap = {};
    for (const item of (contentResult.Items || [])) {
      const artNum = String(item.articleNumber).padStart(2, '0');
      if (!articleMap[artNum]) {
        articleMap[artNum] = {
          articleNumber: item.articleNumber,
          articleTitle: item.articleTitle,
          sections: [],
        };
      }
      const secKey = `ART-${artNum}#SEC-${String(item.sectionNumber).padStart(2, '0')}`;
      const votes = sectionVotes[secKey] || { approve: 0, disapprove: 0, discuss: 0, notes: [] };
      const summary = summaryMap[secKey] || null;

      articleMap[artNum].sections.push({
        sectionNumber: item.sectionNumber,
        sectionTitle: item.sectionTitle,
        classification: item.classification,
        votes: { approve: votes.approve, disapprove: votes.disapprove, discuss: votes.discuss },
        notes: votes.notes,
        summary,
      });
    }

    const articles = Object.values(articleMap)
      .sort((a, b) => a.articleNumber - b.articleNumber)
      .map(art => ({
        ...art,
        sections: art.sections.sort((a, b) => a.sectionNumber - b.sectionNumber),
      }));

    console.log(`[summary-get] user=${getUserSub(event)} cycle=${cycleId}`);
    return ok({ cycleId, articles });
  } catch (err) {
    console.error('[summary-get] error:', err);
    return serverError();
  }
};

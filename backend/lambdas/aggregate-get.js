'use strict';

const { QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, getUserGroups, ok, forbidden, badRequest, serverError } = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/aggregate
 * Returns aggregate vote results across all reviewers.
 * Reviewers can only see this after submitting their own ballot.
 * Admins can see it anytime.
 *
 * Group: reviewers (post-submit) or review-admins
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, ['reviewers', 'review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  const cycleId = event.pathParameters?.cycleId;
  if (!cycleId) return badRequest('cycleId is required');

  const userSub = getUserSub(event);
  const groups = getUserGroups(event);
  const isAdmin = groups.includes('review-admins');

  // Non-admins must have submitted their ballot
  if (!isAdmin) {
    const ballotResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: `BALLOT#USER#${userSub}` },
    }));
    if (ballotResult.Item?.status !== 'submitted') {
      return forbidden('You must submit your ballot before viewing aggregate results');
    }
  }

  try {
    // Get all content to build the section list
    const contentResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': 'CONTENT#',
      },
    }));

    // Get all votes for this cycle
    const voteResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': 'VOTE#',
      },
    }));

    // Aggregate votes per section
    const sectionVotes = {}; // "ART-01#SEC-01" -> { approve: N, disapprove: N, discuss: N, notes: [] }
    for (const item of (voteResult.Items || [])) {
      const match = item.SK.match(/VOTE#(ART-\d+#SEC-[\dA-Za-z]+)#USER#/);
      if (!match) continue;
      const key = match[1];
      if (!sectionVotes[key]) {
        sectionVotes[key] = { approve: 0, disapprove: 0, discuss: 0, notes: [] };
      }
      if (item.vote) sectionVotes[key][item.vote]++;
      if (item.notes) sectionVotes[key].notes.push(item.notes);
    }

    // Build article-grouped results
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
      const section = {
        sectionNumber: item.sectionNumber,
        sectionTitle: item.sectionTitle,
        classification: item.classification,
        votes: {
          approve: votes.approve,
          disapprove: votes.disapprove,
          discuss: votes.discuss,
        },
      };
      // Only admins see reviewer notes — protects reviewer anonymity
      if (isAdmin) {
        section.notes = votes.notes;
      }
      articleMap[artNum].sections.push(section);
    }

    // Sort articles and sections
    const articles = Object.values(articleMap)
      .sort((a, b) => a.articleNumber - b.articleNumber)
      .map(art => ({
        ...art,
        sections: art.sections.sort((a, b) => a.sectionNumber - b.sectionNumber),
      }));

    console.log(`[aggregate-get] user=${userSub} cycle=${cycleId}`);
    return ok({ cycleId, articles });
  } catch (err) {
    console.error('[aggregate-get] error:', err);
    return serverError();
  }
};

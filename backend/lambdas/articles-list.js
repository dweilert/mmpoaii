'use strict';

const { QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/articles
 * Returns a list of articles in the cycle with the caller's vote progress per article.
 * Group: reviewers
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

  try {
    // Get content items, user votes, and ballot status in parallel
    const [contentResult, voteResult, ballotResult] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': 'CONTENT#',
        },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK = :gsi1sk',
        ExpressionAttributeValues: {
          ':gsi1pk': `USER#${userSub}`,
          ':gsi1sk': `CYCLE#${cycleId}`,
        },
      })),
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CYCLE#${cycleId}`, SK: `BALLOT#USER#${userSub}` },
      })),
    ]);

    // Build a map of sections the user has voted on -> vote value
    const votedSections = new Map();
    for (const item of (voteResult.Items || [])) {
      // SK = VOTE#ART-01#SEC-01#USER#<sub>
      const match = item.SK.match(/VOTE#(ART-\d+#SEC-\d+)#USER#/);
      if (match) votedSections.set(match[1], item.vote || 'unknown');
    }

    // Group sections by article
    const articleMap = {};
    for (const item of (contentResult.Items || [])) {
      const artKey = `ART-${String(item.articleNumber).padStart(2, '0')}`;
      if (!articleMap[artKey]) {
        articleMap[artKey] = {
          articleNumber: item.articleNumber,
          articleTitle: item.articleTitle,
          totalSections: 0,
          votedSections: 0,
          approveCount: 0,
          disapproveCount: 0,
          discussCount: 0,
        };
      }
      articleMap[artKey].totalSections++;
      const sectionKey = `ART-${String(item.articleNumber).padStart(2, '0')}#SEC-${String(item.sectionNumber).padStart(2, '0')}`;
      const vote = votedSections.get(sectionKey);
      if (vote) {
        articleMap[artKey].votedSections++;
        if (vote === 'approve') articleMap[artKey].approveCount++;
        else if (vote === 'disapprove') articleMap[artKey].disapproveCount++;
        else if (vote === 'discuss') articleMap[artKey].discussCount++;
      }
    }

    // Convert to sorted array
    const articles = Object.values(articleMap).sort((a, b) => a.articleNumber - b.articleNumber);
    const ballotSubmitted = ballotResult.Item?.status === 'submitted';

    console.log(`[articles-list] user=${userSub} cycle=${cycleId} articles=${articles.length} ballotSubmitted=${ballotSubmitted}`);
    return ok({ cycleId, articles, ballotSubmitted });
  } catch (err) {
    console.error('[articles-list] error:', err);
    return serverError();
  }
};

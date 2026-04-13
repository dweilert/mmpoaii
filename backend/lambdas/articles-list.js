'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
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
    // Get all content items for this cycle
    const contentResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': 'CONTENT#',
      },
    }));

    // Get this user's votes for this cycle via GSI1
    const voteResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK = :gsi1sk',
      ExpressionAttributeValues: {
        ':gsi1pk': `USER#${userSub}`,
        ':gsi1sk': `CYCLE#${cycleId}`,
      },
    }));

    // Build a set of sections the user has voted on
    const votedSections = new Set();
    for (const item of (voteResult.Items || [])) {
      // SK = VOTE#ART-01#SEC-01#USER#<sub>
      const match = item.SK.match(/VOTE#(ART-\d+#SEC-\d+)#USER#/);
      if (match) votedSections.add(match[1]);
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
        };
      }
      articleMap[artKey].totalSections++;
      const sectionKey = `ART-${String(item.articleNumber).padStart(2, '0')}#SEC-${String(item.sectionNumber).padStart(2, '0')}`;
      if (votedSections.has(sectionKey)) {
        articleMap[artKey].votedSections++;
      }
    }

    // Convert to sorted array
    const articles = Object.values(articleMap).sort((a, b) => a.articleNumber - b.articleNumber);

    console.log(`[articles-list] user=${userSub} cycle=${cycleId} articles=${articles.length}`);
    return ok({ cycleId, articles });
  } catch (err) {
    console.error('[articles-list] error:', err);
    return serverError();
  }
};

'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/articles/{articleId}
 * Returns all sections in the article with the caller's saved votes/notes.
 * articleId = article number (e.g., "1", "14")
 * Group: reviewers
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, ['reviewers', 'review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  const cycleId = event.pathParameters?.cycleId;
  const articleId = event.pathParameters?.articleId;
  if (!cycleId || !articleId) return badRequest('cycleId and articleId are required');

  const artNum = String(articleId).padStart(2, '0');
  const userSub = getUserSub(event);

  try {
    // Get sections for this article
    const contentResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': `CONTENT#ART-${artNum}#`,
      },
    }));

    // Get this user's votes for this article via GSI1, then filter by article
    const voteResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK = :gsi1sk',
      ExpressionAttributeValues: {
        ':gsi1pk': `USER#${userSub}`,
        ':gsi1sk': `CYCLE#${cycleId}`,
      },
    }));
    // Filter to only votes for this article (SK starts with VOTE#ART-XX#)
    voteResult.Items = (voteResult.Items || []).filter(item =>
      item.SK && item.SK.startsWith(`VOTE#ART-${artNum}#`)
    );

    // Index votes by section
    const voteMap = {};
    for (const item of (voteResult.Items || [])) {
      const match = item.SK.match(/SEC-(\d+)#USER#/);
      if (match) {
        voteMap[parseInt(match[1], 10)] = {
          vote: item.vote,
          notes: item.notes || '',
          updatedAt: item.updatedAt,
        };
      }
    }

    // Build section list with vote data
    const sections = (contentResult.Items || [])
      .sort((a, b) => a.sectionNumber - b.sectionNumber)
      .map(item => ({
        sectionNumber: item.sectionNumber,
        sectionTitle: item.sectionTitle,
        classification: item.classification,
        whyItsHere: item.whyItsHere,
        whatYouCanDo: item.whatYouCanDo,
        communityImpact: item.communityImpact,
        myVote: voteMap[item.sectionNumber] || null,
      }));

    const articleTitle = contentResult.Items?.[0]?.articleTitle || `Article ${articleId}`;

    console.log(`[article-detail] user=${userSub} cycle=${cycleId} art=${artNum} sections=${sections.length}`);
    return ok({
      cycleId,
      articleNumber: parseInt(articleId, 10),
      articleTitle,
      sections,
    });
  } catch (err) {
    console.error('[article-detail] error:', err);
    return serverError();
  }
};

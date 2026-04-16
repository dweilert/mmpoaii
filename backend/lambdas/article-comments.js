'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/articles/{articleId}/comments
 * Returns all reviewers' votes, notes, and timestamps for every section
 * in the article. Allows reviewers to see what others think during review.
 *
 * Group: reviewers or review-admins
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
  const callerSub = getUserSub(event);

  try {
    // Query all votes for sections in this article
    const voteResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': `VOTE#ART-${artNum}#`,
      },
    }));

    // Group by section, include all reviewers (caller marked with isYou flag)
    const sectionComments = {}; // "ART-01#SEC-01" -> [{ displayName, vote, notes, updatedAt, isYou }]

    for (const item of (voteResult.Items || [])) {
      const match = item.SK.match(/VOTE#(ART-\d+#SEC-[\dA-Za-z]+)#USER#(.+)$/);
      if (!match) continue;

      const secKey = match[1];
      const userSub = match[2];

      // Only include entries that have notes or a discuss vote
      if (!item.notes && item.vote !== 'discuss') continue;

      if (!sectionComments[secKey]) sectionComments[secKey] = [];

      sectionComments[secKey].push({
        displayName: item.displayName || 'Reviewer',
        vote: item.vote || null,
        notes: item.notes || '',
        updatedAt: item.updatedAt || null,
        isYou: userSub === callerSub,
      });
    }

    // Sort each section's comments by timestamp (newest first)
    for (const key of Object.keys(sectionComments)) {
      sectionComments[key].sort((a, b) => {
        if (!a.updatedAt) return 1;
        if (!b.updatedAt) return -1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    }

    console.log(`[article-comments] user=${callerSub} cycle=${cycleId} art=${artNum} sections=${Object.keys(sectionComments).length}`);
    return ok({ cycleId, articleId: parseInt(articleId, 10), comments: sectionComments });
  } catch (err) {
    console.error('[article-comments] error:', err);
    return serverError();
  }
};

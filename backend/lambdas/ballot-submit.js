'use strict';

const { PutCommand, QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');
const { logAudit } = require('./shared/audit');

/**
 * POST /cycles/{cycleId}/submit
 * Finalize the reviewer's ballot. After submission, votes are locked and
 * aggregate results become visible to the reviewer.
 *
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
    // Check cycle is not closed
    const cycleResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
    }));
    if (!cycleResult.Item) return badRequest(`Cycle "${cycleId}" not found`);
    if (cycleResult.Item.status === 'closed') {
      return badRequest('This review cycle is closed — ballots are no longer accepted');
    }

    // Count total sections in the cycle
    const contentResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': 'CONTENT#',
      },
      Select: 'COUNT',
    }));
    const totalSections = contentResult.Count || 0;
    if (totalSections === 0) {
      return badRequest('No sections have been loaded for this cycle — contact an administrator');
    }

    // Count this user's votes via GSI1
    const voteResult = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK = :gsi1sk',
      ExpressionAttributeValues: {
        ':gsi1pk': `USER#${userSub}`,
        ':gsi1sk': `CYCLE#${cycleId}`,
      },
    }));

    // Only count votes that have a vote value and are VOTE# items (not BALLOT#)
    const votedSections = (voteResult.Items || []).filter(item =>
      item.SK && item.SK.startsWith('VOTE#') && item.vote
    ).length;

    if (votedSections < totalSections) {
      return badRequest(`You have voted on ${votedSections} of ${totalSections} sections. All sections must be voted on before submitting.`);
    }

    // Mark ballot as submitted
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CYCLE#${cycleId}`,
        SK: `BALLOT#USER#${userSub}`,
        status: 'submitted',
        submittedAt: now,
        sectionsVoted: votedSections,
        GSI1PK: `USER#${userSub}`,
        GSI1SK: `CYCLE#${cycleId}`,
      },
    }));

    console.log(`[ballot-submit] user=${userSub} cycle=${cycleId} sections=${votedSections}`);
    await logAudit('BALLOT_SUBMIT', userSub, { cycleId, sectionsVoted: votedSections });
    return ok({ submitted: true, cycleId, sectionsVoted: votedSections, submittedAt: now });
  } catch (err) {
    console.error('[ballot-submit] error:', err);
    return serverError();
  }
};

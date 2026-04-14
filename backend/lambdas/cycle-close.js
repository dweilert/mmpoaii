'use strict';

const { UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, notFound, serverError } = require('./shared/auth');
const { logAudit } = require('./shared/audit');

/**
 * PUT /cycles/{cycleId}/status
 * Open or close a review cycle. Closed cycles reject new votes.
 *
 * Body: { status: "open" | "closed" }
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { status } = body;
  if (status !== 'open' && status !== 'closed') {
    return badRequest('status must be "open" or "closed"');
  }

  const userSub = getUserSub(event);

  try {
    // Verify cycle exists
    const existing = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
    }));
    if (!existing.Item) return notFound(`Cycle "${cycleId}" not found`);

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
      UpdateExpression: 'SET #status = :status, statusUpdatedAt = :now, statusUpdatedBy = :who',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': new Date().toISOString(),
        ':who': userSub,
      },
    }));

    console.log(`[cycle-close] user=${userSub} cycle=${cycleId} status=${status}`);
    await logAudit('CYCLE_STATUS_CHANGE', userSub, { cycleId, status });
    return ok({ cycleId, status });
  } catch (err) {
    console.error('[cycle-close] error:', err);
    return serverError();
  }
};

'use strict';

const { QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, notFound, serverError } = require('./shared/auth');

/**
 * DELETE /cycles/{cycleId}
 * Permanently deletes a cycle and ALL associated data:
 *   META, CONTENT#*, DOCTEXT#*, VOTE#*, BALLOT#*, SUMMARY#*
 *
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

  const userSub = getUserSub(event);

  try {
    // Query every item in the cycle partition (paginated)
    const items = [];
    let lastKey;
    do {
      const resp = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}` },
        ProjectionExpression: 'PK, SK',
        ExclusiveStartKey: lastKey,
      }));
      items.push(...(resp.Items || []));
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    if (items.length === 0) {
      return notFound(`Cycle "${cycleId}" not found`);
    }

    // Batch delete — DynamoDB allows up to 25 per request
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map(item => ({
        DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
      }));
      await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: batch } }));
    }

    console.log(`[cycle-delete] user=${userSub} cycleId=${cycleId} deleted=${items.length} items`);
    return ok({ cycleId, deleted: items.length });

  } catch (err) {
    console.error('[cycle-delete] error:', err);
    return serverError();
  }
};

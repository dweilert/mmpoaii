'use strict';

const { QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');

async function batchWriteWithRetry(ddb, tableName, items) {
  let unprocessed = items;
  let attempts = 0;
  while (unprocessed.length > 0 && attempts < 5) {
    const result = await ddb.send(new BatchWriteCommand({
      RequestItems: { [tableName]: unprocessed },
    }));
    unprocessed = (result.UnprocessedItems && result.UnprocessedItems[tableName]) || [];
    if (unprocessed.length > 0) {
      attempts++;
      await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempts), 2000)));
    }
  }
  if (unprocessed.length > 0) {
    throw new Error(`Failed to delete ${unprocessed.length} items after retries`);
  }
}
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

    // Batch delete — DynamoDB allows up to 25 per request, with UnprocessedItems retry
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map(item => ({
        DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
      }));
      await batchWriteWithRetry(ddb, TABLE_NAME, batch);
    }

    console.log(`[cycle-delete] user=${userSub} cycleId=${cycleId} deleted=${items.length} items`);
    return ok({ cycleId, deleted: items.length });

  } catch (err) {
    console.error('[cycle-delete] error:', err);
    return serverError();
  }
};

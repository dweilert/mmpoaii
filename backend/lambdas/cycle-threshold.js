'use strict';

const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, notFound, serverError } = require('./shared/auth');

/**
 * PUT /cycles/{cycleId}/threshold
 * Set or update the minimum approval threshold for a cycle.
 *
 * Body: { threshold: N }
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

  const threshold = parseInt(body.threshold, 10);
  if (!threshold || threshold < 1 || threshold > 999) return badRequest('threshold must be between 1 and 999');

  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
      UpdateExpression: 'SET #t = :t',
      ExpressionAttributeNames: { '#t': 'threshold' },
      ExpressionAttributeValues: { ':t': threshold },
      ConditionExpression: 'attribute_exists(PK)',
    }));

    console.log(`[cycle-threshold] user=${getUserSub(event)} cycleId=${cycleId} threshold=${threshold}`);
    return ok({ cycleId, threshold });

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return notFound(`Cycle "${cycleId}" not found`);
    }
    console.error('[cycle-threshold] error:', err);
    return serverError();
  }
};

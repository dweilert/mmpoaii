'use strict';

const { PutCommand, QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, created, forbidden, badRequest, serverError } = require('./shared/auth');

/**
 * POST /cycles
 * Create a new review cycle. Optionally seed from a prior cycle (carry forward
 * only sections whose final decision was not Approved and not Removed).
 *
 * Body: { document, cycleId, title, fromCycleId? }
 * Group: review-admins
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, 'review-admins');
  } catch (e) {
    return forbidden(e.message);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { document, cycleId, title, fromCycleId } = body;
  if (!document || !cycleId || !title) {
    return badRequest('document, cycleId, and title are required');
  }

  const userSub = getUserSub(event);
  const now = new Date().toISOString();

  try {
    // Create cycle metadata
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CYCLE#${cycleId}`,
        SK: 'META',
        document,
        title,
        status: 'open',
        createdAt: now,
        createdBy: userSub,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // If fromCycleId is provided, carry forward non-approved/non-removed sections
    let carriedForward = 0;
    if (fromCycleId) {
      // Get summary decisions from prior cycle
      const summaryResult = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${fromCycleId}`,
          ':sk': 'SUMMARY#',
        },
      }));
      const decisions = {};
      for (const item of (summaryResult.Items || [])) {
        const sectionKey = item.SK.replace('SUMMARY#', '');
        decisions[sectionKey] = item.finalVote;
      }

      // Get content from prior cycle
      const contentResult = await ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${fromCycleId}`,
          ':sk': 'CONTENT#',
        },
      }));

      // Filter: carry forward only sections not approved and not removed
      const toCarry = (contentResult.Items || []).filter(item => {
        const sectionKey = item.SK.replace('CONTENT#', '');
        const decision = decisions[sectionKey];
        return decision !== 'approve' && decision !== 'remove';
      });

      // Batch write carried-forward sections into new cycle
      const batches = [];
      for (let i = 0; i < toCarry.length; i += 25) {
        const batch = toCarry.slice(i, i + 25).map(item => ({
          PutRequest: {
            Item: { ...item, PK: `CYCLE#${cycleId}` },
          },
        }));
        batches.push(batch);
      }
      for (const batch of batches) {
        await ddb.send(new BatchWriteCommand({
          RequestItems: { [TABLE_NAME]: batch },
        }));
      }
      carriedForward = toCarry.length;
    }

    console.log(`[cycle-create] user=${userSub} created cycle=${cycleId} doc=${document} carried=${carriedForward}`);
    return created({ cycleId, document, title, carriedForward });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return badRequest(`Cycle ${cycleId} already exists`);
    }
    console.error('[cycle-create] error:', err);
    return serverError();
  }
};

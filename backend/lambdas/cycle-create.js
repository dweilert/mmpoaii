'use strict';

const { PutCommand, DeleteCommand, QueryCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
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
    throw new Error(`Failed to write ${unprocessed.length} items after retries`);
  }
}
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

  const { document, cycleId, title, fromCycleId, threshold } = body;
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
        ...(threshold && threshold > 0 ? { threshold: parseInt(threshold, 10) } : {}),
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

      // Batch write carried-forward sections into new cycle with retry
      // If batch fails, compensate by deleting the META item so the cycle doesn't exist half-created
      try {
        for (let i = 0; i < toCarry.length; i += 25) {
          const batch = toCarry.slice(i, i + 25).map(item => ({
            PutRequest: {
              Item: { ...item, PK: `CYCLE#${cycleId}` },
            },
          }));
          await batchWriteWithRetry(ddb, TABLE_NAME, batch);
        }
      } catch (batchErr) {
        console.error('[cycle-create] carry-forward failed, deleting META to compensate:', batchErr);
        await ddb.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
        }));
        throw batchErr;
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

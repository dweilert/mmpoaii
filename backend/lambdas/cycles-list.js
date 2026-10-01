'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, serverError } = require('./shared/auth');

/**
 * GET /cycles
 * Returns all cycles visible to the caller.
 * Group: reviewers (or review-admins)
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, ['reviewers', 'review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  try {
    // Scan for all CYCLE#* / META items.
    // DynamoDB applies FilterExpression AFTER the 1 MB page scan, so META items
    // past the first page are silently dropped without pagination.
    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
    const items = [];
    let ExclusiveStartKey;
    do {
      const result = await ddb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pk) AND SK = :sk',
        ExpressionAttributeValues: {
          ':pk': 'CYCLE#',
          ':sk': 'META',
        },
        ExclusiveStartKey,
      }));
      if (result.Items) items.push(...result.Items);
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const cycles = items.map(item => ({
      cycleId: item.PK.replace('CYCLE#', ''),
      document: item.document,
      title: item.title,
      status: item.status,
      threshold: item.threshold || null,
      createdAt: item.createdAt,
      createdBy: item.createdBy,
    }));

    // Sort newest first
    cycles.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    console.log(`[cycles-list] user=${getUserSub(event)} returned ${cycles.length} cycles`);
    return ok({ cycles });
  } catch (err) {
    console.error('[cycles-list] error:', err);
    return serverError();
  }
};

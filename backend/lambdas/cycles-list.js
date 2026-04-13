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
    // Scan for all CYCLE#* / META items
    // With a small number of cycles, a scan is fine here.
    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'begins_with(PK, :pk) AND SK = :sk',
      ExpressionAttributeValues: {
        ':pk': 'CYCLE#',
        ':sk': 'META',
      },
    }));

    const cycles = (result.Items || []).map(item => ({
      cycleId: item.PK.replace('CYCLE#', ''),
      document: item.document,
      title: item.title,
      status: item.status,
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

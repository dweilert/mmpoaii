'use strict';

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./dynamo');

/**
 * Write an audit log entry to DynamoDB.
 *
 * Stored under PK = "AUDIT" with SK = timestamp#uuid for ordering.
 * Each entry records who did what, when, and on which resource.
 *
 * @param {string} action  — e.g. 'CYCLE_CREATE', 'VOTE_SAVE', 'CYCLE_DELETE'
 * @param {string} userSub — Cognito user sub
 * @param {object} detail  — action-specific metadata (cycleId, sectionId, etc.)
 */
async function logAudit(action, userSub, detail) {
  const now = new Date().toISOString();
  // Use timestamp + random suffix for unique, sortable SK
  const suffix = Math.random().toString(36).substring(2, 8);
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: 'AUDIT',
        SK: `${now}#${suffix}`,
        action,
        user: userSub,
        detail,
        timestamp: now,
      },
    }));
  } catch (err) {
    // Audit failures must not break the primary operation — log and continue
    console.error('[audit] failed to write audit log:', err);
  }
}

module.exports = { logAudit };

'use strict';

const { PutCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');
const { logAudit } = require('./shared/audit');

const VALID_DECISIONS = ['approve', 'disapprove', 'remove'];
const SECTION_ID_RE = /^ART-\d{1,3}#SEC-\d{1,3}$/;

/**
 * PUT /cycles/{cycleId}/summary/{sectionId}
 * Record admin's final decision for a section.
 * sectionId format: "ART-01#SEC-03"
 *
 * Body: { finalVote: "approve"|"disapprove"|"remove" }
 * Group: review-admins
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, 'review-admins');
  } catch (e) {
    return forbidden(e.message);
  }

  const cycleId = event.pathParameters?.cycleId;
  const sectionId = event.pathParameters?.sectionId;
  if (!cycleId || !sectionId) return badRequest('cycleId and sectionId are required');
  if (!SECTION_ID_RE.test(sectionId)) return badRequest('Invalid sectionId format');

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { finalVote } = body;
  if (!finalVote || !VALID_DECISIONS.includes(finalVote)) {
    return badRequest(`finalVote must be one of: ${VALID_DECISIONS.join(', ')}`);
  }

  const userSub = getUserSub(event);
  const now = new Date().toISOString();

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `CYCLE#${cycleId}`,
        SK: `SUMMARY#${sectionId}`,
        finalVote,
        decidedBy: userSub,
        decidedAt: now,
      },
    }));

    console.log(`[summary-save] user=${userSub} cycle=${cycleId} section=${sectionId} decision=${finalVote}`);
    await logAudit('SUMMARY_DECISION', userSub, { cycleId, sectionId, finalVote });
    return ok({ saved: true, sectionId, finalVote, decidedAt: now });
  } catch (err) {
    console.error('[summary-save] error:', err);
    return serverError();
  }
};

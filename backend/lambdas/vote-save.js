'use strict';

const { PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, getClaims, ok, forbidden, badRequest, serverError } = require('./shared/auth');
const { logAudit } = require('./shared/audit');

const VALID_VOTES = ['approve', 'disapprove', 'discuss'];
const SECTION_ID_RE = /^ART-\d{1,3}#SEC-[\dA-Za-z]{1,4}$/;

/**
 * PUT /cycles/{cycleId}/votes/{sectionId}
 * Autosave a reviewer's vote and/or notes for a section.
 * sectionId format: "ART-01#SEC-03"
 *
 * Body: { vote?: "approve"|"disapprove"|"discuss", notes?: "string" }
 * Group: reviewers
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, ['reviewers', 'review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  const cycleId = event.pathParameters?.cycleId;
  const sectionId = decodeURIComponent(event.pathParameters?.sectionId || '');
  if (!cycleId || !sectionId) return badRequest('cycleId and sectionId are required');
  if (!SECTION_ID_RE.test(sectionId)) return badRequest('Invalid sectionId format');

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { vote, notes } = body;
  if (vote && !VALID_VOTES.includes(vote)) {
    return badRequest(`vote must be one of: ${VALID_VOTES.join(', ')}`);
  }
  if (!vote && notes === undefined) {
    return badRequest('Provide vote and/or notes');
  }

  const userSub = getUserSub(event);

  // Check cycle status and ballot status
  try {
    const cycleResult = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
    }));
    if (!cycleResult.Item) return badRequest(`Cycle "${cycleId}" not found`);
    if (cycleResult.Item.status === 'closed') {
      return badRequest('This review cycle is closed — votes are no longer accepted');
    }
  } catch (err) {
    console.error('[vote-save] error checking cycle/ballot:', err);
    return serverError();
  }

  const now = new Date().toISOString();
  const sk = `VOTE#${sectionId}#USER#${userSub}`;

  try {
    // Upsert: set vote and/or notes
    const updateParts = ['#updatedAt = :now'];
    const names = { '#updatedAt': 'updatedAt' };
    const values = { ':now': now };

    if (vote) {
      updateParts.push('#vote = :vote');
      names['#vote'] = 'vote';
      values[':vote'] = vote;
    }
    if (notes !== undefined) {
      updateParts.push('#notes = :notes');
      names['#notes'] = 'notes';
      values[':notes'] = notes;

      // Append to comments list for discussion history
      if (notes.trim()) {
        updateParts.push('#comments = list_append(if_not_exists(#comments, :emptyList), :newComment)');
        names['#comments'] = 'comments';
        values[':emptyList'] = [];
        values[':newComment'] = [{ text: notes.trim(), at: now }];
      }
    }

    // Store display name for comment visibility
    const claims = getClaims(event);
    const displayName = claims.name || claims.given_name || claims.email || 'Reviewer';
    updateParts.push('#displayName = :displayName');
    names['#displayName'] = 'displayName';
    values[':displayName'] = displayName;

    // Also write GSI1 keys so we can query by user
    updateParts.push('GSI1PK = :gsi1pk', 'GSI1SK = :gsi1sk');
    values[':gsi1pk'] = `USER#${userSub}`;
    values[':gsi1sk'] = `CYCLE#${cycleId}`;

    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `CYCLE#${cycleId}`, SK: sk },
      UpdateExpression: 'SET ' + updateParts.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));

    console.log(`[vote-save] user=${userSub} cycle=${cycleId} section=${sectionId} vote=${vote || '(notes only)'}`);
    await logAudit('VOTE_SAVE', userSub, { cycleId, sectionId, vote: vote || null });
    return ok({ saved: true, sectionId, vote, updatedAt: now });
  } catch (err) {
    console.error('[vote-save] error:', err);
    return serverError();
  }
};

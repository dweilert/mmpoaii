'use strict';

const { PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');

const VALID_VOTES = ['approve', 'disapprove', 'discuss'];

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
    const [cycleResult, ballotResult] = await Promise.all([
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CYCLE#${cycleId}`, SK: 'META' },
      })),
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CYCLE#${cycleId}`, SK: `BALLOT#USER#${userSub}` },
      })),
    ]);
    if (!cycleResult.Item) return badRequest(`Cycle "${cycleId}" not found`);
    if (cycleResult.Item.status === 'closed') {
      return badRequest('This review cycle is closed — votes are no longer accepted');
    }
    if (ballotResult.Item?.status === 'submitted') {
      return badRequest('Ballot already submitted — votes are locked');
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
    }

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
    return ok({ saved: true, sectionId, vote, updatedAt: now });
  } catch (err) {
    console.error('[vote-save] error:', err);
    return serverError();
  }
};

'use strict';

/**
 * GET /docs/section?cycle={cycleId}&secId={ART-NN#SEC-NN}
 *
 * Returns the full text of a single section in one of the three official docs.
 * Any signed-in user.
 */

const { GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { ok, badRequest, notFound, serverError, getClaims, forbidden } = require('./shared/auth');

const ALLOWED_CYCLES = new Set([
  'Cycle-02-CCRs',
  'Cycle-02-Bylaws',
  'Cycle-02-Rules',
]);

const CYCLE_LABELS = {
  'Cycle-02-CCRs':   'CC&Rs',
  'Cycle-02-Bylaws': 'Bylaws',
  'Cycle-02-Rules':  'Rules of Conduct',
};

exports.handler = async (event) => {
  try {
    getClaims(event);
  } catch (e) {
    return forbidden('Sign-in required');
  }

  const qs = event.queryStringParameters || {};
  const cycleId = qs.cycle;
  const secId   = qs.secId;
  if (!cycleId || !secId) return badRequest('cycle and secId are required');
  if (!ALLOWED_CYCLES.has(cycleId)) return badRequest('Invalid cycle');

  // secId looks like ART-04#SEC-02
  const m = secId.match(/^ART-(\d+)#SEC-([0-9A-Za-z]+)$/);
  if (!m) return badRequest('Invalid secId format (expected ART-NN#SEC-NN)');
  const artNum = parseInt(m[1], 10);
  const secNum = m[2];

  try {
    // Content items are stored under SK like CONTENT#ART-NN#SEC-NN. Use a query to
    // be tolerant of zero-padding differences.
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `CYCLE#${cycleId}`,
        ':sk': `CONTENT#ART-${String(artNum).padStart(2, '0')}#SEC-`,
      },
    }));

    const items = result.Items || [];
    const match = items.find(it => String(it.sectionNumber) === String(parseInt(secNum, 10)));
    if (!match) return notFound('Section not found');

    return ok({
      cycle: cycleId,
      docLabel: CYCLE_LABELS[cycleId] || cycleId,
      secId,
      articleNumber: match.articleNumber,
      articleTitle:  match.articleTitle || '',
      sectionNumber: match.sectionNumber,
      sectionTitle:  match.sectionTitle || '',
      classification: match.classification || null,
      text: match.text || '',
      whyItsHere: match.whyItsHere || null,
      whatYouCanDo: match.whatYouCanDo || null,
    });
  } catch (err) {
    console.error('[docs-section] error:', err);
    return serverError(err.message);
  }
};

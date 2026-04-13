'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, notFound, serverError } = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/doctext/{sectionId}
 * Returns the original governing document text for a single section.
 * sectionId format: "ART-01#SEC-03"
 *
 * Group: reviewers
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, ['reviewers', 'review-admins']);
  } catch (e) {
    return forbidden(e.message);
  }

  const cycleId = event.pathParameters?.cycleId;
  const sectionId = event.pathParameters?.sectionId;
  if (!cycleId || !sectionId) return badRequest('cycleId and sectionId are required');

  try {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `CYCLE#${cycleId}`,
        SK: `DOCTEXT#${sectionId}`,
      },
    }));

    if (!result.Item) {
      return notFound('Document text not available for this section');
    }

    return ok({
      articleNumber: result.Item.articleNumber,
      articleTitle: result.Item.articleTitle,
      sectionNumber: result.Item.sectionNumber,
      sectionTitle: result.Item.sectionTitle,
      text: result.Item.text,
    });
  } catch (err) {
    console.error('[doctext-get] error:', err);
    return serverError();
  }
};

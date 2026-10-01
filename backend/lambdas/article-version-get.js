'use strict';

const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const {
  requireGroup,
  getUserSub,
  ok,
  forbidden,
  badRequest,
  notFound,
  serverError,
} = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/articles/{articleId}/sections/{sectionNumber}/versions/{version}
 *
 * Returns the archived snapshot of ONE section at ONE prior version
 * (field-guide copy + document text), for the reviewer diff modal.
 *
 * Response: {
 *   cycleId, articleNumber, sectionNumber, version,
 *   versionedAt, versionedBy, supersededByVersion,
 *   sectionTitle, classification, whyItsHere, whatYouCanDo, communityImpact, text
 * }
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
  const articleIdRaw = event.pathParameters?.articleId;
  const sectionRaw = event.pathParameters?.sectionNumber;
  const versionRaw = event.pathParameters?.version;
  if (!cycleId || !articleIdRaw || !sectionRaw || !versionRaw) {
    return badRequest('cycleId, articleId, sectionNumber, and version are required');
  }
  const articleNumber = parseInt(articleIdRaw, 10);
  const sectionNumber = parseInt(sectionRaw, 10);
  const version = parseInt(versionRaw, 10);
  if (![articleNumber, sectionNumber, version].every(n => Number.isInteger(n) && n >= 1 && n <= 999)) {
    return badRequest('articleId, sectionNumber, and version must be integers 1–999');
  }

  const artKey = `ART-${String(articleNumber).padStart(2, '0')}`;
  const secTag = `SEC-${String(sectionNumber).padStart(2, '0')}`;
  const vTag = `V${String(version).padStart(3, '0')}`;

  try {
    const [contentResp, doctextResp] = await Promise.all([
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CYCLE#${cycleId}`, SK: `VERSION#${artKey}#${secTag}#${vTag}` },
      })),
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CYCLE#${cycleId}`, SK: `DOCTEXTVERSION#${artKey}#${secTag}#${vTag}` },
      })),
    ]);

    const c = contentResp.Item;
    if (!c) {
      return notFound(`Version ${version} not found for article ${articleNumber} section ${sectionNumber}`);
    }
    const d = doctextResp.Item;

    console.log(
      `[article-version-get] user=${getUserSub(event)} cycle=${cycleId} ` +
      `article=${articleNumber} section=${sectionNumber} version=${version}`,
    );
    return ok({
      cycleId,
      articleNumber,
      sectionNumber,
      version,
      versionedAt: c.versionedAt,
      versionedBy: c.versionedBy,
      supersededByVersion: c.supersededByVersion,
      sectionTitle: c.sectionTitle || '',
      classification: c.classification || 'best_practice',
      whyItsHere: c.whyItsHere || '',
      whatYouCanDo: c.whatYouCanDo || '',
      communityImpact: c.communityImpact || null,
      text: (d && d.text) || '',
    });
  } catch (err) {
    console.error('[article-version-get] error:', err);
    return serverError();
  }
};

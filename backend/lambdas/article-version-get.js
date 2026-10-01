'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
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
 * GET /cycles/{cycleId}/articles/{articleNumber}/versions/{version}
 *
 * Returns the archived snapshot of CONTENT + DOCTEXT for one past version,
 * so the reviewer modal can render the old copy for diffing.
 *
 * Response: {
 *   cycleId, articleNumber, version, articleTitle,
 *   versionedAt, versionedBy, supersededByVersion,
 *   sections: [{ sectionNumber, sectionTitle, classification,
 *                whyItsHere, whatYouCanDo, communityImpact, text }]
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
  const articleNumberRaw = event.pathParameters?.articleId;
  const versionRaw = event.pathParameters?.version;
  if (!cycleId || !articleNumberRaw || !versionRaw) {
    return badRequest('cycleId, articleId, and version are required');
  }
  const articleNumber = parseInt(articleNumberRaw, 10);
  const version = parseInt(versionRaw, 10);
  if (!Number.isInteger(articleNumber) || articleNumber < 1 || articleNumber > 999) {
    return badRequest('articleNumber must be an integer 1–999');
  }
  if (!Number.isInteger(version) || version < 1 || version > 999) {
    return badRequest('version must be an integer 1–999');
  }
  const artKey = `ART-${String(articleNumber).padStart(2, '0')}`;
  const vTag = `V${String(version).padStart(3, '0')}`;

  try {
    const [contentResp, doctextResp] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': `VERSION#${artKey}#${vTag}#`,
        },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': `DOCTEXTVERSION#${artKey}#${vTag}#`,
        },
      })),
    ]);

    const content = contentResp.Items || [];
    if (content.length === 0) {
      return notFound(`Version ${version} not found for article ${articleNumber}`);
    }
    const doctext = doctextResp.Items || [];
    const doctextByNum = new Map(doctext.map(i => [i.sectionNumber, i.text || '']));

    const sections = content
      .map(c => ({
        sectionNumber: c.sectionNumber,
        sectionTitle: c.sectionTitle || '',
        classification: c.classification || 'best_practice',
        whyItsHere: c.whyItsHere || '',
        whatYouCanDo: c.whatYouCanDo || '',
        communityImpact: c.communityImpact || null,
        text: doctextByNum.get(c.sectionNumber) || '',
      }))
      .sort((a, b) => a.sectionNumber - b.sectionNumber);

    const first = content[0];
    const articleTitle = first.articleTitle;

    console.log(
      `[article-version-get] user=${getUserSub(event)} cycle=${cycleId} ` +
      `article=${articleNumber} version=${version} sections=${sections.length}`,
    );
    return ok({
      cycleId,
      articleNumber,
      version,
      articleTitle,
      versionedAt: first.versionedAt,
      versionedBy: first.versionedBy,
      supersededByVersion: first.supersededByVersion,
      sections,
    });
  } catch (err) {
    console.error('[article-version-get] error:', err);
    return serverError();
  }
};

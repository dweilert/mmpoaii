'use strict';

const { QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const {
  requireGroup,
  getUserSub,
  ok,
  forbidden,
  badRequest,
  serverError,
} = require('./shared/auth');

/**
 * GET /cycles/{cycleId}/articles/{articleNumber}/versions
 *
 * Returns the current version number and the metadata for all archived
 * (prior) versions. The current (live) version is in CONTENT#/DOCTEXT# —
 * clients already have it from article-detail.
 *
 * Response: {
 *   cycleId, articleNumber, articleTitle, currentVersion,
 *   versions: [{ version, versionedAt, versionedBy, sectionCount }]
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
  if (!cycleId || !articleNumberRaw) return badRequest('cycleId and articleId are required');
  const articleNumber = parseInt(articleNumberRaw, 10);
  if (!Number.isInteger(articleNumber) || articleNumber < 1 || articleNumber > 999) {
    return badRequest('articleNumber must be an integer 1–999');
  }
  const artKey = `ART-${String(articleNumber).padStart(2, '0')}`;

  try {
    const [metaResp, versionResp] = await Promise.all([
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `CYCLE#${cycleId}`, SK: `ARTMETA#${artKey}` },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': `VERSION#${artKey}#`,
        },
        ProjectionExpression: 'SK, version, versionedAt, versionedBy',
      })),
    ]);

    const currentVersion = metaResp.Item?.currentVersion || 1;
    const articleTitle = metaResp.Item?.articleTitle || null;

    // Group VERSION rows by version number — one entry per version
    const byVersion = new Map();
    for (const i of (versionResp.Items || [])) {
      const v = i.version;
      if (!byVersion.has(v)) {
        byVersion.set(v, {
          version: v,
          versionedAt: i.versionedAt,
          versionedBy: i.versionedBy,
          sectionCount: 0,
        });
      }
      byVersion.get(v).sectionCount++;
    }

    const versions = [...byVersion.values()].sort((a, b) => a.version - b.version);

    console.log(
      `[article-versions-list] user=${getUserSub(event)} cycle=${cycleId} ` +
      `article=${articleNumber} currentVersion=${currentVersion} archived=${versions.length}`,
    );
    return ok({ cycleId, articleNumber, articleTitle, currentVersion, versions });
  } catch (err) {
    console.error('[article-versions-list] error:', err);
    return serverError();
  }
};

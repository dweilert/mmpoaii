'use strict';

const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
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
 * GET /cycles/{cycleId}/articles/{articleId}/versions
 *
 * Per-section version history. For each section returns its current version
 * (from the live CONTENT row) and the list of archived prior versions.
 *
 * Response: {
 *   cycleId, articleNumber,
 *   sections: [
 *     { sectionNumber, currentVersion,
 *       versions: [{ version, versionedAt, versionedBy }] }
 *   ]
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
  if (!cycleId || !articleIdRaw) return badRequest('cycleId and articleId are required');
  const articleNumber = parseInt(articleIdRaw, 10);
  if (!Number.isInteger(articleNumber) || articleNumber < 1 || articleNumber > 999) {
    return badRequest('articleId must be an integer 1–999');
  }
  const artKey = `ART-${String(articleNumber).padStart(2, '0')}`;

  try {
    const [contentResp, versionResp] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': `CONTENT#${artKey}#` },
        ProjectionExpression: 'sectionNumber, version',
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': `VERSION#${artKey}#` },
        ProjectionExpression: 'SK, version, versionedAt, versionedBy, sectionNumber',
      })),
    ]);

    // Archived versions grouped by section number
    const archivedBySection = new Map();
    for (const i of (versionResp.Items || [])) {
      // SK = VERSION#ART-XX#SEC-YY#Vnnn
      const m = i.SK.match(/#SEC-(\d+)#V/);
      const secNum = m ? parseInt(m[1], 10) : i.sectionNumber;
      if (secNum == null) continue;
      if (!archivedBySection.has(secNum)) archivedBySection.set(secNum, []);
      archivedBySection.get(secNum).push({
        version: i.version,
        versionedAt: i.versionedAt,
        versionedBy: i.versionedBy,
      });
    }

    const sections = (contentResp.Items || [])
      .map(c => ({
        sectionNumber: c.sectionNumber,
        currentVersion: c.version || 1,
        versions: (archivedBySection.get(c.sectionNumber) || [])
          .sort((a, b) => a.version - b.version),
      }))
      .sort((a, b) => a.sectionNumber - b.sectionNumber);

    console.log(
      `[article-versions-list] user=${getUserSub(event)} cycle=${cycleId} ` +
      `article=${articleNumber} sections=${sections.length}`,
    );
    return ok({ cycleId, articleNumber, sections });
  } catch (err) {
    console.error('[article-versions-list] error:', err);
    return serverError();
  }
};

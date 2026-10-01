'use strict';

const {
  QueryCommand,
  BatchWriteCommand,
  UpdateCommand,
  GetCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const {
  requireGroup,
  getUserSub,
  created,
  forbidden,
  badRequest,
  notFound,
  serverError,
} = require('./shared/auth');
const { logAudit } = require('./shared/audit');

// Keep DynamoDB items well under 400 KB; doctext uses 350 KB cap
const MAX_TEXT_BYTES = 350 * 1024;

async function batchWriteWithRetry(items) {
  if (items.length === 0) return;
  let unprocessed = items;
  let attempts = 0;
  while (unprocessed.length > 0 && attempts < 5) {
    const result = await ddb.send(new BatchWriteCommand({
      RequestItems: { [TABLE_NAME]: unprocessed },
    }));
    unprocessed = (result.UnprocessedItems && result.UnprocessedItems[TABLE_NAME]) || [];
    if (unprocessed.length > 0) {
      attempts++;
      await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempts), 2000)));
    }
  }
  if (unprocessed.length > 0) {
    throw new Error(`Failed to write ${unprocessed.length} items after retries`);
  }
}

async function chunkedBatchWrite(items) {
  for (let i = 0; i < items.length; i += 25) {
    await batchWriteWithRetry(items.slice(i, i + 25));
  }
}

async function chunkedBatchDelete(keys) {
  const requests = keys.map(k => ({ DeleteRequest: { Key: k } }));
  await chunkedBatchWrite(requests);
}

/**
 * POST /cycles/{cycleId}/articles/{articleNumber}/versions
 *
 * Create a new version of an article. The CURRENT CONTENT and DOCTEXT rows
 * are snapshotted to VERSION# / DOCTEXTVERSION# with the OLD version number,
 * then overwritten in place with the new values. VOTE# rows are not touched.
 *
 * Body: {
 *   expectedCurrentVersion: 1,
 *   articleTitle: "…",
 *   sections: [
 *     { sectionNumber, sectionTitle, classification, whyItsHere,
 *       whatYouCanDo, communityImpact, text }
 *   ]
 * }
 *
 * Group: review-admins
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, 'review-admins');
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

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { expectedCurrentVersion, articleTitle, sections } = body;
  if (!Array.isArray(sections) || sections.length === 0) {
    return badRequest('sections array is required');
  }
  if (!articleTitle || typeof articleTitle !== 'string') {
    return badRequest('articleTitle is required');
  }

  const userSub = getUserSub(event);
  const now = new Date().toISOString();
  const artKey = `ART-${String(articleNumber).padStart(2, '0')}`;

  // 1. Load current CONTENT + DOCTEXT for this article
  let currentContent, currentDoctext;
  try {
    const [c, d] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': `CONTENT#${artKey}#`,
        },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: {
          ':pk': `CYCLE#${cycleId}`,
          ':sk': `DOCTEXT#${artKey}#`,
        },
      })),
    ]);
    currentContent = c.Items || [];
    currentDoctext = d.Items || [];
  } catch (err) {
    console.error('[article-version-create] load error:', err);
    return serverError();
  }

  if (currentContent.length === 0) {
    return notFound(`Article ${articleNumber} not found in cycle ${cycleId}`);
  }

  // 2. Enforce section-count lock
  const currentSectionNumbers = currentContent
    .map(i => i.sectionNumber)
    .sort((a, b) => a - b);
  const incomingSectionNumbers = sections
    .map(s => s.sectionNumber)
    .sort((a, b) => a - b);

  if (currentSectionNumbers.length !== incomingSectionNumbers.length) {
    return badRequest(
      `Section count mismatch: current=${currentSectionNumbers.length} ` +
      `incoming=${incomingSectionNumbers.length}. Section cardinality is ` +
      `locked to protect existing votes.`,
    );
  }
  for (let i = 0; i < currentSectionNumbers.length; i++) {
    if (currentSectionNumbers[i] !== incomingSectionNumbers[i]) {
      return badRequest(
        `Section numbers must match current: ` +
        `current=[${currentSectionNumbers.join(',')}] ` +
        `incoming=[${incomingSectionNumbers.join(',')}]`,
      );
    }
  }

  // 3. Determine current/next version numbers
  const artMetaKey = { PK: `CYCLE#${cycleId}`, SK: `ARTMETA#${artKey}` };
  let currentVersion;
  try {
    const meta = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: artMetaKey }));
    currentVersion = meta.Item?.currentVersion || 1;
  } catch (err) {
    console.error('[article-version-create] meta load error:', err);
    return serverError();
  }

  if (typeof expectedCurrentVersion === 'number' && expectedCurrentVersion !== currentVersion) {
    return badRequest(
      `expectedCurrentVersion=${expectedCurrentVersion} but server has ${currentVersion}. ` +
      `Someone else likely published a new version — reload and try again.`,
    );
  }

  const newVersion = currentVersion + 1;
  const archivedVersion = currentVersion;
  const vTag = `V${String(archivedVersion).padStart(3, '0')}`;

  // 4. Snapshot current rows into VERSION# / DOCTEXTVERSION#
  const snapshotPuts = [];
  for (const item of currentContent) {
    const secTag = item.SK.split('#').pop(); // SEC-XX
    snapshotPuts.push({ PutRequest: { Item: {
      ...item,
      SK: `VERSION#${artKey}#${vTag}#${secTag}`,
      version: archivedVersion,
      versionedAt: now,
      versionedBy: userSub,
      supersededByVersion: newVersion,
    }}});
  }
  for (const item of currentDoctext) {
    const secTag = item.SK.split('#').pop();
    snapshotPuts.push({ PutRequest: { Item: {
      ...item,
      SK: `DOCTEXTVERSION#${artKey}#${vTag}#${secTag}`,
      version: archivedVersion,
      versionedAt: now,
      versionedBy: userSub,
      supersededByVersion: newVersion,
    }}});
  }

  const snapshotDeleteKeys = snapshotPuts.map(p => ({ PK: p.PutRequest.Item.PK, SK: p.PutRequest.Item.SK }));

  try {
    await chunkedBatchWrite(snapshotPuts);
  } catch (err) {
    console.error('[article-version-create] snapshot failed:', err);
    return serverError('Failed to snapshot current version');
  }

  // 5. Overwrite CONTENT + DOCTEXT with new values
  const overwritePuts = [];
  const doctextByNum = new Map(currentDoctext.map(i => [i.sectionNumber, i]));
  const contentByNum = new Map(currentContent.map(i => [i.sectionNumber, i]));

  for (const s of sections) {
    const secTag = `SEC-${String(s.sectionNumber).padStart(2, '0')}`;
    const existingContent = contentByNum.get(s.sectionNumber);

    // CONTENT row (overwrite in place)
    overwritePuts.push({ PutRequest: { Item: {
      PK: `CYCLE#${cycleId}`,
      SK: `CONTENT#${artKey}#${secTag}`,
      document: existingContent?.document || 'UNKNOWN',
      articleNumber,
      articleTitle,
      sectionNumber: s.sectionNumber,
      sectionTitle: s.sectionTitle || '',
      classification: s.classification || 'best_practice',
      whyItsHere: s.whyItsHere || '',
      whatYouCanDo: s.whatYouCanDo || '',
      communityImpact: s.communityImpact || null,
      seededAt: existingContent?.seededAt || now,
      seededBy: existingContent?.seededBy || userSub,
      version: newVersion,
      updatedAt: now,
      updatedBy: userSub,
    }}});

    // DOCTEXT row (overwrite in place)
    let text = s.text || '';
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      text = Buffer.from(text, 'utf8').slice(0, MAX_TEXT_BYTES).toString('utf8');
      console.warn(`[article-version-create] truncated ${artKey}#${secTag}`);
    }
    const existingDoctext = doctextByNum.get(s.sectionNumber);
    overwritePuts.push({ PutRequest: { Item: {
      PK: `CYCLE#${cycleId}`,
      SK: `DOCTEXT#${artKey}#${secTag}`,
      articleNumber,
      articleTitle,
      sectionNumber: s.sectionNumber,
      sectionTitle: s.sectionTitle || '',
      text,
      uploadedAt: existingDoctext?.uploadedAt || now,
      uploadedBy: existingDoctext?.uploadedBy || userSub,
      version: newVersion,
      updatedAt: now,
      updatedBy: userSub,
    }}});
  }

  try {
    await chunkedBatchWrite(overwritePuts);
  } catch (err) {
    console.error('[article-version-create] overwrite failed, rolling back snapshot:', err);
    // Compensating action: delete the snapshot rows we just wrote
    try {
      await chunkedBatchDelete(snapshotDeleteKeys);
    } catch (rollbackErr) {
      console.error('[article-version-create] rollback also failed:', rollbackErr);
    }
    return serverError('Failed to apply new version — snapshot rolled back');
  }

  // 6. Bump ARTMETA.currentVersion with a conditional check
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: artMetaKey,
      UpdateExpression:
        'SET currentVersion = :new, articleTitle = :title, articleNumber = :num, ' +
        'updatedAt = :now, updatedBy = :user',
      ConditionExpression:
        'attribute_not_exists(currentVersion) OR currentVersion = :expected',
      ExpressionAttributeValues: {
        ':new': newVersion,
        ':expected': archivedVersion,
        ':title': articleTitle,
        ':num': articleNumber,
        ':now': now,
        ':user': userSub,
      },
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return badRequest('Concurrent version bump detected — reload and retry');
    }
    console.error('[article-version-create] meta update failed:', err);
    return serverError('Failed to update article metadata');
  }

  console.log(
    `[article-version-create] user=${userSub} cycle=${cycleId} ` +
    `article=${articleNumber} archived=V${archivedVersion} new=V${newVersion}`,
  );
  await logAudit('ARTICLE_VERSION_CREATE', userSub, {
    cycleId,
    articleNumber,
    archivedVersion,
    newVersion,
    sectionCount: sections.length,
  });

  return created({
    cycleId,
    articleNumber,
    archivedVersion,
    newVersion,
    sectionCount: sections.length,
  });
};

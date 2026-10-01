'use strict';

const {
  QueryCommand,
  BatchWriteCommand,
  GetCommand,
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

// Field-guide fields that are compared to decide whether a section changed
const FG_FIELDS = ['sectionTitle', 'classification', 'whyItsHere', 'whatYouCanDo', 'communityImpact'];

function vtag(n) { return `V${String(n).padStart(3, '0')}`; }

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

function norm(v) { return (v == null ? '' : String(v)); }

/**
 * POST /cycles/{cycleId}/articles/{articleId}/versions
 *
 * Publish edits to an article's sections. Versioning is PER SECTION: only the
 * sections whose field-guide copy or document text actually changed get a new
 * version. For each changed section, the CURRENT CONTENT+DOCTEXT rows are
 * snapshotted to VERSION# / DOCTEXTVERSION# under that section's current
 * version number, then overwritten in place with the new values and the
 * section's `version` attribute is incremented. Unchanged sections are left
 * completely alone. VOTE# rows are never touched.
 *
 * Section cardinality is locked (no adds/removes) so votes stay bound.
 *
 * Body: {
 *   articleTitle: "…",
 *   sections: [{ sectionNumber, sectionTitle, classification, whyItsHere,
 *                whatYouCanDo, communityImpact, text }]
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
  const articleIdRaw = event.pathParameters?.articleId;
  if (!cycleId || !articleIdRaw) return badRequest('cycleId and articleId are required');
  const articleNumber = parseInt(articleIdRaw, 10);
  if (!Number.isInteger(articleNumber) || articleNumber < 1 || articleNumber > 999) {
    return badRequest('articleId must be an integer 1–999');
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const { articleTitle, sections } = body;
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
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': `CONTENT#${artKey}#` },
      })),
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `CYCLE#${cycleId}`, ':sk': `DOCTEXT#${artKey}#` },
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
  const currentNums = currentContent.map(i => i.sectionNumber).sort((a, b) => a - b);
  const incomingNums = sections.map(s => s.sectionNumber).sort((a, b) => a - b);
  if (currentNums.length !== incomingNums.length ||
      !currentNums.every((n, i) => n === incomingNums[i])) {
    return badRequest(
      `Section set must match current [${currentNums.join(',')}]; ` +
      `got [${incomingNums.join(',')}]. Section cardinality is locked to protect votes.`,
    );
  }

  const contentByNum = new Map(currentContent.map(i => [i.sectionNumber, i]));
  const doctextByNum = new Map(currentDoctext.map(i => [i.sectionNumber, i]));

  // 3. For each submitted section, decide whether it changed
  const snapshotPuts = [];
  const overwritePuts = [];
  const metaPuts = [];
  const changedSections = [];

  for (const s of sections) {
    const num = s.sectionNumber;
    const secTag = `SEC-${String(num).padStart(2, '0')}`;
    const curContent = contentByNum.get(num);
    const curDoctext = doctextByNum.get(num);
    const curVersion = (curContent && curContent.version) || 1;

    // Determine change: any field-guide field OR the doctext differs
    let changed = false;
    for (const f of FG_FIELDS) {
      if (norm(curContent[f]) !== norm(s[f])) { changed = true; break; }
    }
    let newText = s.text || '';
    if (Buffer.byteLength(newText, 'utf8') > MAX_TEXT_BYTES) {
      newText = Buffer.from(newText, 'utf8').slice(0, MAX_TEXT_BYTES).toString('utf8');
    }
    if (!changed && norm(curDoctext ? curDoctext.text : '') !== norm(newText)) {
      changed = true;
    }
    if (!changed) continue; // leave this section untouched

    const newVersion = curVersion + 1;
    changedSections.push({ sectionNumber: num, archivedVersion: curVersion, newVersion });

    // 3a. Snapshot current CONTENT + DOCTEXT under the current version number
    snapshotPuts.push({ PutRequest: { Item: {
      ...curContent,
      SK: `VERSION#${artKey}#${secTag}#${vtag(curVersion)}`,
      version: curVersion,
      versionedAt: now,
      versionedBy: userSub,
      supersededByVersion: newVersion,
    }}});
    if (curDoctext) {
      snapshotPuts.push({ PutRequest: { Item: {
        ...curDoctext,
        SK: `DOCTEXTVERSION#${artKey}#${secTag}#${vtag(curVersion)}`,
        version: curVersion,
        versionedAt: now,
        versionedBy: userSub,
        supersededByVersion: newVersion,
      }}});
    }

    // 3b. Overwrite CONTENT + DOCTEXT in place with the new values
    overwritePuts.push({ PutRequest: { Item: {
      PK: `CYCLE#${cycleId}`,
      SK: `CONTENT#${artKey}#${secTag}`,
      document: curContent.document || 'UNKNOWN',
      articleNumber,
      articleTitle,
      sectionNumber: num,
      sectionTitle: s.sectionTitle || '',
      classification: s.classification || 'best_practice',
      whyItsHere: s.whyItsHere || '',
      whatYouCanDo: s.whatYouCanDo || '',
      communityImpact: s.communityImpact || null,
      seededAt: curContent.seededAt || now,
      seededBy: curContent.seededBy || userSub,
      version: newVersion,
      updatedAt: now,
      updatedBy: userSub,
    }}});
    overwritePuts.push({ PutRequest: { Item: {
      PK: `CYCLE#${cycleId}`,
      SK: `DOCTEXT#${artKey}#${secTag}`,
      articleNumber,
      articleTitle,
      sectionNumber: num,
      sectionTitle: s.sectionTitle || '',
      text: newText,
      uploadedAt: (curDoctext && curDoctext.uploadedAt) || now,
      uploadedBy: (curDoctext && curDoctext.uploadedBy) || userSub,
      version: newVersion,
      updatedAt: now,
      updatedBy: userSub,
    }}});
  }

  // Also apply an article-title change to unchanged sections? No — title lives on
  // every CONTENT row. If only the title changed, treat each section as changed
  // above via sectionTitle? No: articleTitle is article-wide. Update it on all rows
  // without versioning, since it is not section copy. Keep it simple: update title
  // on changed rows only (already done). If the admin changed ONLY the article
  // title, nothing is versioned — reflect the new title on all CONTENT rows.
  const titleChanged = currentContent.some(i => norm(i.articleTitle) !== norm(articleTitle));
  if (titleChanged) {
    for (const item of currentContent) {
      if (changedSections.find(cs => cs.sectionNumber === item.sectionNumber)) continue;
      overwritePuts.push({ PutRequest: { Item: { ...item, articleTitle, updatedAt: now, updatedBy: userSub } } });
    }
  }

  if (changedSections.length === 0 && !titleChanged) {
    return created({ cycleId, articleNumber, changedSections: [], message: 'No changes detected' });
  }

  // 4. Write snapshots first, then overwrites. Roll back snapshots on failure.
  try {
    await chunkedBatchWrite(snapshotPuts);
  } catch (err) {
    console.error('[article-version-create] snapshot failed:', err);
    return serverError('Failed to snapshot current versions');
  }
  try {
    await chunkedBatchWrite(overwritePuts);
  } catch (err) {
    console.error('[article-version-create] overwrite failed, rolling back snapshots:', err);
    const delKeys = snapshotPuts.map(p => ({ DeleteRequest: { Key: { PK: p.PutRequest.Item.PK, SK: p.PutRequest.Item.SK } } }));
    try { await chunkedBatchWrite(delKeys); } catch (e2) { console.error('[article-version-create] rollback failed:', e2); }
    return serverError('Failed to apply edits — snapshots rolled back');
  }

  console.log(
    `[article-version-create] user=${userSub} cycle=${cycleId} article=${articleNumber} ` +
    `versionedSections=${changedSections.map(c => c.sectionNumber).join(',') || 'none'} titleChanged=${titleChanged}`,
  );
  await logAudit('ARTICLE_VERSION_CREATE', userSub, {
    cycleId,
    articleNumber,
    changedSections,
    titleChanged,
  });

  return created({ cycleId, articleNumber, changedSections, titleChanged });
};

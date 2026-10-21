'use strict';

const { GetCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
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

const MAX_TEXT_BYTES = 350 * 1024;
const FG_FIELDS = ['sectionTitle', 'classification', 'whyItsHere', 'whatYouCanDo', 'communityImpact'];
const norm = v => (v == null ? '' : String(v));
const vtag = n => `V${String(n).padStart(3, '0')}`;

/**
 * POST /cycles/{cycleId}/articles/{articleId}/sections/{sectionNumber}/versions
 *
 * Fast single-subsection save. Loads only this section's CONTENT + DOCTEXT
 * (two GetItems), and if anything changed, snapshots the current version and
 * overwrites in place, bumping this section's version. Nothing else is read or
 * written. VOTE# rows are never touched. Section cardinality is inherently
 * preserved (this endpoint cannot add or remove sections).
 *
 * Body: { sectionTitle, classification, whyItsHere, whatYouCanDo,
 *         communityImpact, text }
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
  const articleId = event.pathParameters?.articleId;
  const sectionRaw = event.pathParameters?.sectionNumber;
  if (!cycleId || !articleId || !sectionRaw) {
    return badRequest('cycleId, articleId, and sectionNumber are required');
  }
  const articleNumber = parseInt(articleId, 10);
  const sectionNumber = parseInt(sectionRaw, 10);
  if (![articleNumber, sectionNumber].every(n => Number.isInteger(n) && n >= 1 && n <= 999)) {
    return badRequest('articleId and sectionNumber must be integers 1–999');
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const userSub = getUserSub(event);
  const now = new Date().toISOString();
  const artKey = `ART-${String(articleNumber).padStart(2, '0')}`;
  const secTag = `SEC-${String(sectionNumber).padStart(2, '0')}`;
  const pk = `CYCLE#${cycleId}`;

  // Load just this section's current CONTENT + DOCTEXT
  let curContent, curDoctext;
  try {
    const [c, d] = await Promise.all([
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: `CONTENT#${artKey}#${secTag}` } })),
      ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK: pk, SK: `DOCTEXT#${artKey}#${secTag}` } })),
    ]);
    curContent = c.Item;
    curDoctext = d.Item;
  } catch (err) {
    console.error('[section-version-create] load error:', err);
    return serverError();
  }
  if (!curContent) {
    return notFound(`Article ${articleNumber} section ${sectionNumber} not found in cycle ${cycleId}`);
  }

  const curVersion = curContent.version || 1;

  // Detect change across field-guide fields + doctext
  let changed = false;
  for (const f of FG_FIELDS) {
    if (norm(curContent[f]) !== norm(body[f])) { changed = true; break; }
  }
  let newText = body.text || '';
  if (Buffer.byteLength(newText, 'utf8') > MAX_TEXT_BYTES) {
    newText = Buffer.from(newText, 'utf8').slice(0, MAX_TEXT_BYTES).toString('utf8');
  }
  if (!changed && norm(curDoctext ? curDoctext.text : '') !== norm(newText)) {
    changed = true;
  }

  if (!changed) {
    return created({ cycleId, articleNumber, sectionNumber, changed: false });
  }

  const newVersion = curVersion + 1;

  // Snapshot current → VERSION#/DOCTEXTVERSION# at the old version
  const snapshots = [
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...curContent,
        SK: `VERSION#${artKey}#${secTag}#${vtag(curVersion)}`,
        version: curVersion,
        versionedAt: now,
        versionedBy: userSub,
        supersededByVersion: newVersion,
      },
    }),
  ];
  if (curDoctext) {
    snapshots.push(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...curDoctext,
        SK: `DOCTEXTVERSION#${artKey}#${secTag}#${vtag(curVersion)}`,
        version: curVersion,
        versionedAt: now,
        versionedBy: userSub,
        supersededByVersion: newVersion,
      },
    }));
  }
  try {
    await Promise.all(snapshots.map(c => ddb.send(c)));
  } catch (err) {
    console.error('[section-version-create] snapshot failed:', err);
    return serverError('Failed to snapshot current version');
  }

  // Overwrite CONTENT + DOCTEXT in place
  const overwrites = [
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: pk,
        SK: `CONTENT#${artKey}#${secTag}`,
        document: curContent.document || 'UNKNOWN',
        articleNumber,
        articleTitle: curContent.articleTitle,
        sectionNumber,
        sectionTitle: body.sectionTitle || '',
        classification: body.classification || 'best_practice',
        whyItsHere: body.whyItsHere || '',
        whatYouCanDo: body.whatYouCanDo || '',
        communityImpact: body.communityImpact || null,
        seededAt: curContent.seededAt || now,
        seededBy: curContent.seededBy || userSub,
        version: newVersion,
        updatedAt: now,
        updatedBy: userSub,
      },
    }),
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: pk,
        SK: `DOCTEXT#${artKey}#${secTag}`,
        articleNumber,
        articleTitle: curContent.articleTitle,
        sectionNumber,
        sectionTitle: body.sectionTitle || '',
        text: newText,
        uploadedAt: (curDoctext && curDoctext.uploadedAt) || now,
        uploadedBy: (curDoctext && curDoctext.uploadedBy) || userSub,
        version: newVersion,
        updatedAt: now,
        updatedBy: userSub,
      },
    }),
  ];
  try {
    await Promise.all(overwrites.map(c => ddb.send(c)));
  } catch (err) {
    console.error('[section-version-create] overwrite failed, rolling back snapshot:', err);
    const dels = snapshots.map(s => new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: s.input.Item.PK, SK: s.input.Item.SK } }));
    try { await Promise.all(dels.map(c => ddb.send(c))); } catch (e2) { console.error('[section-version-create] rollback failed:', e2); }
    return serverError('Failed to apply edit — snapshot rolled back');
  }

  console.log(`[section-version-create] user=${userSub} cycle=${cycleId} art=${articleNumber} sec=${sectionNumber} v${curVersion}->v${newVersion}`);
  await logAudit('SECTION_VERSION_CREATE', userSub, { cycleId, articleNumber, sectionNumber, archivedVersion: curVersion, newVersion });

  return created({ cycleId, articleNumber, sectionNumber, changed: true, archivedVersion: curVersion, newVersion });
};

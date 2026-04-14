'use strict';

const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

// DynamoDB item size limit is 400KB; stay well below with a 350KB text cap
const MAX_TEXT_BYTES = 350 * 1024;

async function batchWriteWithRetry(ddb, tableName, items) {
  let unprocessed = items;
  let attempts = 0;
  while (unprocessed.length > 0 && attempts < 5) {
    const result = await ddb.send(new BatchWriteCommand({
      RequestItems: { [tableName]: unprocessed },
    }));
    unprocessed = (result.UnprocessedItems && result.UnprocessedItems[tableName]) || [];
    if (unprocessed.length > 0) {
      attempts++;
      await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempts), 2000)));
    }
  }
  if (unprocessed.length > 0) {
    throw new Error(`Failed to write ${unprocessed.length} items after retries`);
  }
}
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, serverError } = require('./shared/auth');
const { logAudit } = require('./shared/audit');

const s3 = new S3Client({});
const SEED_BUCKET = process.env.SEED_BUCKET || 'mmpoa-review-seeds';

/**
 * POST /cycles/{cycleId}/doctext
 * Store the actual governing document text for each section so reviewers
 * can view the original text in a popup.
 *
 * Body: { s3Key: "ccrs-text.json" }  — load from S3
 *   OR: { articles: [...] }         — inline JSON
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
  if (!cycleId) return badRequest('cycleId is required');

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return badRequest('Invalid JSON body');
  }

  const userSub = getUserSub(event);
  let docData;

  try {
    if (body.s3Key) {
      const response = await s3.send(new GetObjectCommand({
        Bucket: SEED_BUCKET,
        Key: body.s3Key,
      }));
      if (response.ContentLength > 5 * 1024 * 1024) {
        return badRequest('Document text file exceeds 5MB limit');
      }
      const text = await response.Body.transformToString();
      docData = JSON.parse(text);
    } else if (body.articles) {
      docData = body;
    } else {
      return badRequest('Provide either s3Key or articles in the request body');
    }
  } catch (err) {
    if (err.name === 'NoSuchKey') return badRequest(`File not found: ${body.s3Key}`);
    console.error('[doctext-save] error loading data:', err);
    return serverError('Failed to load document text data');
  }

  try {
    const items = [];
    let truncatedCount = 0;
    const uploadedAt = new Date().toISOString();
    for (const article of (docData.articles || [])) {
      for (const section of (article.sections || [])) {
        const artNum = String(article.articleNumber).padStart(2, '0');
        const secNum = String(section.sectionNumber).padStart(2, '0');
        let text = section.text || '';
        // Truncate oversized text to stay within DynamoDB 400KB item limit
        if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
          text = Buffer.from(text, 'utf8').slice(0, MAX_TEXT_BYTES).toString('utf8');
          truncatedCount++;
          console.warn(`[doctext-save] truncated ART-${artNum}#SEC-${secNum} — exceeded ${MAX_TEXT_BYTES} bytes`);
        }
        items.push({
          PutRequest: {
            Item: {
              PK: `CYCLE#${cycleId}`,
              SK: `DOCTEXT#ART-${artNum}#SEC-${secNum}`,
              articleNumber: article.articleNumber,
              articleTitle: article.articleTitle,
              sectionNumber: section.sectionNumber,
              sectionTitle: section.sectionTitle,
              text,
              uploadedAt,
              uploadedBy: userSub,
            },
          },
        });
      }
    }

    // Batch write (25 items per batch) with UnprocessedItems retry
    let written = 0;
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await batchWriteWithRetry(ddb, TABLE_NAME, batch);
      written += batch.length;
    }

    console.log(`[doctext-save] user=${userSub} cycle=${cycleId} saved ${written} sections truncated=${truncatedCount}`);
    await logAudit('DOCTEXT_UPLOAD', userSub, { cycleId, sectionsLoaded: written, truncated: truncatedCount });
    return ok({ cycleId, sectionsLoaded: written, truncated: truncatedCount, documentSetId: docData.documentSetId || null });
  } catch (err) {
    console.error('[doctext-save] error writing:', err);
    return serverError();
  }
};

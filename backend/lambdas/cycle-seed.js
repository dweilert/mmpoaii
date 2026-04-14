'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { ddb, TABLE_NAME } = require('./shared/dynamo');
const { requireGroup, getUserSub, ok, forbidden, badRequest, notFound, serverError } = require('./shared/auth');
const { logAudit } = require('./shared/audit');

const s3 = new S3Client({});
const SEED_BUCKET = process.env.SEED_BUCKET || 'mmpoa-review-seeds';

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

/**
 * POST /cycles/{cycleId}/seed
 * Load section content from a JSON seed file in S3 (or from the request body).
 *
 * Body: { s3Key: "ccrs-2026-01.json" }   — load from S3
 *   OR: { articles: [...] }              — inline seed data
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
  let seedData;

  try {
    if (body.s3Key) {
      // Load from S3
      const response = await s3.send(new GetObjectCommand({
        Bucket: SEED_BUCKET,
        Key: body.s3Key,
      }));
      if (response.ContentLength > 5 * 1024 * 1024) {
        return badRequest('Seed file exceeds 5MB limit');
      }
      const text = await response.Body.transformToString();
      seedData = JSON.parse(text);
    } else if (body.articles) {
      // Inline seed data
      seedData = body;
    } else {
      return badRequest('Provide either s3Key or articles in the request body');
    }
  } catch (err) {
    if (err.name === 'NoSuchKey') return notFound(`Seed file not found: ${body.s3Key}`);
    console.error('[cycle-seed] error loading seed:', err);
    return serverError('Failed to load seed data');
  }

  try {
    // Transform seed articles/sections into DynamoDB items
    const items = [];
    for (const article of (seedData.articles || [])) {
      for (const section of (article.sections || [])) {
        const artNum = String(article.articleNumber).padStart(2, '0');
        const secNum = String(section.sectionNumber).padStart(2, '0');
        items.push({
          PutRequest: {
            Item: {
              PK: `CYCLE#${cycleId}`,
              SK: `CONTENT#ART-${artNum}#SEC-${secNum}`,
              document: seedData.document || 'CCRS',
              articleNumber: article.articleNumber,
              articleTitle: article.articleTitle,
              sectionNumber: section.sectionNumber,
              sectionTitle: section.sectionTitle,
              classification: section.classification,
              whyItsHere: section.whyItsHere,
              whatYouCanDo: section.whatYouCanDo,
              communityImpact: section.communityImpact || null,
              seededAt: new Date().toISOString(),
              seededBy: userSub,
            },
          },
        });
      }
    }

    // Batch write (25 items per batch — DynamoDB limit) with UnprocessedItems retry
    let written = 0;
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await batchWriteWithRetry(ddb, TABLE_NAME, batch);
      written += batch.length;
    }

    console.log(`[cycle-seed] user=${userSub} cycle=${cycleId} seeded ${written} sections`);
    await logAudit('CYCLE_SEED', userSub, { cycleId, sectionsSeeded: written, s3Key: body.s3Key || null });
    return ok({ cycleId, sectionsSeeded: written, documentSetId: seedData.documentSetId || null });
  } catch (err) {
    console.error('[cycle-seed] error writing:', err);
    return serverError();
  }
};

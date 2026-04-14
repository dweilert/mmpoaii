'use strict';

const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { requireGroup, ok, forbidden, serverError } = require('./shared/auth');

const s3 = new S3Client({});
const SEED_BUCKET = process.env.SEED_BUCKET || 'mmpoa-review-seeds';

/**
 * GET /seeds
 * Lists available seed files in the S3 bucket.
 * Groups files into matched pairs (seed + text) by name prefix.
 *
 * Group: review-admins
 */
exports.handler = async (event) => {
  try {
    requireGroup(event, 'review-admins');
  } catch (e) {
    return forbidden(e.message);
  }

  try {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: SEED_BUCKET,
    }));

    const files = (response.Contents || []).map(obj => ({
      key: obj.Key,
      size: obj.Size,
      lastModified: obj.LastModified?.toISOString(),
    }));

    // Group into matched pairs by name prefix
    // e.g. ccrs-2026-01-seed.json + ccrs-2026-01-text.json → pair "ccrs-2026-01"
    const pairMap = {};
    for (const file of files) {
      const seedMatch = file.key.match(/^(.+)-seed\.json$/);
      const textMatch = file.key.match(/^(.+)-text\.json$/);
      if (seedMatch) {
        const name = seedMatch[1];
        if (!pairMap[name]) pairMap[name] = {};
        pairMap[name].seedKey = file.key;
        pairMap[name].seedDate = file.lastModified;
      } else if (textMatch) {
        const name = textMatch[1];
        if (!pairMap[name]) pairMap[name] = {};
        pairMap[name].textKey = file.key;
        pairMap[name].textDate = file.lastModified;
      }
    }

    // Build pairs list (only include complete pairs)
    const pairs = [];
    for (const [name, pair] of Object.entries(pairMap)) {
      if (pair.seedKey && pair.textKey) {
        pairs.push({
          name,
          seedKey: pair.seedKey,
          textKey: pair.textKey,
          lastModified: pair.seedDate || pair.textDate,
        });
      }
    }

    // Sort by most recent first
    pairs.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));

    return ok({ files, pairs });
  } catch (err) {
    console.error('[seeds-list] error:', err);
    return serverError();
  }
};

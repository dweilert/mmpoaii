'use strict';

/**
 * GET /owner-report?address={address}
 *
 * Returns a pre-signed S3 URL to the most recent owner-balance PDF for the
 * caller's lot. Lot number is derived from the first 4 characters of the
 * street address (e.g., "4211 Canyonside" -> "4211").
 *
 * Files live at: s3://mmpoa-owner-reports/owner-reports/{lot}/...
 * If multiple files are in the lot's folder, returns the one with the
 * latest LastModified timestamp.
 *
 * Auth: any signed-in Cognito user (auth enforced by API Gateway).
 */

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { ok, badRequest, notFound, forbidden, serverError, getClaims } = require('./shared/auth');

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.OWNER_REPORTS_BUCKET || 'mmpoa-owner-reports';
const PREFIX_ROOT = 'owner-reports/';
const URL_TTL_SECONDS = 300; // 5 minutes — enough time to open in a new tab

const s3 = new S3Client({ region: REGION });

exports.handler = async (event) => {
  // Cognito sign-in is enforced by API Gateway authorizer; just verify claims exist.
  try {
    getClaims(event);
  } catch (e) {
    return forbidden('Sign-in required');
  }

  const qs = event.queryStringParameters || {};
  let address = qs.address;
  if (!address) return badRequest('address query parameter is required');

  // Strip surrounding quotes if present
  address = address.replace(/^"|"$/g, '').trim();

  // Lot number is the first 4 characters of the street address
  const lot = address.substring(0, 4).trim();
  if (!/^\d{4}$/.test(lot)) {
    return badRequest('Could not derive a 4-digit lot number from address');
  }

  const folderPrefix = `${PREFIX_ROOT}${lot}/`;
  console.log(`[owner-report-get] lot=${lot} prefix=${folderPrefix}`);

  try {
    // List all files for this lot
    const listResult = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: folderPrefix,
    }));

    const items = (listResult.Contents || []).filter(o => o.Key && !o.Key.endsWith('/'));
    if (items.length === 0) {
      return notFound(`No report found for lot ${lot}. Please contact the board.`);
    }

    // Sort by LastModified descending and pick the newest
    items.sort((a, b) => {
      const at = a.LastModified ? new Date(a.LastModified).getTime() : 0;
      const bt = b.LastModified ? new Date(b.LastModified).getTime() : 0;
      return bt - at;
    });
    const latest = items[0];

    console.log(`[owner-report-get] latest=${latest.Key} lastModified=${latest.LastModified}`);

    // Build a pre-signed URL the browser can fetch directly
    const filename = latest.Key.split('/').pop();
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: latest.Key,
        ResponseContentDisposition: `inline; filename="${filename}"`,
        ResponseContentType: 'application/pdf',
      }),
      { expiresIn: URL_TTL_SECONDS }
    );

    return ok({
      pdfUrl: signedUrl,
      filename,
      lastModified: latest.LastModified,
      lot,
    });
  } catch (err) {
    console.error('[owner-report-get] error:', err);
    return serverError(err.message);
  }
};

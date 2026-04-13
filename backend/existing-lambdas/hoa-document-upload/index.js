const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET         = process.env.BUCKET_NAME;
const BOARD_GROUP    = process.env.BOARD_GROUP || 'board';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://mmpoaii.org';
const ALLOWED_FOLDERS = ['minutes', 'budget'];

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Allow-Methods': 'POST,DELETE,OPTIONS'
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

function getMethod(event) {
  return event.requestContext &&
         event.requestContext.http &&
         event.requestContext.http.method;
}

function getGroups(event) {
  try {
    const claims = event.requestContext &&
                   event.requestContext.authorizer &&
                   event.requestContext.authorizer.jwt &&
                   event.requestContext.authorizer.jwt.claims;
    if (!claims) return [];
    const raw = claims['cognito:groups'] || '';
    if (Array.isArray(raw)) return raw;
    if (raw.startsWith('[')) return raw.slice(1, -1).split(' ').map(s => s.trim()).filter(Boolean);
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  } catch(e) {
    console.log('getGroups error:', e.message);
    return [];
  }
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9._\-() ]/g, '_').slice(0, 200);
}

exports.handler = async function(event) {

  const method = getMethod(event);
  console.log('Method:', method);

  if (method === 'OPTIONS') {
    return respond(200, '');
  }

  const groups = getGroups(event);
  console.log('Groups found:', groups);
  if (!groups.includes(BOARD_GROUP)) {
    return respond(403, { error: 'Board members only. Groups: ' + groups.join(',') });
  }

  if (method === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { filename, folder, contentType } = body;

      if (!filename || !folder) {
        return respond(400, { error: 'filename and folder are required' });
      }
      if (!ALLOWED_FOLDERS.includes(folder)) {
        return respond(400, { error: 'Invalid folder. Allowed: ' + ALLOWED_FOLDERS.join(', ') });
      }

      const safeKey = folder + '/' + sanitize(filename);
      const command = new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         safeKey,
        ContentType: contentType || 'application/octet-stream'
      });

      const url = await getSignedUrl(s3, command, { expiresIn: 300 });
      console.log('Pre-signed URL generated for:', safeKey);
      return respond(200, { url, key: safeKey });

    } catch(err) {
      console.error('upload-url error:', err);
      return respond(500, { error: 'Failed to generate upload URL: ' + err.message });
    }
  }

  if (method === 'DELETE') {
    try {
      const body = JSON.parse(event.body || '{}');
      const { key } = body;

      if (!key) {
        return respond(400, { error: 'key is required' });
      }

      const topFolder = key.split('/')[0];
      if (!ALLOWED_FOLDERS.includes(topFolder)) {
        return respond(400, { error: 'Invalid key path' });
      }

      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      return respond(200, { deleted: key });

    } catch(err) {
      console.error('delete error:', err);
      return respond(500, { error: 'Delete failed: ' + err.message });
    }
  }

  return respond(405, { error: 'Method not allowed: ' + method });
};

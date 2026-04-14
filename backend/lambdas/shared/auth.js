'use strict';

/**
 * Extract and verify Cognito group membership from the API Gateway event.
 * The Cognito authorizer puts decoded claims into event.requestContext.authorizer.claims.
 */

// Restrict responses to the known frontend origin. Fails closed if not configured.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
if (!ALLOWED_ORIGIN) {
  console.error('[auth] ALLOWED_ORIGIN environment variable is not set');
}

function getClaims(event) {
  const claims = event.requestContext?.authorizer?.claims;
  if (!claims) throw new Error('No auth claims found');
  return claims;
}

function getUserSub(event) {
  return getClaims(event).sub;
}

function getUserGroups(event) {
  const raw = getClaims(event)['cognito:groups'];
  if (!raw) return [];
  // Cognito sends groups as a string like "[reviewers, review-admins]" or as an array
  if (Array.isArray(raw)) return raw;
  return raw.replace(/[\[\]]/g, '').split(',').map(g => g.trim()).filter(Boolean);
}

function requireGroup(event, group) {
  const groups = getUserGroups(event);
  const allowed = Array.isArray(group) ? group : [group];
  if (!allowed.some(g => groups.includes(g))) {
    const err = new Error('Forbidden: requires group ' + allowed.join(' or '));
    err.statusCode = 403;
    throw err;
  }
}

function cors(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function ok(body)        { return cors(200, body); }
function created(body)   { return cors(201, body); }
function forbidden(msg)  { return cors(403, { error: msg || 'Forbidden' }); }
function notFound(msg)   { return cors(404, { error: msg || 'Not found' }); }
function badRequest(msg) { return cors(400, { error: msg || 'Bad request' }); }
function serverError(msg){ return cors(500, { error: msg || 'Internal server error' }); }

module.exports = {
  getClaims,
  getUserSub,
  getUserGroups,
  requireGroup,
  cors,
  ok,
  created,
  forbidden,
  notFound,
  badRequest,
  serverError,
};

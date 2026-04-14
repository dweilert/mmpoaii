// ─────────────────────────────────────────────────────────────────────────────
// REVIEW API CLIENT  —  review-api.js
// Wraps all calls to the Document Review API Gateway.
// Requires: config.js, auth.js loaded first.
// ─────────────────────────────────────────────────────────────────────────────

const ReviewApi = (function () {

  function getBaseUrl() {
    return (HOA_CONFIG.reviewApiUrl || '').replace(/\/+$/, '');
  }

  /**
   * Get the current user's ID token for API calls.
   * Returns null if not authenticated.
   */
  async function getToken() {
    const user = await HoaAuth.getCurrentUser();
    if (!user || !user.session) return null;
    return user.session.getIdToken().getJwtToken();
  }

  /**
   * Make an authenticated API call.
   */
  async function apiFetch(method, path, body) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated');

    const url = getBaseUrl() + path;
    const opts = {
      method: method,
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(url, opts);
    const data = await resp.json();

    if (!resp.ok) {
      const err = new Error(data.error || 'API error ' + resp.status);
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** GET /cycles — list all cycles */
  function listCycles() {
    return apiFetch('GET', '/cycles');
  }

  /** POST /cycles — create a new cycle */
  function createCycle(document, cycleId, title, fromCycleId, threshold) {
    return apiFetch('POST', '/cycles', { document, cycleId, title, fromCycleId, threshold });
  }

  /** PUT /cycles/{cycleId}/threshold — set approval threshold */
  function setThreshold(cycleId, threshold) {
    return apiFetch('PUT', '/cycles/' + encodeURIComponent(cycleId) + '/threshold', { threshold });
  }

  /** POST /cycles/{cycleId}/seed — seed content from S3 or inline */
  function seedCycle(cycleId, payload) {
    return apiFetch('POST', '/cycles/' + encodeURIComponent(cycleId) + '/seed', payload);
  }

  /** GET /cycles/{cycleId}/articles — article list with progress */
  function listArticles(cycleId) {
    return apiFetch('GET', '/cycles/' + encodeURIComponent(cycleId) + '/articles');
  }

  /** GET /cycles/{cycleId}/articles/{articleId} — sections with votes */
  function getArticle(cycleId, articleId) {
    return apiFetch('GET', '/cycles/' + encodeURIComponent(cycleId) + '/articles/' + encodeURIComponent(articleId));
  }

  /** PUT /cycles/{cycleId}/votes/{sectionId} — save vote/notes */
  function saveVote(cycleId, sectionId, vote, notes) {
    var body = {};
    if (vote !== undefined && vote !== null) body.vote = vote;
    if (notes !== undefined) body.notes = notes;
    return apiFetch('PUT', '/cycles/' + encodeURIComponent(cycleId) + '/votes/' + encodeURIComponent(sectionId), body);
  }

  /** POST /cycles/{cycleId}/submit — finalize ballot */
  function submitBallot(cycleId) {
    return apiFetch('POST', '/cycles/' + encodeURIComponent(cycleId) + '/submit');
  }

  /** GET /cycles/{cycleId}/aggregate — aggregate results */
  function getAggregate(cycleId) {
    return apiFetch('GET', '/cycles/' + encodeURIComponent(cycleId) + '/aggregate');
  }

  /** GET /cycles/{cycleId}/summary — admin summary view */
  function getSummary(cycleId) {
    return apiFetch('GET', '/cycles/' + encodeURIComponent(cycleId) + '/summary');
  }

  /** PUT /cycles/{cycleId}/summary/{sectionId} — admin final decision */
  function saveSummaryDecision(cycleId, sectionId, finalVote) {
    return apiFetch('PUT', '/cycles/' + encodeURIComponent(cycleId) + '/summary/' + encodeURIComponent(sectionId), { finalVote });
  }

  /** POST /cycles/{cycleId}/doctext — upload document text */
  function uploadDocText(cycleId, payload) {
    return apiFetch('POST', '/cycles/' + encodeURIComponent(cycleId) + '/doctext', payload);
  }

  /** GET /cycles/{cycleId}/doctext/{sectionId} — get section text */
  function getDocText(cycleId, sectionId) {
    // Replace # with -- to avoid URL fragment issues in API Gateway
    var safeSectionId = sectionId.replace('#', '--');
    return apiFetch('GET', '/cycles/' + encodeURIComponent(cycleId) + '/doctext/' + encodeURIComponent(safeSectionId));
  }

  /** GET /seeds — list available seed files in S3 */
  function listSeeds() {
    return apiFetch('GET', '/seeds');
  }

  /** DELETE /cycles/{cycleId} — permanently delete a cycle and all its data */
  function deleteCycle(cycleId) {
    return apiFetch('DELETE', '/cycles/' + encodeURIComponent(cycleId));
  }

  return {
    listCycles,
    createCycle,
    seedCycle,
    listArticles,
    getArticle,
    saveVote,
    submitBallot,
    getAggregate,
    getSummary,
    saveSummaryDecision,
    uploadDocText,
    getDocText,
    listSeeds,
    deleteCycle,
    setThreshold,
  };

})();

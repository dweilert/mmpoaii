// ─────────────────────────────────────────────────────────────────────────────
// HOA PAGE GUARD  —  guard.js
// Include on every protected page AFTER config.js and auth.js.
// Call HoaGuard.protect('board') or HoaGuard.protect('homeowners') at page load.
// ─────────────────────────────────────────────────────────────────────────────

const HoaGuard = (function () {

  let _currentUser = null;

  /**
   * Protect a page. Shows a loading screen until auth check completes.
   * requiredGroup: string ('board') OR array (['board','homeowners']) for pages
   * accessible to multiple roles. On success, hides spinner, shows content,
   * and populates nav. Also exposes HoaGuard.getUser().groups for role detection.
   *
   * @param {string|string[]} requiredGroup
   */
  function protect(requiredGroup) {
    // Show loading screen immediately — prevents flash of protected content
    _showLoading();

    HoaAuth.getCurrentUser().then(function (user) {

      if (!user) {
        // Not logged in
        _redirectToLogin('Please log in to access this page.');
        return;
      }

      // Support single group string or array of allowed groups
      const allowedGroups = Array.isArray(requiredGroup) ? requiredGroup : [requiredGroup];
      const matched = allowedGroups.some(function(g) {
        const groupName = HOA_CONFIG[g + 'Group'] || g;
        return user.groups.includes(groupName);
      });

      if (!matched) {
        // Logged in but wrong group
        _redirectToLogin('You do not have permission to access that area.');
        return;
      }

      // Auth passed
      _currentUser = user;
      _hideLoading();
      _populateNav(user);

    }).catch(function () {
      _redirectToLogin('Session error. Please log in again.');
    });
  }

  /**
   * Returns the current authenticated user object, or null.
   */
  function getUser() { return _currentUser; }

  /**
   * Signs the user out and redirects to /login.html.
   */
  function logout() {
    HoaAuth.signOut('/login.html');
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  function _showLoading() {
    const el = document.getElementById('guard-loading');
    if (el) el.style.display = 'flex';
    const content = document.getElementById('page-content');
    if (content) content.style.visibility = 'hidden';
  }

  function _hideLoading() {
    const el = document.getElementById('guard-loading');
    if (el) el.style.display = 'none';
    const content = document.getElementById('page-content');
    if (content) content.style.visibility = 'visible';
  }

  function _redirectToLogin(msg) {
    if (msg) sessionStorage.setItem('hoa_login_msg', msg);
    window.location.href = '/login.html';
  }

  function _populateNav(user) {
    // Set username wherever the data-user-name attribute appears
    document.querySelectorAll('[data-user-name]').forEach(function (el) {
      el.textContent = user.username;
    });
    // Set group/role label
    const isBoard = user.groups.includes(HOA_CONFIG.boardGroup || 'board');
    document.querySelectorAll('[data-user-role]').forEach(function (el) {
      el.textContent = isBoard ? 'Board Member' : 'Homeowner';
    });
    // Set HOA name wherever it appears. Inject both a full and short version
    // so CSS can swap between them responsively.
    var fullName  = HOA_CONFIG.hoaName || '';
    var shortName = HOA_CONFIG.hoaShortName || fullName;
    document.querySelectorAll('[data-hoa-name]').forEach(function (el) {
      el.innerHTML =
        '<span class="hoa-name-full">'  + fullName  + '</span>' +
        '<span class="hoa-name-short">' + shortName + '</span>';
    });
  }

  return { protect, getUser, logout };

})();

// ── Loading screen HTML (injected automatically) ─────────────────────────────
(function injectLoadingScreen() {
  const existing = document.getElementById('guard-loading');
  if (existing) return;
  const div = document.createElement('div');
  div.id = 'guard-loading';
  div.innerHTML = `
    <div style="text-align:center;color:#fff">
      <div style="width:44px;height:44px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:hoa-spin .8s linear infinite;margin:0 auto 16px"></div>
      <div style="font-size:14px;opacity:.8;font-family:sans-serif">Verifying your session…</div>
    </div>
  `;
  div.style.cssText = `
    display:flex;position:fixed;inset:0;background:#3C3489;
    align-items:center;justify-content:center;z-index:9999;
  `;
  const style = document.createElement('style');
  style.textContent = '@keyframes hoa-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  document.body.insertBefore(div, document.body.firstChild);
})();

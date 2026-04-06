// ─────────────────────────────────────────────────────────────────────────────
// HOA AUTH LIBRARY  —  auth.js
// Wraps Amazon Cognito Identity JS for use across all site pages.
// Do NOT modify unless you know what you're doing.
// ─────────────────────────────────────────────────────────────────────────────

const HoaAuth = (function () {

  // ── Internal helpers ────────────────────────────────────────────────────────

  function getUserPool() {
    if (!window.AmazonCognitoIdentity) {
      throw new Error('Cognito library not loaded. Check your internet connection.');
    }
    if (!HOA_CONFIG.userPoolId || HOA_CONFIG.userPoolId.startsWith('REPLACE_')) {
      throw new Error('Cognito is not configured. Edit js/config.js with your User Pool ID and Client ID.');
    }
    return new AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: HOA_CONFIG.userPoolId,
      ClientId:   HOA_CONFIG.clientId
    });
  }

  function getGroupsFromToken(session) {
    try {
      const payload = session.getIdToken().decodePayload();
      return payload['cognito:groups'] || [];
    } catch (e) {
      return [];
    }
  }

  function getUsernameFromToken(session) {
    try {
      const payload = session.getIdToken().decodePayload();
      return payload['preferred_username'] || payload['email'] || payload['cognito:username'] || 'User';
    } catch (e) {
      return 'User';
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Sign in with username and password.
   * callbacks: { onSuccess, onFailure, onNewPasswordRequired }
   * onSuccess receives { session, groups, username }
   */
  function signIn(username, password, callbacks) {
    let pool, cognitoUser;
    try {
      pool = getUserPool();
    } catch (err) {
      if (callbacks.onFailure) callbacks.onFailure(err.message);
      return;
    }

    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
      Username: username.trim(),
      Password: password
    });

    cognitoUser = new AmazonCognitoIdentity.CognitoUser({
      Username: username.trim(),
      Pool:     pool
    });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess: function (session) {
        const groups   = getGroupsFromToken(session);
        const uname    = getUsernameFromToken(session);
        if (callbacks.onSuccess) callbacks.onSuccess({ session, groups, username: uname, cognitoUser });
      },
      onFailure: function (err) {
        const msg = friendlyError(err);
        if (callbacks.onFailure) callbacks.onFailure(msg, err);
      },
      newPasswordRequired: function (userAttributes, requiredAttributes) {
        // First-time login — admin-created users must change password.
        // Strip ALL read-only attributes Cognito won't accept on password change.
        // Cognito throws "Cannot modify an already provided X" for any of these.
        ['email','email_verified','phone_number','phone_number_verified',
         'sub','cognito:user_status','cognito:email_alias','cognito:mfa_enabled'
        ].forEach(function(k){ delete userAttributes[k]; });
        if (callbacks.onNewPasswordRequired) {
          callbacks.onNewPasswordRequired(cognitoUser, userAttributes, requiredAttributes);
        } else {
          if (callbacks.onFailure) callbacks.onFailure('A new password is required. Please contact the administrator.');
        }
      },
      mfaRequired: function () {
        if (callbacks.onFailure) callbacks.onFailure('MFA is not configured for this application.');
      }
    });
  }

  /**
   * Complete a new-password-required challenge (first-time login).
   * userAttributes: cleaned attributes received from newPasswordRequired callback.
   */
  function completeNewPassword(cognitoUser, newPassword, userAttributes, callbacks) {
    cognitoUser.completeNewPasswordChallenge(newPassword, userAttributes || {}, {
      onSuccess: function (session) {
        const groups  = getGroupsFromToken(session);
        const uname   = getUsernameFromToken(session);
        if (callbacks.onSuccess) callbacks.onSuccess({ session, groups, username: uname, cognitoUser });
      },
      onFailure: function (err) {
        if (callbacks.onFailure) callbacks.onFailure(friendlyError(err), err);
      }
    });
  }

  /**
   * Returns a promise that resolves with { username, groups, session } or null.
   */
  function getCurrentUser() {
    return new Promise(function (resolve) {
      let pool;
      try {
        pool = getUserPool();
      } catch (e) {
        resolve(null);
        return;
      }
      const currentUser = pool.getCurrentUser();
      if (!currentUser) { resolve(null); return; }

      currentUser.getSession(function (err, session) {
        if (err || !session || !session.isValid()) { resolve(null); return; }
        resolve({
          session,
          groups:   getGroupsFromToken(session),
          username: getUsernameFromToken(session),
          cognitoUser: currentUser
        });
      });
    });
  }

  /**
   * Sign out the current user and redirect to login page.
   */
  function signOut(redirectUrl) {
    let pool;
    try { pool = getUserPool(); } catch (e) { /* ignore */ }
    if (pool) {
      const cu = pool.getCurrentUser();
      if (cu) cu.signOut();
    }
    window.location.href = redirectUrl || '/login.html';
  }

  /**
   * Send a password-reset code to the user's email.
   */
  function forgotPassword(username, callbacks) {
    let pool;
    try {
      pool = getUserPool();
    } catch (err) {
      if (callbacks.onFailure) callbacks.onFailure(err.message);
      return;
    }
    const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
      Username: username.trim(),
      Pool:     pool
    });
    cognitoUser.forgotPassword({
      onSuccess: function () { if (callbacks.onSuccess) callbacks.onSuccess(); },
      onFailure: function (err) { if (callbacks.onFailure) callbacks.onFailure(friendlyError(err)); },
      inputVerificationCode: function (data) {
        if (callbacks.onCodeSent) callbacks.onCodeSent(data);
      }
    });
  }

  /**
   * Confirm a password reset with the verification code.
   */
  function confirmForgotPassword(username, code, newPassword, callbacks) {
    let pool;
    try {
      pool = getUserPool();
    } catch (err) {
      if (callbacks.onFailure) callbacks.onFailure(err.message);
      return;
    }
    const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
      Username: username.trim(),
      Pool:     pool
    });
    cognitoUser.confirmPassword(code.trim(), newPassword, {
      onSuccess: function () { if (callbacks.onSuccess) callbacks.onSuccess(); },
      onFailure: function (err) { if (callbacks.onFailure) callbacks.onFailure(friendlyError(err)); }
    });
  }

  // ── Friendly error messages ──────────────────────────────────────────────────
  function friendlyError(err) {
    const code = err.code || err.name || '';
    const map  = {
      NotAuthorizedException:    'Incorrect username or password. Please try again.',
      UserNotFoundException:     'No account found with that username.',
      UserNotConfirmedException: 'Your account has not been confirmed. Contact the administrator.',
      PasswordResetRequiredException: 'A password reset is required. Use Forgot Password below.',
      InvalidPasswordException:  'Password does not meet requirements (min. 8 characters, upper, lower, number).',
      ExpiredCodeException:      'The verification code has expired. Please request a new one.',
      CodeMismatchException:     'Incorrect verification code. Please try again.',
      LimitExceededException:    'Too many attempts. Please wait a few minutes and try again.',
      InvalidParameterException: 'Invalid input. Please check your entries and try again.'
    };
    return map[code] || err.message || 'An unexpected error occurred. Please try again.';
  }

  return { signIn, completeNewPassword, getCurrentUser, signOut, forgotPassword, confirmForgotPassword };

})();

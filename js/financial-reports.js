// =========================================
// FINANCIAL REPORTS JS
// =========================================

/**
 * Lightweight toast notification (replaces alert()).
 * Auto-dismisses after `duration` ms. Type: 'info' | 'success' | 'error'.
 */
function showToast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText =
      'position:fixed;top:20px;right:20px;z-index:9999;display:flex;' +
      'flex-direction:column;gap:10px;max-width:360px;font-family:system-ui,sans-serif;';
    document.body.appendChild(container);
  }
  const colors = {
    info:    { bg: '#3C3489', fg: '#fff' },
    success: { bg: '#1f7a3a', fg: '#fff' },
    error:   { bg: '#b32424', fg: '#fff' }
  };
  const c = colors[type] || colors.info;
  const toast = document.createElement('div');
  toast.style.cssText =
    'background:' + c.bg + ';color:' + c.fg + ';padding:12px 16px;' +
    'border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:14px;' +
    'line-height:1.4;opacity:0;transform:translateY(-8px);transition:all .2s;';
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

/**
 * Show/hide a full-screen processing overlay with spinner.
 */
function showProcessingOverlay(message) {
  let overlay = document.getElementById('report-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'report-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(20,18,50,.55);z-index:9998;' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'font-family:system-ui,sans-serif;color:#fff;backdrop-filter:blur(2px);';
    overlay.innerHTML =
      '<div style="width:56px;height:56px;border:5px solid rgba(255,255,255,.25);' +
      'border-top-color:#fff;border-radius:50%;animation:reportSpin 1s linear infinite;"></div>' +
      '<div id="report-overlay-msg" style="margin-top:18px;font-size:15px;font-weight:500;' +
      'text-align:center;max-width:80%;"></div>';
    const style = document.createElement('style');
    style.textContent = '@keyframes reportSpin{to{transform:rotate(360deg)}}';
    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }
  overlay.querySelector('#report-overlay-msg').textContent = message || 'Processing…';
  overlay.style.display = 'flex';
}

function hideProcessingOverlay() {
  const overlay = document.getElementById('report-overlay');
  if (overlay) overlay.style.display = 'none';
}

/**
 * Set the visual state of the report button and overlay.
 */
function setReportBtnState(btn, state) {
  if (state === 'loading') {
    if (btn) { btn.style.pointerEvents = 'none'; btn.style.opacity = '.7'; }
    showProcessingOverlay('Preparing your account balance report…');
  } else {
    if (btn) { btn.style.pointerEvents = ''; btn.style.opacity = ''; }
    hideProcessingOverlay();
  }
}

/**
 * Fetch account balance report for the current user.
 * Pass `event` from the inline onclick so we can target the exact button clicked.
 */
async function fetchAccountBalanceReport(event) {
  const btn = event && event.currentTarget ? event.currentTarget : null;

  const userAddress = await getUserAddress();
  if (!userAddress) {
    showToast('Unable to retrieve your address. Please contact the board.', 'error');
    return;
  }

  const baseUrl = (typeof HOA_CONFIG !== 'undefined' && HOA_CONFIG.financialReportApiUrl) || '';
  if (!baseUrl) {
    showToast('Financial report endpoint is not configured.', 'error');
    return;
  }
  const apiUrl = baseUrl + '?address=' + encodeURIComponent(userAddress);

  setReportBtnState(btn, 'loading');
  try {
    const response = await fetch(apiUrl);

    if (!response.ok) {
      let errorMsg = 'API returned status ' + response.status;
      try {
        const data = await response.json();
        errorMsg = (data.error || errorMsg) + (data.details ? ' - ' + data.details : '');
      } catch (_) { /* non-JSON error body */ }
      showToast('Error: ' + errorMsg, 'error', 6000);
      return;
    }

    // If the backend returns the PDF directly as binary, handle it as a blob.
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/pdf') || contentType.includes('application/octet-stream')) {
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'account-balance-report.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      showToast('Report downloaded.', 'success');
      return;
    }

    const data = await response.json();

    // Prefer a pre-signed URL if the backend ever returns one (cheaper than base64).
    if (data.pdfUrl) {
      window.open(data.pdfUrl, '_blank');
      showToast('Report opened in a new tab.', 'success');
      return;
    }

    if (data.pdfBase64) {
      // Convert base64 → Blob → object URL and open in a new tab.
      const byteChars = atob(data.pdfBase64);
      const byteNums = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNums)], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const win = window.open(blobUrl, '_blank');
      if (!win) {
        showToast('Pop-up blocked. Please allow pop-ups for this site.', 'error', 6000);
      } else {
        showToast('Report opened in a new tab.', 'success');
      }
      // Revoke after a delay so the new tab has time to load it.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      return;
    }

    if (data.error) {
      showToast('Error: ' + data.error + (data.details ? ' - ' + data.details : ''), 'error', 6000);
    } else {
      showToast('No report found for your address. Please contact the board.', 'error', 6000);
    }
  } catch (error) {
    console.error('Error fetching report:', error);
    showToast('Failed to download report. Please try again or contact the board.', 'error', 6000);
  } finally {
    setReportBtnState(btn, 'idle');
  }
}

/**
 * Get user address from Cognito user attributes.
 */
async function getUserAddress() {
  try {
    const user = HoaGuard.getUser();
    if (!user || !user.cognitoUser) return null;
    return new Promise((resolve) => {
      user.cognitoUser.getUserAttributes((err, attributes) => {
        if (err) {
          console.error('Error getting attributes:', err);
          resolve(null);
          return;
        }
        const addressAttr = attributes.find(
          attr => attr.Name === 'address' || attr.Name === 'custom:address'
        );
        resolve(addressAttr ? addressAttr.Value : null);
      });
    });
  } catch (error) {
    console.error('Error getting user address:', error);
    return null;
  }
}

// =========================================
// FINANCIAL REPORTS JS
// =========================================

/**
 * Fetch account balance report for the current user
 */
async function fetchAccountBalanceReport() {
  // Get user address from Cognito
  const userAddress = await getUserAddress();
  if (!userAddress) {
    alert('Unable to retrieve your address. Please contact the board.');
    return;
  }

  // Show loading
  const btn = document.querySelector('.financial-report-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Downloading...';
  }

  const apiUrl = 'https://604iprtdt1.execute-api.us-east-1.amazonaws.com/prod/financial/account-balance?address=' + encodeURIComponent(userAddress);

  try {
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      // Try to parse error as JSON, but handle if it's not
      let errorMsg = 'API Error';
      try {
        const data = await response.json();
        errorMsg = (data.error || 'API Error') + ' - ' + (data.details || '');
      } catch (e) {
        errorMsg = 'API returned status ' + response.status + ': ' + response.statusText;
      }
      alert('Error: ' + errorMsg);
      return;
    }
    
    const data = await response.json();
    
    if (data.pdfBase64) {
      // Create download link
      const link = document.createElement('a');
      link.href = 'data:application/pdf;base64,' + data.pdfBase64;
      link.download = 'account-balance-report.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else if (data.error) {
      alert('Error: ' + data.error + ' - ' + data.details);
    } else {
      alert('No report found for your address. Please contact the board.');
    }
  } catch (error) {
    console.error('Error fetching report:', error);
    alert('Failed to download report. Please try again or contact the board.');
  } finally {
    // Reset button
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Download Report';
    }
  }
}

/**
 * Get user address from Cognito user attributes
 */
async function getUserAddress() {
  try {
    const user = HoaGuard.getUser();
    if (user && user.cognitoUser) {
      return new Promise((resolve) => {
        user.cognitoUser.getUserAttributes((err, attributes) => {
          if (err) {
            console.error('Error getting attributes:', err);
            resolve(null);
            return;
          }
          const addressAttr = attributes.find(attr => attr.Name === 'address' || attr.Name === 'custom:address');
          resolve(addressAttr ? addressAttr.Value : null);
        });
      });
    }
  } catch (error) {
    console.error('Error getting user address:', error);
  }
  return null;
}
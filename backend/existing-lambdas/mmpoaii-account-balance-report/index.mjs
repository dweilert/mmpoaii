// =========================================
// LAMBDA: Fetch Public CSV and PDF
// =========================================

import https from 'https';

// Direct download URL to your public CSV
const CSV_URL = 'https://drive.google.com/uc?export=download&id=1jXeF9akTR2RFsNKKOAzwrNOwAdt63CDC';

export const handler = async (event) => {
  console.log('Request:', JSON.stringify(event));

  try {
    // Get address from query string
    const queryParams = event.queryStringParameters || {};
    let address = queryParams.address;

    if (!address) {
      return errorResponse(400, 'Missing address', 'Address parameter required');
    }

    // Strip surrounding quotes if present
    address = address.replace(/^"|"$/g, '');

    console.log('Processing address:', address);

    // Extract first 4 characters
    const addressPrefix = address.substring(0, 4).trim();
    console.log('Looking for prefix:', addressPrefix);

    // Fetch CSV from Google Drive
    const csvContent = await fetchUrl(CSV_URL);
    console.log('CSV fetched, size:', csvContent.length);

    // Find matching report URL
    const reportUrl = findReportUrl(csvContent, addressPrefix);

    if (!reportUrl) {
      return errorResponse(404, 'Report not found',
        `No report found for address starting with "${addressPrefix}". Please contact the board.`);
    }

    // Convert any Google Drive share/view URL to a direct-download URL
    const directUrl = toDriveDownloadUrl(reportUrl);
    console.log('Found report URL:', reportUrl, '→', directUrl);

    // Download PDF
    const pdfBuffer = await fetchUrl(directUrl, true);
    console.log('PDF fetched:', pdfBuffer.length, 'bytes');

    // Convert to base64
    const base64Pdf = pdfBuffer.toString('base64');

    // Return PDF
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        pdfBase64: base64Pdf
      })
    };

  } catch (error) {
    console.error('Error:', error.message, error.stack);
    return errorResponse(500, 'Failed to retrieve report', error.message);
  }
};

// =========================================
// HELPERS
// =========================================

/**
 * Fetch content from URL (handles redirects)
 */
function fetchUrl(url, isBinary = false) {
  return new Promise((resolve, reject) => {
    const makeRequest = (currentUrl, depth = 0) => {
      if (depth > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const req = https.get(currentUrl, (res) => {
        if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
          console.log(`Redirect ${res.statusCode} to:`, res.headers.location);
          makeRequest(res.headers.location, depth + 1);
          return;
        }

        let data = isBinary ? Buffer.alloc(0) : '';

        res.on('data', (chunk) => {
          if (isBinary) {
            data = Buffer.concat([data, Buffer.from(chunk)]);
          } else {
            data += chunk.toString();
          }
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
    };

    makeRequest(url);
  });
}

/**
 * Convert a Google Drive share/view URL to a direct download URL.
 * Handles:
 *   https://drive.google.com/file/d/<ID>/view?...
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.google.com/uc?...&id=<ID>
 * Anything else is returned unchanged.
 */
function toDriveDownloadUrl(url) {
  if (!url) return url;
  let id = null;
  const m1 = url.match(/\/file\/d\/([^/]+)/);
  if (m1) id = m1[1];
  if (!id) {
    const m2 = url.match(/[?&]id=([^&]+)/);
    if (m2) id = m2[1];
  }
  if (!id) return url;
  return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
}

/**
 * Parse CSV and find matching report URL
 * CSV format: AddressPrefix,ReportURL
 */
function findReportUrl(csvContent, addressPrefix) {
  const lines = csvContent.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue;

    const parts = line.split(',');

    if (parts.length < 2) continue;

    const csvPrefix = parts[0].trim();
    const csvUrl = parts.slice(1).join(',').trim();

    console.log(`Comparing "${addressPrefix}" with "${csvPrefix}"`);

    if (csvPrefix.toLowerCase() === addressPrefix.toLowerCase()) {
      console.log('Match found!');
      return csvUrl;
    }
  }

  console.warn('No match found');
  return null;
}

/**
 * Format error response
 */
function errorResponse(statusCode, error, details) {
  return {
    statusCode,
    body: JSON.stringify({
      error,
      details,
      timestamp: new Date().toISOString()
    }),
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  };
}

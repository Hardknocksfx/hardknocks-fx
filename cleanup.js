const https = require('https');

const JSONBIN_BIN_ID = '6ad059c5ac6210605a32ac57';
const JSONBIN_MASTER_KEY = '$2a$10$wX9BjVvXpOGI9Tr8NfKGze8BEzE4.dwvRIA7PLVcIHOvnTjGBqxg.';

function callJsonBin(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}${path}`;
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_MASTER_KEY
      }
    };

    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', err => reject(err));
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function cleanDuplicates() {
  try {
    console.log('Fetching current signals from JSONBin...');
    const currentData = await callJsonBin('GET', '/latest');
    const record = currentData.record || currentData;
    let signals = record.signals || [];

    if (!Array.isArray(signals)) {
      console.log('No signals array found.');
      return;
    }

    console.log(`Total signals before cleanup: ${signals.length}`);

    // Filter out duplicates (keeping unique entries based on side and rounded entry price)
    const seen = new Set();
    const uniqueSignals = signals.filter(s => {
      // Create a unique key combining side and entry price (rounded to 1 decimal place)
      const key = `${s.side}-${Number(s.entry).toFixed(1)}`;
      if (seen.has(key)) {
        return false; // Duplicate found, filter it out
      }
      seen.add(key);
      return true;
    });

    console.log(`Total unique signals after cleanup: ${uniqueSignals.length}`);

    // Push clean array back to JSONBin
    await callJsonBin('PUT', '', { signals: uniqueSignals });
    console.log('Successfully cleaned and updated JSONBin with unique signals only!');

  } catch (err) {
    console.error('Error cleaning duplicates:', err);
  }
}

cleanDuplicates();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchToFile(url, filePath, { retries = 3, backoffMs = 800, headers = {} } = {}) {
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const tmp = `${filePath}.part`;
    const file = fs.createWriteStream(tmp);
    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        file.close();
        fs.unlinkSync(tmp);
        resolve(fetchToFile(res.headers.location, filePath, { retries, backoffMs, headers }));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(tmp, () => {});
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          fs.rename(tmp, filePath, (err) => {
            if (err) reject(err); else resolve(filePath);
          });
        });
      });
    });
    req.on('error', async (err) => {
      file.close();
      fs.unlink(tmp, () => {});
      if (retries > 0) {
        await sleep(backoffMs);
        resolve(fetchToFile(url, filePath, { retries: retries - 1, backoffMs: backoffMs * 1.7, headers }));
      } else {
        reject(err);
      }
    });
  });
}

module.exports = { fetchToFile, sleep };


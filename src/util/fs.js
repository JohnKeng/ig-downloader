const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readLinesUnique(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const set = new Set();
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    set.add(trimmed);
  });
  return Array.from(set);
}

function extractUsername(input) {
  let s = String(input).trim();
  if (!s) return null;
  // strip comments leftover
  if (s.startsWith('#')) return null;
  // remove leading @
  if (s.startsWith('@')) s = s.replace(/^@+/, '');

  const RESERVED = new Set(['p', 'reel', 'tv', 'explore', 'accounts', 'about', 'privacy', 'legal', 'developer']);

  // URL case
  if (/^(https?:)?\/\//i.test(s) || /^instagram\.com\//i.test(s) || /^www\.instagram\.com\//i.test(s)) {
    try {
      const url = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
      const host = url.hostname.replace(/^www\./, '');
      if (!/instagram\.com$/i.test(host)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 0) return null;
      const first = parts[0];
      if (RESERVED.has(first.toLowerCase())) return null;
      const cleaned = first.replace(/[^a-zA-Z0-9._]/g, '').slice(0, 50);
      return cleaned || null;
    } catch (_) {
      return null;
    }
  }

  // plain username
  const cleaned = s.replace(/[^a-zA-Z0-9._]/g, '').slice(0, 50);
  return cleaned || null;
}

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

module.exports = { ensureDir, readLinesUnique, extractUsername, writeIfMissing };

#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { defaults } = require('./config');
const log = require('./util/log');
const { ensureDir, readLinesUnique, extractUsername, writeIfMissing } = require('./util/fs');
const { Cache } = require('./store/cache');
const logPath = require('path');

function parseArgs(argv) {
  const args = { ...defaults };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case '--input':
        if (next) { args.input = next; i++; }
        break;
      case '--out':
        if (next) { args.out = next; i++; }
        break;
      case '--mode':
        if (next) { args.mode = next; i++; }
        break;
      case '--concurrency':
        if (next) { args.concurrency = Number(next) || defaults.concurrency; i++; }
        break;
      case '--max-per-user':
        if (next) { args.maxPerUser = Number(next) || 0; i++; }
        break;
      case '--delay':
        if (next) { args.delay = next; i++; }
        break;
      default:
        // ignore unknown for now
        break;
    }
  }
  return args;
}

function summarize(usernames) {
  const counts = {
    total: usernames.length,
    empty: usernames.length === 0,
  };
  return counts;
}

function main() {
  const cwd = process.cwd();
  const args = parseArgs(process.argv);

  const inputPath = path.isAbsolute(args.input) ? args.input : path.join(cwd, args.input);
  const outRoot = path.isAbsolute(args.out) ? args.out : path.join(cwd, args.out);

  // Load IG_SESSIONID from local file if present
  try {
    const cookieFile = path.join(cwd, 'IG_SESSIONID.txt');
    if (fs.existsSync(cookieFile)) {
      const raw = fs.readFileSync(cookieFile, 'utf8');
      const match = raw.match(/sessionid=([^;\s\n]+)/i);
      const value = match ? match[1] : (raw.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '').trim();
      if (value && value.length >= 20) {
        process.env.IG_SESSIONID = value;
        log.info('已從 IG_SESSIONID.txt 載入 Cookie。');
      }
    }
  } catch (e) {
    log.warn('讀取 IG_SESSIONID.txt 失敗：' + e.message);
  }

  log.info(`Input file: ${inputPath}`);
  log.info(`Output root: ${outRoot}`);

  const rawLines = readLinesUnique(inputPath);
  const usernames = [];
  const ignored = [];
  for (const line of rawLines) {
    const u = extractUsername(line);
    if (u) usernames.push(u); else ignored.push(line);
  }

  const { total, empty } = summarize(usernames);
  if (empty) {
    log.warn('ig.txt 為空或不存在。請在 ig.txt 每行放一個 IG 帳號（可含 @ 或完整網址）。');
    process.exit(0);
  }

  ensureDir(outRoot);

  let created = 0;
  for (const user of usernames) {
    const userDir = path.join(outRoot, user);
    if (!fs.existsSync(userDir)) {
      ensureDir(userDir);
      created++;
    }
    // prepare cache + manifest
    writeIfMissing(path.join(userDir, '.downloaded.json'), '{}');
    writeIfMissing(path.join(userDir, 'manifest.jsonl'), '');
  }

  log.info(`讀到帳號 ${total} 個，建立或確認資料夾完成：${created}/${total}`);
  if (ignored.length) {
    log.warn(`有 ${ignored.length} 行無法識別為帳號網址或名稱，已忽略。`);
  }

  // Run mode if provided
  if (args.mode === 'headless') {
    (async () => {
      let pw;
      try {
        pw = require('./modes/headless');
      } catch (e) {
        log.warn('Headless 模式模組載入失敗：' + e.message);
        return;
      }
      const [min, max] = String(args.delay).split('-').map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n));
      const delayRange = [min || 1200, max || 2500];

      // 簡易併發控制
      const limit = Math.max(1, Number(args.concurrency) || 1);
      let active = 0, idx = 0;
      const results = [];

      await new Promise((resolve) => {
        const next = () => {
          if (idx >= usernames.length && active === 0) return resolve();
          while (active < limit && idx < usernames.length) {
            const user = usernames[idx++];
            active++;
            (async () => {
              const userDir = path.join(outRoot, user);
              const cachePath = path.join(userDir, '.downloaded.json');
              const manifestPath = path.join(userDir, 'manifest.jsonl');
              const cache = new Cache(cachePath);
              try {
                const { downloaded } = await pw.runForUser({
                  username: user,
                  outDir: userDir,
                  maxPerUser: args.maxPerUser,
                  delayRange,
                  cookieFromEnv: process.env.IG_SESSIONID ? 'IG_SESSIONID' : undefined,
                  cookieValue: process.env.IG_SESSIONID || undefined,
                  cache,
                  manifestPath,
                });
                cache.save();
                results.push({ user, downloaded });
                log.info(`${user} 完成下載 ${downloaded} 張`);
              } catch (e) {
                log.error(`${user} 處理失敗：${e.message}`);
              } finally {
                active--;
                next();
              }
            })();
          }
        };
        next();
      });

      const totalDownloaded = results.reduce((s, r) => s + (r.downloaded || 0), 0);
      log.info(`全部帳號完成，總下載：${totalDownloaded} 張`);
    })();
  } else if (args.mode === 'http') {
    log.warn('純 HTTP 模式容易失敗且不穩定，目前僅提供 headless 模式。');
  } else {
    log.info('目前為準備階段（僅建立資料夾）。可加上 --mode headless 啟動抓取。');
  }
}

if (require.main === module) {
  main();
}

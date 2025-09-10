const path = require('path');
const fs = require('fs');
const log = require('../util/log');
const { fetchToFile, sleep } = require('../util/http');

async function ensurePlaywright() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const pw = require('playwright');
    return pw;
  } catch (e) {
    throw new Error('找不到 playwright。請先執行：npx playwright install chromium');
  }
}

async function dismissPopups(page) {
  // 嘗試關閉 cookie 與登入彈窗，容錯即可
  const candidates = [
    'button:has-text("Only allow essential cookies")',
    'button:has-text("Allow all cookies")',
    'button:has-text("允許必要")',
    'button:has-text("接受所有")',
    'button:has-text("Not Now")',
    'button:has-text("稍後再說")',
    'div[role="dialog"] button:has-text("Not now")',
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 500 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch (_) {}
  }
}

function highestFromSrcset(srcset) {
  try {
    const items = srcset.split(',').map(s => s.trim());
    const last = items[items.length - 1];
    return last.split(' ')[0];
  } catch {
    return null;
  }
}

function shortcodeFromUrl(u) {
  const m = u.match(/\/p\/([\w-]+)\//) || u.match(/\/reel\/([\w-]+)\//) || u.match(/\/tv\/([\w-]+)\//);
  return m ? m[1] : null;
}

async function getPostImageUrls(page) {
  // 在貼文視圖（overlay 或單頁）盡量擷取最高畫質圖片 URL
  const urls = await page.evaluate(() => {
    const parseSrcset = (ss) => {
      const out = [];
      (ss || '').split(',').map(s => s.trim()).forEach(part => {
        const [u, w] = part.split(' ');
        const n = parseInt((w || '0').replace(/[^0-9]/g, ''), 10) || 0;
        if (u) out.push({ url: u, w: n });
      });
      return out.sort((a,b)=>b.w-a.w);
    };
    const isCdn = (u) => /(cdninstagram|instagram\.f|fbcdn)/.test(u);
    const tooSmallPath = (u) => /\/(s\d+x\d+|\d+x\d+)\//.test(u) || /sprite|favicon|static|stories/.test(u);
    const scope = document.querySelector('div[role="dialog"]') || document;
    const imgs = Array.from(scope.querySelectorAll('article img'));
    const chosen = [];
    for (const img of imgs) {
      // 跳過頭像/標誌等
      const alt = (img.getAttribute('alt') || '').toLowerCase();
      if (/profile picture|頭像|avatar/.test(alt)) continue;
      if (img.closest('header')) continue;

      let url = null;
      let width = 0;
      const ss = img.getAttribute('srcset');
      if (ss) {
        const arr = parseSrcset(ss);
        if (arr.length) { url = arr[0].url; width = arr[0].w; }
      } else {
        url = img.getAttribute('src') || '';
        width = img.naturalWidth || 0;
      }
      if (!url) continue;
      if (!isCdn(url)) continue;
      if (tooSmallPath(url)) continue;
      if (width && width < 640) continue; // 只要較大圖
      chosen.push(url);
    }
    return Array.from(new Set(chosen));
  });
  return urls;
}

async function collectPostLinks(page, maxCount = 50) {
  const deadline = Date.now() + 20000; // up to 20s
  const pull = async () => {
    const hrefs = await page.$$eval('a', as => as.map(a => a.getAttribute('href') || ''));
    const filtered = hrefs.filter(h => /\/p\//.test(h));
    const abs = filtered.map(h => {
      try { return new URL(h, location.origin).toString(); } catch { return null; }
    }).filter(Boolean);
    return Array.from(new Set(abs));
  };
  let links = await pull();
  while (links.length < maxCount && Date.now() < deadline) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
    const cur = await pull();
    const set = new Set([ ...links, ...cur ]);
    links = Array.from(set);
  }
  return links.slice(0, maxCount);
}

async function collectImagesFromPost(page) {
  // 於單篇貼文視圖內，完整蒐集 carousel 的所有圖片
  const urls = new Set();
  for (let i = 0; i < 15; i++) {
    const found = await getPostImageUrls(page);
    for (const u of found) urls.add(u);
    // 嘗試 carousel 下一張（僅限於文章內部）
    const nextSelectors = [
      'div[role="dialog"] article button[aria-label="Next"]',
      'article button[aria-label="Next"]',
    ];
    let clicked = false;
    for (const sel of nextSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click().catch(() => {}); clicked = true; break; }
    }
    if (!clicked) break;
    await page.waitForTimeout(700);
  }
  return Array.from(urls);
}

async function runForUser({ username, outDir, maxPerUser = 0, delayRange = [1200, 2500], cookieFromEnv, cookieValue, cache, manifestPath }) {
  const { chromium } = await ensurePlaywright();
  const headless = String(process.env.HEADFUL || '') ? false : true;
  const slowMo = Number(process.env.SLOWMO || 0) || 0;
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
  });
  if (cookieFromEnv) {
    const cVal = cookieValue || process.env[cookieFromEnv];
    if (cVal) {
      await context.addCookies([{ name: 'sessionid', value: cVal, domain: '.instagram.com', path: '/', httpOnly: true, secure: true }]);
      log.info(`已加入 cookie ${cookieFromEnv} 用於 ${username}`);
    }
  }
  try {
    await context.addCookies([{ name: 'ig_nrcb', value: '1', domain: '.instagram.com', path: '/', httpOnly: false, secure: true }]);
  } catch (_) {}
  const page = await context.newPage();
  try {
    await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    await dismissPopups(page);
    // 嘗試等待網格連結出現（不因暫時出不來就判私密）
    await page.waitForSelector('a[href^="/p/"]', { timeout: 8000 }).catch(() => {});
    // 更精準的私密/不存在偵測
    const unavailable = await page.evaluate(() => {
      const texts = Array.from(document.querySelectorAll('h1, h2, h3, div, span, section'))
        .map(el => (el.textContent || '').trim())
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      const patterns = [
        'this account is private',
        "sorry, this page isn't available",
        'page not found',
        '此帳號為私人',
        '找不到頁面',
        '該頁面無法使用',
      ];
      return patterns.some(p => texts.includes(p));
    });
    if (unavailable) {
      log.warn(`${username} 可能為私密或不存在，略過。`);
      return { downloaded: 0 };
    }
    const targetCount = maxPerUser && maxPerUser > 0 ? maxPerUser : 80; // 初始抓 80 筆連結
    let postLinks = await collectPostLinks(page, targetCount);
    if (postLinks.length === 0) {
      // 後備方案：用 Web API 抓取使用者前幾個貼文
      const apiItems = await fetchViaWebAPI(page, username, targetCount, cookieValue).catch(() => []);
      if (apiItems && apiItems.length) {
        log.info(`${username} 以 API 後備取得 ${apiItems.length} 筆媒體`);
        // 直接下載這批，不再逐一開貼文頁
        let downloaded = 0;
        for (const item of apiItems) {
          const sc = item.shortcode || String(Date.now());
          const tsBase = (item.taken_at_timestamp ? item.taken_at_timestamp * 1000 : Date.now());
          let idx = 0;
          for (const imgUrl of item.images) {
            if (maxPerUser && downloaded >= maxPerUser) break;
            const ext = path.extname(new URL(imgUrl).pathname) || '.jpg';
            const fname = `${tsBase}_${sc}_${String(idx).padStart(2, '0')}${ext.split('?')[0]}`;
            const outPath = path.join(outDir, fname);
            const cacheKey = `${sc}|${imgUrl}`;
            if (cache && cache.has(cacheKey)) { idx++; continue; }
            try {
              await fetchToFile(imgUrl, outPath);
              downloaded++;
              idx++;
              if (manifestPath) {
                const record = { username, shortcode: sc, postUrl: `https://www.instagram.com/p/${sc}/`, imageUrl: imgUrl, filename: fname, downloadedAt: new Date().toISOString(), postTime: item.taken_at_timestamp ? new Date(tsBase).toISOString() : null };
                fs.appendFileSync(manifestPath, JSON.stringify(record) + '\n');
              }
              if (cache) cache.add(cacheKey);
            } catch (e) {
              log.warn(`下載失敗 ${imgUrl}: ${e.message}`);
            }
            await sleep(Math.floor(delayRange[0] + Math.random() * (delayRange[1] - delayRange[0])));
          }
        }
        return { downloaded };
      }
      // 再次後備：直接點開網格第一張，於貼文 overlay 逐一抓圖並切換下一篇
      try {
        const openSel = 'main article a:has(img), a[href*="/p/"]:has(img), a[href*="/reel/"]:has(img), a[href*="/tv/"]:has(img)';
        const first = page.locator(openSel).first();
        await first.click({ timeout: 5000 });
        await page.waitForTimeout(800);
        // 確認已進入貼文（URL 或對話框）
        const inPost = await Promise.race([
          page.waitForSelector('div[role="dialog"] article', { timeout: 3000 }).then(() => true).catch(() => false),
          page.waitForURL(/\/(p|reel|tv)\//, { timeout: 3000 }).then(() => true).catch(() => false),
        ]);
        if (inPost) {
          const pickDelay = () => Math.floor(delayRange[0] + Math.random() * (delayRange[1] - delayRange[0]));
          let downloaded = 0;
          let postsVisited = 0;
          let prevSc = null;
          while (!maxPerUser || downloaded < maxPerUser) {
            const curUrl = page.url();
            const sc = shortcodeFromUrl(curUrl) || prevSc || String(Date.now());
            // 先等 article 出現再抓
            await page.waitForSelector('div[role="dialog"] article, main article', { timeout: 5000 }).catch(() => {});
            const imgUrls = await collectImagesFromPost(page);
            let idx = 0;
            for (const imgUrl of imgUrls) {
              if (maxPerUser && downloaded >= maxPerUser) break;
              const ext = path.extname(new URL(imgUrl).pathname) || '.jpg';
              const ts = Date.now();
              const fname = `${ts}_${sc}_${String(idx).padStart(2, '0')}${ext.split('?')[0]}`;
              const outPath = path.join(outDir, fname);
              const cacheKey = `${sc}|${imgUrl}`;
              if (cache && cache.has(cacheKey)) { idx++; continue; }
              try {
                await fetchToFile(imgUrl, outPath);
                downloaded++;
                idx++;
                log.info(`下載 ${username}: ${fname}`);
                if (manifestPath) {
                  const record = { username, shortcode: sc, postUrl: curUrl, imageUrl: imgUrl, filename: fname, downloadedAt: new Date().toISOString(), postTime: null };
                  fs.appendFileSync(manifestPath, JSON.stringify(record) + '\n');
                }
                if (cache) cache.add(cacheKey);
              } catch (e) { log.warn(`下載失敗 ${imgUrl}: ${e.message}`); }
              await sleep(pickDelay());
            }
            postsVisited++;
            prevSc = sc;
            if (maxPerUser && downloaded >= maxPerUser) break;
            // 嘗試切到下一篇貼文（先確保當前 carousel 已經到頭）
            // 先嘗試 overlay 下一篇
            const prevHref = page.url();
            let moved = false;
            try { await page.keyboard.press('ArrowRight'); } catch {}
            moved = await page.waitForFunction(ph => location.href !== ph, prevHref, { timeout: 1200 }).then(() => true).catch(() => false);
            if (!moved) {
              // 嘗試點擊 overlay 的下一篇箭頭（避免點中 carousel 的下一張）
              const overlayNextCandidates = [
                'div[role="dialog"] a[role="link"]:has(svg[aria-label="Next post"])',
                'div[role="dialog"] button:has(svg[aria-label="Next post"])',
                'div[role="dialog"] a[role="link"]:has(svg[aria-label="Next"])',
                'div[role="dialog"] button:has(svg[aria-label="Next"])',
              ];
              for (const sel of overlayNextCandidates) {
                const el = await page.$(sel);
                if (el) { await el.click().catch(() => {}); break; }
              }
              moved = await page.waitForFunction(ph => location.href !== ph, prevHref, { timeout: 1200 }).then(() => true).catch(() => false);
            }
            if (!moved) break; // 到底了
            await sleep(pickDelay());
          }
          return { downloaded };
        }
      } catch (_) { /* ignore */ }
      // 若仍為 0，輸出偵錯檔案
      try {
        const png = path.join(outDir, `debug_${username}.png`);
        const html = path.join(outDir, `debug_${username}.html`);
        await page.screenshot({ path: png, fullPage: true });
        const content = await page.content();
        fs.writeFileSync(html, content);
        log.warn(`${username} 無法取得貼文；已輸出偵錯檔案：${png}, ${html}`);
      } catch (_) {}
    }
    log.info(`${username} 擷取到貼文連結 ${postLinks.length} 筆`);

    const pickDelay = () => Math.floor(delayRange[0] + Math.random() * (delayRange[1] - delayRange[0]));
    let downloaded = 0;
    for (const link of postLinks) {
      if (maxPerUser && downloaded >= maxPerUser) break;
      await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1000);
      await dismissPopups(page);
      const imgUrls = await collectImagesFromPost(page);
      const sc = shortcodeFromUrl(link) || String(Date.now());
      // 擷取時間
      let isoTime = null;
      try { isoTime = await page.getAttribute('time', 'datetime'); } catch (_) {}
      let idx = 0;
      for (const imgUrl of imgUrls) {
        if (maxPerUser && downloaded >= maxPerUser) break;
        const ext = path.extname(new URL(imgUrl).pathname) || '.jpg';
        const ts = Date.now();
        const fname = `${ts}_${sc}_${String(idx).padStart(2, '0')}${ext.split('?')[0]}`;
        const outPath = path.join(outDir, fname);
        const cacheKey = `${sc}|${imgUrl}`;
        if (cache && cache.has(cacheKey)) {
          idx++;
          continue;
        }
        try {
          await fetchToFile(imgUrl, outPath);
          downloaded++;
          idx++;
          log.info(`下載 ${username}: ${fname}`);
          // 寫 manifest
          if (manifestPath) {
            const record = {
              username,
              shortcode: sc,
              postUrl: link,
              imageUrl: imgUrl,
              filename: fname,
              downloadedAt: new Date().toISOString(),
              postTime: isoTime || null,
            };
            fs.appendFileSync(manifestPath, JSON.stringify(record) + '\n');
          }
          if (cache) cache.add(cacheKey);
        } catch (e) {
          log.warn(`下載失敗 ${imgUrl}: ${e.message}`);
        }
        await sleep(pickDelay());
      }
      await sleep(pickDelay());
    }
    return { downloaded };
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

async function fetchViaWebAPI(page, username, maxCount, cookieValue) {
  const headers = {
    'x-ig-app-id': '936619743392459',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': 'application/json',
  };
  if (cookieValue) headers['cookie'] = `sessionid=${cookieValue};`;
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const resp = await page.request.get(url, { headers });
  if (!resp.ok()) throw new Error(`web_profile_info HTTP ${resp.status()}`);
  const data = await resp.json();
  const edges = (((data || {}).data || {}).user || {}).edge_owner_to_timeline_media || {};
  const items = [];
  for (const edge of (edges.edges || [])) {
    const n = edge.node;
    if (!n) continue;
    let images = [];
    if (n.edge_sidecar_to_children && n.edge_sidecar_to_children.edges) {
      for (const c of n.edge_sidecar_to_children.edges) {
        const cn = c.node; if (!cn) continue;
        if (cn.is_video) continue;
        if (cn.display_url) images.push(cn.display_url);
      }
    } else {
      if (!n.is_video && n.display_url) images.push(n.display_url);
    }
    if (images.length === 0) continue;
    items.push({
      shortcode: n.shortcode,
      taken_at_timestamp: n.taken_at_timestamp,
      images,
    });
    if (maxCount && items.length >= maxCount) break;
  }
  return items;
}

module.exports = { runForUser };

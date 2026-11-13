/**
 * 通感 TongGan —— Service Worker 本体（PWA / 离线）。
 *
 * 这个文件放在 `public/` 下，vite 会把它**原样**复制到 dist 根：不打包、不转译、
 * 不改名。所以下面出现的路径口径就是部署后的真实路径（`./` 指站点根）。
 *
 * ## 缓存策略 —— 这里最容易写出「看起来离线、实际喂过期界面 / 白页」
 *
 * 1. **导航与脚本 / 样式 / 其他 worker：network-first + 缓存回退。**
 *    绝不用 cache-first：rebuild 之后浏览器若继续喂旧的 JS，验收测到的就是上一代
 *    的代码，测试全绿而产品是坏的。这是真实事故模式，不是理论风险。
 * 2. **其余同源 GET：cache-first + 后台回填（stale-while-revalidate）。**
 * 3. **只碰同源 GET。** 非 GET、跨域（含 `chrome-extension://`）一律直接 `return`。
 * 4. **缓存名带版本。** activate 删掉所有非当前版本的同名缓存。
 * 5. **不吞错误。** 网络与缓存都失败时返回 `Response.error()`（一个正常的失败响应），
 *    绝不返回 200 空壳 —— 空壳会让上层以为「成功拿到了内容」，然后渲染出一片空白。
 *
 * ## 预缓存：**构建产物才是白页的根因**（评审实测：只缓存 4 个壳文件 → 断网白页）
 *
 * 光把 `/`、`/index.html`、manifest、icon 放进缓存是不够的：真正的界面代码在
 * `assets/index-<hash>.js` 与 `assets/index-<hash>.css` 里，而「加载示例」还要
 * `assets/demo-<hash>.js` 这类**懒 chunk**。所以 install 做一次**传递闭包**抓取：
 *
 *   index.html ──抽取 <script src> / <link rel=stylesheet|modulepreload|preload>──▶ 资源
 *        └─ 每个 JS 的文本里再抽 `"./<name>-<hash>.js"`（懒 chunk 就写在那儿）
 *              └─ 递归到不动点（index → demo/registry/sheet → image → ocr）
 *
 * 于是「首次访问联网一次」之后，断网刷新能拿到壳 + 首屏 + **全部构建产物 chunk**，
 * 「加载示例」也能出表格。
 *
 * ## 明确**不**预缓存的东西（这是决定，不是遗漏）
 *
 * - `tessdata/*.traineddata.gz`（chi_sim 约 19MB）：只有用户真用 OCR 才需要，预缓存它
 *   等于让「第一次访问」变成下载 20MB。它由 cache-first 分支按需回填。
 * - **PDF 的 worker 是「首次在线使用后离线可用」**：预缓存闭包只跟随 `.js`（1.3MB 的
 *   pdf worker 是 `.mjs`，不在安装期预缓存，否则每个不碰 PDF 的用户都要多下一个 1.3MB）。
 *   它带着 `destination: "worker"` 走 network-first，**成功一次就会被回填进缓存**，
 *   之后断网打开 PDF 仍可用。代价是：从没在线打开过 PDF 的话，断网时打不开 PDF ——
 *   这条边界由 `tools/acceptance/offline_acceptance.py` 实测（先在线开一次，再杀服务重开）。
 * - **OCR 离线不可用，这是有意的边界**：tesseract.js 的 worker / wasm 默认从公网 CDN
 *   取（本仓库只自托管了语言包 langPath），所以离线点「上传图片走 OCR」依然会失败。
 *   不要在 UI 或文案里承诺 OCR 能离线。
 * - 任何跨域资源：SW 不做第三方缓存的中间人。
 *
 * ## 诚实边界（别把这里的「离线」理解成别的）
 * - `vite dev` 下这个脚本不会被注册（dev 没有构建产物）。离线只在 dist 构建产物上验证。
 * - 首次访问必须联网一次（预缓存要有东西可抓）；且本页被 SW 接管后才离线可用
 *   （首次访问中controller 常为 null，刷新一次即被接管）。
 * - 「安装到桌面」取决于浏览器支持，不是这个脚本能保证的。
 */

/* eslint-disable no-restricted-globals */

// 版本常量：改这里 = 换一代缓存。必须与 src/app/offline.ts 的 SW_VERSION 一致
// （测试里有静态断言；offline.ts 还把它拼进注册 URL 的 `?v=`，用于读出已激活 SW 的版本）。
const SW_VERSION = "v1";

// 缓存名前缀。必须与 src/app/offline.ts 的 CACHE_PREFIX 逐字一致。
const CACHE_PREFIX = "tonggan-offline";

// 缓存名 = 前缀 + 版本，与 offline.ts 的 cacheNameFor(version) 同构。
const CACHE_NAME = `${CACHE_PREFIX}-${SW_VERSION}`;

/** SW 自身的绝对地址（`self.location` 就是它，含 `?v=<版本>`）。 */
const SW_SELF_URL = self.location.href;

/** 站点根下的 index.html 绝对地址：所有相对路径都以它为基准解析。 */
const INDEX_URL = new URL("./index.html", SW_SELF_URL).href;

/**
 * 稳定壳：`public/` 下的文件会被复制到 dist 根，所以就是 dist 根的相对路径。
 * `./index.html` 不在这里 —— 它由 prefetchBuildGraph() 抓取并缓存（同一个缓存键）。
 * 也**不**放 `./`：对根路径的请求会 302 到 index.html，而 cache.put 不接受重定向响应；
 * 导航到根路径由 networkFirst 的离线回退（match index.html）覆盖。
 */
const SHELL_URLS = ["./manifest.webmanifest", "./icon.svg"];

/** 传递闭包抓取的迭代上限（防病态输入把 install 卡死）。 */
const MAX_GRAPH_NODES = 200;

/** 只收同源、HTTP 200、非重定向、非 opaque 的完整响应。 */
function isCacheableResponse(response) {
  return (
    !!response &&
    response.status === 200 && // 206 Partial Content 不能当完整资源回放，不收
    response.type === "basic" && // opaque / cors / error 一律不收
    response.redirected !== true // 被重定向过的不收：不能把 A 的内容存到 A 的键下
  );
}

/** 把相对地址解析成绝对地址；解析不了返回 null（不抛错，调用方跳过即可）。 */
function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function sameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** 同目录判断：vite 的懒 chunk 引用是相对于**引用它的那个 chunk** 的 `./name-hash.js`。 */
function isSiblingAsset(candidate, fromUrl) {
  const a = absolute(candidate, fromUrl);
  if (!a || !sameOrigin(a)) return false;
  const target = new URL(a);
  const importer = new URL(fromUrl);
  if (!/\.js$/.test(target.pathname)) return false;
  // 排除 SW 自身（入口包里带着注册用的 "./sw.js?v=…" 字符串）。
  if (/\/sw\.js$/.test(target.pathname)) return false;
  const dir = (pathname) => pathname.slice(0, pathname.lastIndexOf("/") + 1);
  return dir(target.pathname) === dir(importer.pathname) && target.pathname !== importer.pathname;
}

/** 从 index.html 的文本里抽出构建产物引用（脚本、样式、modulepreload/preload）。 */
function extractHtmlAssetUrls(html, pageUrl) {
  const found = new Set();
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const url = absolute(match[1], pageUrl);
    if (url && sameOrigin(url)) found.add(url);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (/rel\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "").trim().toLowerCase();
    if (!rel.split(/\s+/).some((token) => token === "stylesheet" || token === "modulepreload" || token === "preload")) {
      continue;
    }
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    const url = absolute(href, pageUrl);
    if (url && sameOrigin(url)) found.add(url);
  }
  return [...found];
}

/** 从一份 JS 文本里抽出它引用的同级 chunk（`"./name-hash.js"`）。 */
function extractSiblingChunkUrls(jsText, jsUrl) {
  const found = new Set();
  for (const match of jsText.matchAll(/["'`](\.\/[A-Za-z0-9._-]+\.js)["'`]/g)) {
    if (isSiblingAsset(match[1], jsUrl)) {
      const url = absolute(match[1], jsUrl);
      if (url) found.add(url);
    }
  }
  return [...found];
}

/**
 * 抓取并缓存整张构建产物图：index.html → 资源 → 懒 chunk（递归到不动点）。
 *
 * 单个资源失败要容忍（否则一个 404 就让整个 install 泡汤），但**抽不到任何 assets
 * 时必须显式 warn**：静默当成成功，就是「单测全绿、断网白页」那条老路。
 */
async function prefetchBuildGraph(cache) {
  const stats = { html: false, cached: 0, failed: [], chunks: 0 };

  let html = "";
  try {
    const response = await fetch(new Request(INDEX_URL, { cache: "reload" }));
    if (isCacheableResponse(response)) {
      html = await response.clone().text();
      await cache.put(INDEX_URL, response);
      stats.html = true;
    } else {
      stats.failed.push(`${INDEX_URL}（HTTP ${response && response.status}）`);
    }
  } catch (error) {
    stats.failed.push(`${INDEX_URL}（${error}）`);
  }

  if (!stats.html) {
    console.warn(`[sw ${SW_VERSION}] 取不到 index.html：本次没有预缓存任何构建产物。`);
    return stats;
  }

  const entryAssets = extractHtmlAssetUrls(html, INDEX_URL);
  if (entryAssets.length === 0) {
    console.warn(
      `[sw ${SW_VERSION}] 未能从 index.html 抽出任何 assets 引用：断网时首屏会是白页。` +
        `请检查构建产物里的 <script src> / <link rel="stylesheet">。`,
    );
    return stats;
  }

  const seen = new Set([INDEX_URL]);
  const queue = [...entryAssets];
  for (const url of queue) seen.add(url);

  while (queue.length > 0 && seen.size <= MAX_GRAPH_NODES) {
    const url = queue.shift();
    let response;
    try {
      response = await fetch(new Request(url, { cache: "reload" }));
    } catch (error) {
      stats.failed.push(`${url}（${error}）`);
      continue;
    }
    if (!isCacheableResponse(response)) {
      stats.failed.push(`${url}（HTTP ${response && response.status}）`);
      continue;
    }
    // JS 要读文本才能发现它引用的懒 chunk；先 clone 再说，谁都不许动原响应。
    const isJs = /\.js$/.test(new URL(url).pathname);
    let text = "";
    if (isJs) {
      try {
        text = await response.clone().text();
      } catch (error) {
        stats.failed.push(`${url}（读文本失败：${error}）`);
        continue;
      }
    }
    try {
      await cache.put(url, response);
      stats.cached += 1;
      if (isJs) stats.chunks += 1;
    } catch (error) {
      stats.failed.push(`${url}（写缓存失败：${error}）`);
      continue;
    }
    if (!isJs) continue;
    for (const chunk of extractSiblingChunkUrls(text, url)) {
      if (seen.has(chunk)) continue;
      seen.add(chunk);
      queue.push(chunk);
    }
  }

  if (seen.size > MAX_GRAPH_NODES) {
    console.warn(`[sw ${SW_VERSION}] 构建产物图超过 ${MAX_GRAPH_NODES} 个节点，已提前停止抓取。`);
  }
  return stats;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // 1) 稳定壳。逐个 add：缺一个不会让整次安装失败。
      const shellResults = await Promise.allSettled(
        SHELL_URLS.map((url) => cache.add(new Request(url, { cache: "reload" }))),
      );
      const shellFailed = SHELL_URLS.filter((_, i) => shellResults[i].status === "rejected");

      // 2) 构建产物（含懒 chunk）：这才是断网不白页的关键。
      const stats = await prefetchBuildGraph(cache);

      const failed = [...shellFailed, ...stats.failed];
      console.log(
        `[sw ${SW_VERSION}] 预缓存完成：构建产物 ${stats.cached} 个（其中 JS ${stats.chunks} 个），` +
          `失败 ${failed.length} 个`,
      );
      if (failed.length > 0) {
        // 不静默：失败的资源在离线时会缺失，得能在控制台看见。
        console.warn(`[sw ${SW_VERSION}] 以下资源未能预缓存：`, failed);
      }

      // skipWaiting：新版本就绪后不等旧标签页关闭，立刻接管下一次导航。
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // 只保留当前版本的缓存，其余同名旧代一律删掉。
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      // claim：不等下一次导航，立刻接管已经打开的页面。
      await self.clients.claim();
    })(),
  );
});

/** 只处理同源 GET；其余（非 GET / 跨域 / chrome-extension）直接放行。 */
function isSameOriginGet(request) {
  if (request.method !== "GET") return false;
  return sameOrigin(request.url);
}

/**
 * 形如 `…/assets/<name>-<hash>.js|css` 的构建产物：内容 hash 会随 rebuild 变，
 * 缓存住就会喂上一代界面。
 */
function looksLikeBuildArtifact(url) {
  try {
    // `.mjs` 也算构建产物：pdf.js 的 worker 是 .mjs，别把它当成「用户内容」走错分支。
    return /\/assets\/[^/]*[.-][A-Za-z0-9_-]{6,}\.(?:js|mjs|css)$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * 哪些请求走 network-first。
 *
 * 只看 `destination` 不够：动态 `import()` 拉起的 chunk 在部分 Chromium 里
 * `destination` 是空字符串，会被错判进 cache-first（评审指出的缺陷）。所以：
 * navigate / document / script / style / worker 一律 network-first；
 * `destination` 为空但 URL 长得像构建产物的，也按 network-first 处理。
 */
function isNetworkFirst(request) {
  if (request.mode === "navigate") return true;
  const destination = request.destination;
  if (
    destination === "document" ||
    destination === "script" ||
    destination === "style" ||
    destination === "worker"
  ) {
    return true;
  }
  if (!destination && looksLikeBuildArtifact(request.url)) return true;
  return false;
}

/** 网络优先、缓存回退。网络与缓存都失败时给出正常失败响应。 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    // 只回填「同源 + 200 + 未重定向」的完整响应（见 isCacheableResponse）。
    if (isCacheableResponse(response)) {
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // 导航到根路径/深链时，回退到已缓存的 index.html（仍是一份真实页面）。
    if (request.mode === "navigate") {
      const shell = await cache.match(INDEX_URL);
      if (shell) return shell;
    }
    // 都不行：如实失败。绝不返回 200 空壳。
    return Response.error();
  }
}

/** 缓存优先 + 后台回填（stale-while-revalidate）。 */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // 后台更新：无论命中与否都发一次网络请求；失败就算了（比如正好断网）。
  const network = fetch(request)
    .then(async (response) => {
      if (isCacheableResponse(response)) {
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => undefined);

  if (cached) return cached;

  const response = await network;
  if (response) return response;
  // 没有缓存、网络也拿不到：正常失败，不编造内容。
  return Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isSameOriginGet(request)) return; // 非 GET / 跨域 / chrome-extension：放行

  if (isNetworkFirst(request)) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(request));
  }
});

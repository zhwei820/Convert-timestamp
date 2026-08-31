// 实时价格卡片：在 VS Code 右上角的副侧边栏（secondary sidebar）常驻显示 Solana 最新价
//
// 位置选型的来龙去脉：VS Code 没把窗口右上角开放给插件 —— StatusBarAlignment 只有 Left/Right
// 且写死在窗口底部，editor/title 那排图标的文案是 package.json 里的静态值、运行时改不了。
// 唯一能贴在窗口右边缘、且内容从顶部开始渲染的贡献点是 viewsContainers.secondarySidebar，
// 所以这里用一个 WebviewView 画卡片。
//
// 参考同仓库 Chrome 扩展的 ../src/sol-price-badge.js：三源回落、失败灰显旧价、缓存先点亮
// 这几条逻辑是一脉相承的；不同的是宿主进程长驻，定时刷新直接用 setInterval，
// 而且卡片不可见时会把定时器停掉——反正没人看，没必要一直打请求。

"use strict";

const vscode = require("vscode");

const STORAGE_KEY = "solPrice.snapshot";
const VIEW_ID = "solPrice.card";
const FETCH_TIMEOUT_MS = 8000;
// 交易所公共行情接口都有限流，间隔太小意义不大还容易被 429
const MIN_INTERVAL_SECONDS = 5;

// CoinGecko 用的是币种全名 id 而不是代号，这里只兜住常见的几个；
// 表里没有的币种就跳过 CoinGecko，靠 Binance / OKX 两个源（它们都能按代号直接查）
const COINGECKO_IDS = {
    SOL: "solana",
    BTC: "bitcoin",
    ETH: "ethereum",
    BNB: "binancecoin",
    XRP: "ripple",
    DOGE: "dogecoin",
    ADA: "cardano",
    AVAX: "avalanche-2",
    TON: "the-open-network",
    SUI: "sui",
    LINK: "chainlink",
    TRX: "tron",
};

/** @type {PriceCardProvider} */
let provider;
/** @type {NodeJS.Timeout | undefined} */
let timer;
/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.ExtensionContext} */
let ctx;
/**
 * @typedef {Object} Snapshot
 * @property {string} symbol   币种代号，比如 SOL
 * @property {number} price    最新价（对 USDT）
 * @property {number} changePercent 24h 涨跌幅，拿不到时是 NaN
 * @property {number} high     24h 最高，CoinGecko 源拿不到时是 NaN
 * @property {number} low      24h 最低，同上
 * @property {string} source   实际命中的数据源名
 * @property {number} updatedAt 抓到这条数据的时刻（epoch ms）
 */

/** @type {Snapshot | null} 最近一次成功拿到的行情，刷新失败时灰着继续显示 */
let lastSnapshot = null;
/** @type {string | null} 最近一次失败原因，一次都没成功过时用来在卡片上说明情况 */
let lastError = null;
/** 正在请求中，避免手动刷新和定时刷新叠在一起打两次 */
let inFlight = false;
let consecutiveFailures = 0;
/** 卡片当前显示的是不是过期数据 */
let showingStale = false;

// ---------------------------------------------------------------- 配置

function getConfig() {
    const cfg = vscode.workspace.getConfiguration("solPrice");
    return {
        symbol: normalizeSymbol(cfg.get("symbol") || "SOL"),
        intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, Number(cfg.get("refreshIntervalSeconds")) || 30),
        colorize: cfg.get("colorize") !== false,
        invertColors: cfg.get("invertColors") === true,
    };
}

// 用户很容易直接填「SOLUSDT」或者小写，这里统一收敛掉，免得请求出来一个 400 让人以为插件坏了
/** @param {unknown} raw @returns {string} */
function normalizeSymbol(raw) {
    const upper = String(raw).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const stripped = upper.replace(/(USDT|USD)$/, "");
    return stripped || "SOL";
}

// ---------------------------------------------------------------- 数据源

/**
 * @typedef {Object} Parsed 各数据源统一归一化后的结果，拿不到的字段用 NaN
 * @property {number} price
 * @property {number} changePercent
 * @property {number} high
 * @property {number} low
 */
/**
 * @typedef {Object} Source
 * @property {string} name
 * @property {string} url
 * @property {(data: any) => Parsed} parse
 */

// 按顺序尝试，前一个失败才走下一个。Binance 在部分地区会被拦，OKX 是最通用的兜底
/** @param {string} symbol @returns {Source[]} */
function buildSources(symbol) {
    const sources = [
        {
            name: "binance",
            url: "https://api.binance.com/api/v3/ticker/24hr?symbol=" + symbol + "USDT",
            /** @param {any} data */
            parse: function (data) {
                return {
                    price: Number(data && data.lastPrice),
                    changePercent: Number(data && data.priceChangePercent),
                    high: Number(data && data.highPrice),
                    low: Number(data && data.lowPrice),
                };
            },
        },
        {
            name: "okx",
            url: "https://www.okx.com/api/v5/market/ticker?instId=" + symbol + "-USDT",
            /** @param {any} data */
            parse: function (data) {
                const t = data && Array.isArray(data.data) ? data.data[0] : null;
                const last = Number(t && t.last);
                const open = Number(t && t.open24h);
                return {
                    price: last,
                    changePercent: isFinite(last) && isFinite(open) && open > 0
                        ? ((last - open) / open) * 100
                        : NaN,
                    high: Number(t && t.high24h),
                    low: Number(t && t.low24h),
                };
            },
        },
    ];

    const geckoId = COINGECKO_IDS[symbol];
    if (geckoId) {
        sources.push({
            name: "coingecko",
            url: "https://api.coingecko.com/api/v3/simple/price?ids=" + geckoId +
                "&vs_currencies=usd&include_24hr_change=true",
            /** @param {any} data */
            parse: function (data) {
                const coin = data && data[geckoId];
                return {
                    price: Number(coin && coin.usd),
                    changePercent: Number(coin && coin.usd_24h_change),
                    high: NaN,
                    low: NaN,
                };
            },
        });
    }

    return sources;
}

/** @param {string} url @returns {Promise<any>} */
async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const timeoutTimer = setTimeout(function () {
        controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
        // Node 的 fetch 没有浏览器那套 HTTP 缓存，所以不用 cache: "no-store"（它也不认这个选项）；
        // 加个请求头是防中间的公司代理把行情响应缓存住
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { "Cache-Control": "no-cache" },
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
    } finally {
        clearTimeout(timeoutTimer);
    }
}

/** @param {string} symbol @returns {Promise<Snapshot>} */
async function fetchPrice(symbol) {
    let lastFetchError = null;
    for (const source of buildSources(symbol)) {
        try {
            const raw = await fetchJsonWithTimeout(source.url);
            const parsed = source.parse(raw);
            if (!isFinite(parsed.price) || parsed.price <= 0) {
                throw new Error("价格字段无效: " + JSON.stringify(raw).slice(0, 200));
            }
            return {
                symbol: symbol,
                price: parsed.price,
                changePercent: isFinite(parsed.changePercent) ? parsed.changePercent : NaN,
                high: parsed.high,
                low: parsed.low,
                source: source.name,
                updatedAt: Date.now(),
            };
        } catch (e) {
            lastFetchError = e;
            log("数据源 " + source.name + " 失败: " + (e && e.message));
        }
    }
    throw lastFetchError || new Error("所有数据源均不可用");
}

// ---------------------------------------------------------------- 格式化

// 卡片宽度比状态栏宽松，按量级给足有效位就行
/** @param {number} price @returns {string} */
function formatPrice(price) {
    if (!isFinite(price)) return "—";
    if (price >= 1000) {
        return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (price >= 1) return price.toFixed(2);
    if (price >= 0.01) return price.toFixed(4);
    // 山寨币能小到 0.00000123，固定小数位会直接抹平成 0，所以这一档按有效位数留
    return String(Number(price.toPrecision(4)));
}

/** @param {number} changePercent @returns {string} */
function formatChangePercent(changePercent) {
    if (!isFinite(changePercent)) return "";
    return (changePercent >= 0 ? "+" : "") + changePercent.toFixed(2) + "%";
}

/** @param {number} timestamp @returns {string} */
function formatClock(timestamp) {
    const d = new Date(timestamp);
    /** @param {number} n */
    const pad = function (n) {
        return n < 10 ? "0" + n : String(n);
    };
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

// ---------------------------------------------------------------- 卡片

function nonce() {
    let text = "";
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
    return text;
}

function buildHtml() {
    const n = nonce();
    // 颜色全部走 VS Code 的主题变量，浅色 / 深色 / 高对比度主题都能自动跟上；
    // charts-green / charts-red 是主题自带的涨跌色，比写死的十六进制更协调
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 14px 12px 16px;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .pair {
    font-size: 11px;
    letter-spacing: .08em;
    color: var(--vscode-descriptionForeground);
  }
  /* 用 vw 让字号跟着侧边栏宽度走：栏拖窄了不会撑破，拖宽了看得更爽 */
  .price {
    font-size: clamp(22px, 13vw, 42px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
    margin-top: 6px;
    word-break: break-all;
  }
  .change {
    font-size: clamp(12px, 6vw, 17px);
    font-variant-numeric: tabular-nums;
    margin-top: 3px;
  }
  .tone-green { color: var(--vscode-charts-green, #16a34a); }
  .tone-red   { color: var(--vscode-charts-red, #dc2626); }
  .tone-gray  { color: var(--vscode-descriptionForeground); }
  .stats {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  .row { display: flex; justify-content: space-between; gap: 10px; }
  .row .k { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .row .v { font-variant-numeric: tabular-nums; text-align: right; }
  .meta {
    margin-top: 12px;
    font-size: 11px;
    line-height: 1.6;
    color: var(--vscode-descriptionForeground);
  }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .err {
    font-size: 11px;
    line-height: 1.5;
    margin-top: 8px;
    color: var(--vscode-descriptionForeground);
    word-break: break-all;
  }
  .actions { margin-top: 14px; display: flex; flex-wrap: wrap; gap: 6px; }
  button {
    flex: 1 1 auto;
    min-width: 52px;
    font-family: inherit;
    font-size: 11px;
    padding: 5px 8px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  }
  button:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
  }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="pair" id="pair">—</div>
  <div class="price" id="price">…</div>
  <div class="change" id="change"></div>

  <div class="stats" id="stats" hidden>
    <div class="row"><span class="k">24h 高</span><span class="v" id="high">—</span></div>
    <div class="row"><span class="k">24h 低</span><span class="v" id="low">—</span></div>
  </div>

  <div class="err" id="err" hidden></div>

  <div class="meta" id="meta"></div>

  <div class="actions">
    <button data-cmd="refresh" title="重新拉一次行情">刷新</button>
    <button data-cmd="copy" title="把价格写进剪贴板">复制</button>
    <button data-cmd="switch" title="换成别的币种">切币种</button>
  </div>

<script nonce="${n}">
  const api = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const TONES = ["tone-green", "tone-red", "tone-gray"];

  let updatedAt = 0;
  let sourceName = "";
  let staleNote = "";

  function ageText(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + " 秒前";
    if (s < 3600) return Math.round(s / 60) + " 分钟前";
    return Math.round(s / 3600) + " 小时前";
  }

  // 「x 秒前」每秒自己走，不用扩展侧每秒推一条消息
  function paintMeta() {
    if (!updatedAt) { $("meta").innerHTML = ""; return; }
    const clock = new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false });
    $("meta").innerHTML =
      (staleNote ? '<div class="warn">' + staleNote + "</div>" : "") +
      clock + " 更新（" + ageText(updatedAt) + "）" +
      (sourceName ? "<br>数据源 " + sourceName : "");
  }

  function setTone(el, tone) {
    el.classList.remove(...TONES);
    if (tone === "green" || tone === "red" || tone === "gray") el.classList.add("tone-" + tone);
  }

  window.addEventListener("message", (event) => {
    const m = event.data;

    if (m.type === "loading") {
      $("pair").textContent = m.symbol + " / USDT";
      $("price").textContent = "…";
      setTone($("price"), "none");
      $("change").textContent = "";
      $("stats").hidden = true;
      $("err").hidden = true;
      updatedAt = 0; sourceName = ""; staleNote = "";
      paintMeta();
      return;
    }

    if (m.type === "error") {
      $("pair").textContent = m.symbol + " / USDT";
      $("price").textContent = "—";
      setTone($("price"), "gray");
      $("change").textContent = "";
      $("stats").hidden = true;
      $("err").hidden = false;
      $("err").textContent = m.message;
      updatedAt = 0; sourceName = ""; staleNote = "";
      paintMeta();
      return;
    }

    // m.type === "snapshot"
    $("pair").textContent = m.symbol + " / USDT";
    $("price").textContent = "$" + m.priceText;
    setTone($("price"), m.tone);
    $("change").textContent = m.changeText ? m.arrow + " " + m.changeText : "—";
    setTone($("change"), m.tone);
    $("err").hidden = true;

    if (m.highText && m.lowText) {
      $("stats").hidden = false;
      $("high").textContent = m.highText;
      $("low").textContent = m.lowText;
    } else {
      $("stats").hidden = true;
    }

    updatedAt = m.updatedAt;
    sourceName = m.source;
    staleNote = m.staleNote || "";
    paintMeta();
  });

  document.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => api.postMessage({ cmd: b.dataset.cmd }));
  });

  setInterval(paintMeta, 1000);
</script>
</body>
</html>`;
}

class PriceCardProvider {
    constructor() {
        /** @type {vscode.WebviewView | undefined} */
        this.view = undefined;
    }

    /** @param {vscode.WebviewView} webviewView */
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        // 卡片里所有资源都内联，不需要读本地文件，localResourceRoots 直接给空数组收紧 CSP
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
        webviewView.webview.html = buildHtml();

        webviewView.webview.onDidReceiveMessage(/** @param {any} msg */ function (msg) {
            if (!msg) return;
            if (msg.cmd === "refresh") refresh({ notifyError: true });
            else if (msg.cmd === "copy") copyPrice();
            else if (msg.cmd === "switch") switchSymbol();
        });

        webviewView.onDidChangeVisibility(function () {
            if (webviewView.visible) {
                pushState();
                onCardVisible();
            } else {
                // 没人看就别再打请求了
                stopTimer();
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
            stopTimer();
        });

        pushState();
        onCardVisible();
    }

    /** @param {any} message */
    post(message) {
        if (this.view) this.view.webview.postMessage(message);
    }

    get visible() {
        return !!(this.view && this.view.visible);
    }
}

/**
 * @param {Snapshot} snapshot
 * @param {boolean} isStale
 * @returns {"green" | "red" | "gray" | "none"}
 */
function toneFor(snapshot, isStale) {
    const cfg = getConfig();
    if (!cfg.colorize) return "none";
    if (isStale || !isFinite(snapshot.changePercent)) return "gray";
    const up = snapshot.changePercent >= 0;
    // invertColors 打开就是 A 股口径：涨红跌绿
    if (cfg.invertColors) return up ? "red" : "green";
    return up ? "green" : "red";
}

function pushState() {
    const cfg = getConfig();

    if (!lastSnapshot || lastSnapshot.symbol !== cfg.symbol) {
        if (lastError) {
            provider.post({
                type: "error",
                symbol: cfg.symbol,
                message: "所有数据源都没拿到 —— 可能是币种代号不存在，或者网络 / 代理不通。\n最后一次报错：" +
                    lastError.slice(0, 200),
            });
        } else {
            provider.post({ type: "loading", symbol: cfg.symbol });
        }
        return;
    }

    const hasRange = isFinite(lastSnapshot.high) && isFinite(lastSnapshot.low);
    const changeText = formatChangePercent(lastSnapshot.changePercent);
    let arrow = "";
    if (isFinite(lastSnapshot.changePercent)) arrow = lastSnapshot.changePercent >= 0 ? "▲" : "▼";

    provider.post({
        type: "snapshot",
        symbol: lastSnapshot.symbol,
        priceText: formatPrice(lastSnapshot.price),
        changeText: changeText,
        arrow: arrow,
        tone: toneFor(lastSnapshot, showingStale),
        highText: hasRange ? formatPrice(lastSnapshot.high) : "",
        lowText: hasRange ? formatPrice(lastSnapshot.low) : "",
        source: lastSnapshot.source,
        updatedAt: lastSnapshot.updatedAt,
        staleNote: showingStale
            ? "⚠ 刷新失败" + (consecutiveFailures > 1 ? "（连续 " + consecutiveFailures + " 次）" : "") +
              "，下面是旧数据"
            : "",
    });
}

// ---------------------------------------------------------------- 刷新

function staleThresholdMs() {
    // 连着漏两三次才算「旧」，网络抖一下不至于立刻把卡片灰掉
    return getConfig().intervalSeconds * 1000 * 3;
}

/**
 * @param {{ notifyError?: boolean }} [options] notifyError 只在用户手动触发时给 true，
 *   定时刷新失败只写日志——否则断网时会被弹窗刷屏
 */
async function refresh(options) {
    if (inFlight) return;
    inFlight = true;
    const symbol = getConfig().symbol;
    try {
        const snapshot = await fetchPrice(symbol);
        // 请求飞在路上时用户可能已经切了币种，这种情况直接丢弃这次结果
        if (getConfig().symbol !== snapshot.symbol) return;
        lastSnapshot = snapshot;
        lastError = null;
        consecutiveFailures = 0;
        showingStale = false;
        pushState();
        await ctx.globalState.update(STORAGE_KEY, snapshot);
        log("已更新 " + snapshot.symbol + " = " + snapshot.price + "（" + snapshot.source + "）");
    } catch (e) {
        consecutiveFailures++;
        const message = (e && e.message) || String(e);
        lastError = message;
        log("刷新失败: " + message);
        // 拉不到就把上一次的价格灰掉继续显示，别让卡片空着——空着比旧价格更容易让人误判
        if (lastSnapshot && lastSnapshot.symbol === symbol && isFinite(lastSnapshot.price)) {
            showingStale = true;
        }
        pushState();
        if (options && options.notifyError) {
            vscode.window.showErrorMessage("行情刷新失败：" + message);
        }
    } finally {
        inFlight = false;
    }
}

function startTimer() {
    stopTimer();
    const intervalMs = getConfig().intervalSeconds * 1000;
    timer = setInterval(function () {
        refresh();
    }, intervalMs);
}

function stopTimer() {
    if (timer) clearInterval(timer);
    timer = undefined;
}

/** 卡片露出来时：手上数据过期就立刻补一刷，并把定时器开起来 */
function onCardVisible() {
    const stale = !lastSnapshot ||
        lastSnapshot.symbol !== getConfig().symbol ||
        Date.now() - lastSnapshot.updatedAt > staleThresholdMs();
    if (stale) refresh();
    startTimer();
}

// 冷启动时先用缓存把卡片点亮，避免第一次请求那几百毫秒里显示一个空壳
function restoreFromCache() {
    const cached = ctx.globalState.get(STORAGE_KEY);
    if (!cached || !isFinite(cached.price)) return;
    if (cached.symbol !== getConfig().symbol) return;
    lastSnapshot = cached;
    showingStale = Date.now() - cached.updatedAt > staleThresholdMs();
}

// ---------------------------------------------------------------- 命令

async function copyPrice() {
    const cfg = getConfig();
    if (!lastSnapshot || lastSnapshot.symbol !== cfg.symbol || !isFinite(lastSnapshot.price)) {
        vscode.window.showWarningMessage("还没有拿到价格，先刷新一次试试");
        return;
    }
    const text = formatPrice(lastSnapshot.price);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage("已复制 " + lastSnapshot.symbol + " 价格 " + text, 2000);
}

async function switchSymbol() {
    const current = getConfig().symbol;
    const input = await vscode.window.showInputBox({
        title: "切换币种",
        prompt: "填币种代号即可（对 USDT 计价），比如 SOL / BTC / ETH",
        value: current,
        validateInput: function (value) {
            const normalized = normalizeSymbol(value);
            if (!/^[A-Z0-9]{2,12}$/.test(normalized)) return "只填字母数字的币种代号，比如 SOL";
            return null;
        },
    });
    if (!input) return;
    const symbol = normalizeSymbol(input);
    if (symbol === current) return;
    // 写进全局设置，换个窗口也保持一致
    await vscode.workspace.getConfiguration("solPrice")
        .update("symbol", symbol, vscode.ConfigurationTarget.Global);
    // 配置变更监听会接着把卡片和定时器都刷新掉
}

/** @param {string} message */
function log(message) {
    output.appendLine("[" + formatClock(Date.now()) + "] " + message);
}

// ---------------------------------------------------------------- 生命周期

/** @param {vscode.ConfigurationChangeEvent} event */
function onConfigChanged(event) {
    if (!event.affectsConfiguration("solPrice")) return;

    if (event.affectsConfiguration("solPrice.symbol")) {
        lastSnapshot = null;
        lastError = null;
        consecutiveFailures = 0;
        showingStale = false;
        restoreFromCache();
        pushState();
        refresh({ notifyError: true });
    } else {
        // 纯显示项（颜色 / 反转）改了就用手上的数据重画，不用再打一次请求
        pushState();
    }

    if (event.affectsConfiguration("solPrice.refreshIntervalSeconds") && provider.visible) {
        startTimer();
    }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    ctx = context;
    output = vscode.window.createOutputChannel("实时价格");
    provider = new PriceCardProvider();

    restoreFromCache();

    context.subscriptions.push(
        output,
        // retainContextWhenHidden：侧边栏来回切时卡片不用重新加载，回来就是原样
        vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand("solPrice.show", function () {
            // <viewId>.focus 是 VS Code 给每个 view 自动生成的命令
            return vscode.commands.executeCommand(VIEW_ID + ".focus");
        }),
        vscode.commands.registerCommand("solPrice.refresh", function () {
            return refresh({ notifyError: true });
        }),
        vscode.commands.registerCommand("solPrice.copyPrice", copyPrice),
        vscode.commands.registerCommand("solPrice.switchSymbol", switchSymbol),
        vscode.commands.registerCommand("solPrice.showLog", function () {
            output.show(true);
        }),
        vscode.workspace.onDidChangeConfiguration(onConfigChanged),
        // 窗口重新聚焦时，如果卡片正开着而数据已过期就补一刷
        vscode.window.onDidChangeWindowState(function (state) {
            if (!state.focused || !provider.visible) return;
            const stale = !lastSnapshot || Date.now() - lastSnapshot.updatedAt > staleThresholdMs();
            if (stale) refresh();
        })
    );

    // 注意这里不主动 refresh：卡片没打开就没人看，等 resolveWebviewView 再开始拉数据
}

function deactivate() {
    stopTimer();
}

module.exports = { activate, deactivate };

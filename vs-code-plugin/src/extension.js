// SOL 价格状态栏：把 Solana 最新价常驻在 VS Code 状态栏最右端，编辑器开着就一直能看到
//
// 相当于 Chrome 扩展里的图标 badge（见 ../src/sol-price-badge.js），但这边的宿主进程不会被回收，
// 所以定时刷新直接用 setInterval 就行，不需要 chrome.alarms 那套唤醒机制，
// 刷新频率也不再被 MV3 的 1 分钟下限卡住。

"use strict";

const vscode = require("vscode");

const STORAGE_KEY = "solPrice.snapshot";
const ITEM_ID = "solPrice.price";
const FETCH_TIMEOUT_MS = 8000;
// 交易所公共行情接口都有限流，间隔太小意义不大还容易被 429
const MIN_INTERVAL_SECONDS = 5;

// 状态栏的 priority 是「越大越靠左」（见 vscode.d.ts: "Higher values mean the item
// should be shown more to the left."），所以要钉在最右端得给一个足够小的值。
// 取 -1e6 而不是 0 / -100，是为了压过别的插件常用的那些负数优先级。
const PRIORITY_RIGHTMOST = -1000000;

// 涨绿跌红（加密行情通用配色）；想换成 A 股的红涨绿跌，打开 solPrice.invertColors
const COLOR_UP = "#16a34a";
const COLOR_DOWN = "#dc2626";
const COLOR_STALE = "#9ca3af";

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

/** @type {vscode.StatusBarItem | undefined} */
let statusBarItem;
/** @type {NodeJS.Timeout | undefined} */
let timer;
/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.ExtensionContext} */
let ctx;
/** @type {Snapshot | null} 最近一次成功拿到的行情，刷新失败时灰着继续显示 */
let lastSnapshot = null;
/** 正在请求中，避免手动刷新和定时刷新叠在一起打两次 */
let inFlight = false;
let consecutiveFailures = 0;
/** 状态栏当前显示的是不是过期数据 */
let showingStale = false;

// ---------------------------------------------------------------- 配置

function getConfig() {
    const cfg = vscode.workspace.getConfiguration("solPrice");
    const icon = cfg.get("icon");
    return {
        symbol: normalizeSymbol(cfg.get("symbol") || "SOL"),
        intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, Number(cfg.get("refreshIntervalSeconds")) || 30),
        showChangePercent: cfg.get("showChangePercent") !== false,
        colorize: cfg.get("colorize") !== false,
        invertColors: cfg.get("invertColors") === true,
        icon: typeof icon === "string" ? icon.trim() : "$(pulse)",
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

// 状态栏宽度比 badge 宽松得多，所以按量级给足有效位就行，不用像 badge 那样压到 4 个字符
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

/** @param {number} timestamp @returns {string} */
function formatAge(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return seconds + " 秒前";
    if (seconds < 3600) return Math.round(seconds / 60) + " 分钟前";
    return Math.round(seconds / 3600) + " 小时前";
}

// ---------------------------------------------------------------- 状态栏

function createStatusBarItem() {
    const cfg = getConfig();
    // 带 id 的这个重载能让 VS Code 记住用户对这一项的显隐 / 拖动位置
    statusBarItem = vscode.window.createStatusBarItem(
        ITEM_ID,
        vscode.StatusBarAlignment.Right,
        PRIORITY_RIGHTMOST
    );
    statusBarItem.name = "SOL 实时价格";
    statusBarItem.command = "solPrice.showMenu";
    statusBarItem.text = (cfg.icon ? cfg.icon + " " : "") + cfg.symbol + " …";
    statusBarItem.tooltip = "正在获取 " + cfg.symbol + " 价格…";
    statusBarItem.show();
    ctx.subscriptions.push(statusBarItem);
}

/**
 * @param {Snapshot} snapshot
 * @param {boolean} isStale
 */
function render(snapshot, isStale) {
    if (!statusBarItem) return;
    const cfg = getConfig();
    showingStale = isStale;

    const parts = [];
    if (cfg.icon) parts.push(cfg.icon);
    parts.push(snapshot.symbol + " $" + formatPrice(snapshot.price));
    const changeText = formatChangePercent(snapshot.changePercent);
    if (cfg.showChangePercent && changeText) parts.push(changeText);
    statusBarItem.text = parts.join(" ");

    if (!cfg.colorize) {
        statusBarItem.color = undefined;
    } else if (isStale || !isFinite(snapshot.changePercent)) {
        statusBarItem.color = COLOR_STALE;
    } else {
        const up = snapshot.changePercent >= 0;
        // invertColors 打开就是 A 股口径：涨红跌绿
        const positiveColor = cfg.invertColors ? COLOR_DOWN : COLOR_UP;
        const negativeColor = cfg.invertColors ? COLOR_UP : COLOR_DOWN;
        statusBarItem.color = up ? positiveColor : negativeColor;
    }

    statusBarItem.tooltip = buildTooltip(snapshot, isStale);
}

/**
 * @param {Snapshot} snapshot
 * @param {boolean} isStale
 * @returns {vscode.MarkdownString}
 */
function buildTooltip(snapshot, isStale) {
    const md = new vscode.MarkdownString();
    // 需要 isTrusted 才能在 tooltip 里点 command: 链接
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const changeText = formatChangePercent(snapshot.changePercent) || "—";
    md.appendMarkdown("**" + snapshot.symbol + " / USDT**\n\n");
    md.appendMarkdown("价格 　$" + formatPrice(snapshot.price) + "\n\n");
    md.appendMarkdown("24h 涨跌 　" + changeText + "\n\n");
    if (isFinite(snapshot.high) && isFinite(snapshot.low)) {
        md.appendMarkdown("24h 高 / 低 　" + formatPrice(snapshot.high) + " / " + formatPrice(snapshot.low) + "\n\n");
    }
    md.appendMarkdown("---\n\n");
    if (isStale) {
        md.appendMarkdown("$(warning) 刷新失败" +
            (consecutiveFailures > 1 ? "（连续 " + consecutiveFailures + " 次）" : "") +
            "，下面是旧数据\n\n");
    }
    md.appendMarkdown("$(clock) " + formatClock(snapshot.updatedAt) + " 更新（" + formatAge(snapshot.updatedAt) +
        "） · 数据源 " + snapshot.source + "\n\n");
    md.appendMarkdown("[$(sync) 立即刷新](command:solPrice.refresh) · " +
        "[$(clippy) 复制价格](command:solPrice.copyPrice) · " +
        "[$(gear) 设置](command:workbench.action.openSettings?%5B%22solPrice%22%5D)");
    return md;
}

/** @param {string} message */
function renderNoData(message) {
    if (!statusBarItem) return;
    const cfg = getConfig();
    showingStale = true;
    statusBarItem.text = (cfg.icon ? cfg.icon + " " : "") + cfg.symbol + " —";
    statusBarItem.color = cfg.colorize ? COLOR_STALE : undefined;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown("**" + cfg.symbol + " 价格获取失败**\n\n");
    md.appendMarkdown("所有数据源都没拿到 —— 可能是币种代号不存在，或者网络 / 代理不通。\n\n");
    md.appendMarkdown("最后一次的报错：`" + message.slice(0, 160).replace(/`/g, "'") + "`\n\n---\n\n");
    md.appendMarkdown("[$(sync) 重试](command:solPrice.refresh) · " +
        "[$(output) 查看日志](command:solPrice.showLog) · " +
        "[$(gear) 设置](command:workbench.action.openSettings?%5B%22solPrice%22%5D)");
    statusBarItem.tooltip = md;
}

// ---------------------------------------------------------------- 刷新

function staleThresholdMs() {
    // 连着漏两三次才算「旧」，网络抖一下不至于立刻把状态栏灰掉
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
        consecutiveFailures = 0;
        render(snapshot, false);
        await ctx.globalState.update(STORAGE_KEY, snapshot);
        log("已更新 " + snapshot.symbol + " = " + snapshot.price + "（" + snapshot.source + "）");
    } catch (e) {
        consecutiveFailures++;
        const message = (e && e.message) || String(e);
        log("刷新失败: " + message);
        // 拉不到就把上一次的价格灰掉继续显示，别让状态栏空着——空徽章比旧价格更容易让人误判
        if (lastSnapshot && lastSnapshot.symbol === symbol && isFinite(lastSnapshot.price)) {
            render(lastSnapshot, true);
        } else {
            renderNoData(message);
        }
        if (options && options.notifyError) {
            vscode.window.showErrorMessage("SOL 价格刷新失败：" + message);
        }
    } finally {
        inFlight = false;
    }
}

function restartTimer() {
    if (timer) clearInterval(timer);
    const intervalMs = getConfig().intervalSeconds * 1000;
    timer = setInterval(function () {
        refresh();
    }, intervalMs);
}

// 冷启动时先用缓存把状态栏点亮，避免第一次请求那几百毫秒里显示一个空壳
function restoreFromCache() {
    const cached = ctx.globalState.get(STORAGE_KEY);
    if (!cached || !isFinite(cached.price)) return;
    if (cached.symbol !== getConfig().symbol) return;
    lastSnapshot = cached;
    render(cached, Date.now() - cached.updatedAt > staleThresholdMs());
}

// ---------------------------------------------------------------- 命令

async function showMenu() {
    const cfg = getConfig();
    /** @type {any[]} */
    const items = [];
    if (lastSnapshot && lastSnapshot.symbol === cfg.symbol) {
        items.push({
            label: "$(pulse) " + lastSnapshot.symbol + " $" + formatPrice(lastSnapshot.price),
            description: formatChangePercent(lastSnapshot.changePercent) || "—",
            detail: formatClock(lastSnapshot.updatedAt) + " 更新 · 数据源 " + lastSnapshot.source +
                (showingStale ? " · ⚠ 数据已过期" : ""),
            action: "refresh",
        });
    }
    items.push(
        { label: "$(sync) 立即刷新", action: "refresh" },
        { label: "$(clippy) 复制价格", action: "copy" },
        { label: "$(arrow-swap) 切换币种…", description: "当前 " + cfg.symbol, action: "switch" },
        { label: "$(link-external) 打开 Binance 行情页", action: "open" },
        { label: "$(gear) 插件设置", action: "settings" },
        { label: "$(output) 查看日志", action: "log" }
    );

    const picked = await vscode.window.showQuickPick(items, {
        title: cfg.symbol + " 行情",
        placeHolder: "选一个操作",
    });
    if (!picked) return;

    switch (picked.action) {
        case "refresh":
            await refresh({ notifyError: true });
            break;
        case "copy":
            await copyPrice();
            break;
        case "switch":
            await switchSymbol();
            break;
        case "open":
            await vscode.env.openExternal(
                vscode.Uri.parse("https://www.binance.com/zh-CN/trade/" + cfg.symbol + "_USDT")
            );
            break;
        case "settings":
            await vscode.commands.executeCommand("workbench.action.openSettings", "solPrice");
            break;
        case "log":
            output.show(true);
            break;
    }
}

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
    // 配置变更监听会接着把状态栏和定时器都刷新掉
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
        consecutiveFailures = 0;
        showingStale = false;
        const cfg = getConfig();
        if (statusBarItem) {
            statusBarItem.text = (cfg.icon ? cfg.icon + " " : "") + cfg.symbol + " …";
            statusBarItem.color = undefined;
        }
        restoreFromCache();
        refresh({ notifyError: true });
    } else if (lastSnapshot) {
        // 纯显示项（图标 / 颜色 / 涨跌幅）改了就用手上的数据重画，不用再打一次请求
        render(lastSnapshot, showingStale);
    }

    if (event.affectsConfiguration("solPrice.refreshIntervalSeconds")) {
        restartTimer();
    }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    ctx = context;
    output = vscode.window.createOutputChannel("SOL 价格");
    context.subscriptions.push(output);

    createStatusBarItem();
    restoreFromCache();

    context.subscriptions.push(
        vscode.commands.registerCommand("solPrice.showMenu", showMenu),
        vscode.commands.registerCommand("solPrice.refresh", function () {
            return refresh({ notifyError: true });
        }),
        vscode.commands.registerCommand("solPrice.copyPrice", copyPrice),
        vscode.commands.registerCommand("solPrice.switchSymbol", switchSymbol),
        vscode.commands.registerCommand("solPrice.showLog", function () {
            output.show(true);
        }),
        vscode.workspace.onDidChangeConfiguration(onConfigChanged),
        // 窗口重新聚焦时如果手上的数据已经过期就补一刷：从别处切回 VS Code 立刻看到新价，不用等下一个 tick
        vscode.window.onDidChangeWindowState(function (state) {
            if (!state.focused) return;
            const stale = !lastSnapshot || Date.now() - lastSnapshot.updatedAt > staleThresholdMs();
            if (stale) refresh();
        })
    );

    refresh();
    restartTimer();
}

function deactivate() {
    if (timer) clearInterval(timer);
    timer = undefined;
}

module.exports = { activate, deactivate };

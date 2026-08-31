// SOL 价格徽章：把 Solana 最新价直接写在扩展图标的 badge 上，浏览器开着就一直能看到
// service worker 随时会被回收，所以定时刷新靠 chrome.alarms 唤醒，不能用 setInterval

const SOL_ALARM_NAME = "sol-price-refresh";
// MV3 已发布扩展的 alarms 周期下限就是 1 分钟，再小会被 Chrome 静默抬回 1 分钟
const SOL_REFRESH_MINUTES = 1;
const SOL_STORAGE_KEY = "solPriceSnapshot";
const SOL_FETCH_TIMEOUT_MS = 8000;

// 涨绿跌红（加密行情通用配色）；想换成 A 股的红涨绿跌，把下面两个值对调即可
const SOL_COLOR_UP = "#16a34a";
const SOL_COLOR_DOWN = "#dc2626";
const SOL_COLOR_STALE = "#6b7280";

// 按顺序尝试，前一个失败才走下一个
const SOL_SOURCES = [
    {
        name: "binance",
        url: "https://api.binance.com/api/v3/ticker/24hr?symbol=SOLUSDT",
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
        name: "coingecko",
        url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
        parse: function (data) {
            const sol = data && data.solana;
            return {
                price: Number(sol && sol.usd),
                changePercent: Number(sol && sol.usd_24h_change),
                high: NaN,
                low: NaN,
            };
        },
    },
];

// badge 里多显示几位小数。Chrome 官方口径是「badge 大约只放得下 4 个字符」，
// 带小数后是 5 个字符，个别 Chrome 版本 / 屏幕缩放下最后一位可能被裁掉；
// 真被裁了就把这个值改成 0，即可退回原来的整数显示。
const SOL_BADGE_DECIMALS = 1;

// 按价格量级动态砍精度，保证宽度恒定：越贵的币小数位越少
function formatBadgePrice(price) {
    if (price >= 10000) return Math.round(price / 1000) + "k";
    if (price >= 1000) return (price / 1000).toFixed(1) + "k";
    if (price >= 100) return price.toFixed(SOL_BADGE_DECIMALS);
    if (price >= 10) return price.toFixed(SOL_BADGE_DECIMALS + 1);
    return price.toFixed(SOL_BADGE_DECIMALS + 2);
}

function formatChangePercent(changePercent) {
    if (!isFinite(changePercent)) return "";
    return (changePercent >= 0 ? "+" : "") + changePercent.toFixed(2) + "%";
}

function formatClock(timestamp) {
    const d = new Date(timestamp);
    const pad = function (n) {
        return n < 10 ? "0" + n : String(n);
    };
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

async function fetchJsonWithTimeout(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
        controller.abort();
    }, SOL_FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchSolPrice() {
    let lastError = null;
    for (const source of SOL_SOURCES) {
        try {
            const raw = await fetchJsonWithTimeout(source.url);
            const parsed = source.parse(raw);
            if (!isFinite(parsed.price) || parsed.price <= 0) {
                throw new Error("价格字段无效: " + JSON.stringify(raw).slice(0, 200));
            }
            return {
                price: parsed.price,
                changePercent: isFinite(parsed.changePercent) ? parsed.changePercent : NaN,
                high: parsed.high,
                low: parsed.low,
                source: source.name,
                updatedAt: Date.now(),
            };
        } catch (e) {
            lastError = e;
            console.warn("[sol-price] 数据源 " + source.name + " 失败:", e && e.message);
        }
    }
    throw lastError || new Error("所有数据源均不可用");
}

function renderBadge(snapshot, isStale) {
    const changeText = formatChangePercent(snapshot.changePercent);
    let color = SOL_COLOR_STALE;
    if (!isStale && isFinite(snapshot.changePercent)) {
        color = snapshot.changePercent >= 0 ? SOL_COLOR_UP : SOL_COLOR_DOWN;
    }

    chrome.action.setBadgeText({ text: formatBadgePrice(snapshot.price) });
    chrome.action.setBadgeBackgroundColor({ color: color });
    // Chrome 110+ 才有，低版本忽略即可（默认白字在这几个底色上也够清楚）
    if (chrome.action.setBadgeTextColor) {
        chrome.action.setBadgeTextColor({ color: "#ffffff" });
    }

    const lines = [
        "SOL / USDT  $" + snapshot.price.toFixed(2),
        changeText ? "24h  " + changeText : "24h  —",
    ];
    if (isFinite(snapshot.high) && isFinite(snapshot.low)) {
        lines.push("24h 高 " + snapshot.high.toFixed(2) + " / 低 " + snapshot.low.toFixed(2));
    }
    lines.push(
        (isStale ? "⚠ 更新失败，下面是 " : "") +
            formatClock(snapshot.updatedAt) +
            " 的数据 · " +
            snapshot.source
    );
    chrome.action.setTitle({ title: lines.join("\n") });
}

async function refreshSolPrice() {
    try {
        const snapshot = await fetchSolPrice();
        renderBadge(snapshot, false);
        await chrome.storage.local.set({ [SOL_STORAGE_KEY]: snapshot });
        console.log("[sol-price] 已更新:", snapshot.price, snapshot.source);
    } catch (e) {
        console.error("[sol-price] 刷新失败:", e && e.message);
        // 拉不到就把上一次的价格灰掉继续显示，别让徽章空着——空徽章比旧价格更容易让人误判
        const stored = await chrome.storage.local.get([SOL_STORAGE_KEY]);
        const snapshot = stored && stored[SOL_STORAGE_KEY];
        if (snapshot && isFinite(snapshot.price)) {
            renderBadge(snapshot, true);
        } else {
            chrome.action.setBadgeText({ text: "…" });
            chrome.action.setBadgeBackgroundColor({ color: SOL_COLOR_STALE });
            chrome.action.setTitle({ title: "SOL 价格获取失败\n" + (e && e.message) });
        }
    }
}

// service worker 每次冷启动都会跑到这里：先用缓存把徽章立刻点亮，避免几百毫秒的空白
async function restoreBadgeFromCache() {
    const stored = await chrome.storage.local.get([SOL_STORAGE_KEY]);
    const snapshot = stored && stored[SOL_STORAGE_KEY];
    if (!snapshot || !isFinite(snapshot.price)) return null;
    const ageMs = Date.now() - snapshot.updatedAt;
    renderBadge(snapshot, ageMs > SOL_REFRESH_MINUTES * 60 * 1000 * 2);
    return snapshot;
}

async function bootSolPrice() {
    const snapshot = await restoreBadgeFromCache();
    // alarms 最快 1 分钟一次；service worker 因为别的事件被唤醒时顺手补一次，能让价格更跟手
    const isFresh = snapshot && Date.now() - snapshot.updatedAt < SOL_REFRESH_MINUTES * 60 * 1000;
    if (!isFresh) await refreshSolPrice();
}

chrome.alarms.create(SOL_ALARM_NAME, {
    periodInMinutes: SOL_REFRESH_MINUTES,
    delayInMinutes: SOL_REFRESH_MINUTES,
});

chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name !== SOL_ALARM_NAME) return;
    refreshSolPrice();
});

// 装好、浏览器启动、以及 service worker 每次冷启动都过一遍
chrome.runtime.onInstalled.addListener(function () {
    bootSolPrice();
});
chrome.runtime.onStartup.addListener(function () {
    bootSolPrice();
});
bootSolPrice();

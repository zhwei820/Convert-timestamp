// 每天 9:15 在后台打开 uhook，让 uhook-token.js 抓到新 token 上报后再关掉。仅 Edge。
// 浏览器没开 / 机器睡眠会错过 alarm，所以每次 service worker 启动也补检一次「今天 9:15 后开过没有」。
const UHOOK_DAILY_ALARM = "uhook-daily-open";
const UHOOK_DAILY_URL = "https://uhook-v2.matrixport.io/";
const UHOOK_DAILY_HOUR = 9;
const UHOOK_DAILY_MINUTE = 15;
const UHOOK_IS_EDGE = /\bEdg\//.test(navigator.userAgent);

function uhookDailyTime(now) {
    const d = new Date(now);
    d.setHours(UHOOK_DAILY_HOUR, UHOOK_DAILY_MINUTE, 0, 0);
    return d;
}

function uhookDateKey(d) {
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

async function uhookDailyMaybeOpen() {
    const now = new Date();
    if (now < uhookDailyTime(now)) return;
    const today = uhookDateKey(now);
    const r = await chrome.storage.local.get("uhookDailyLastOpen");
    if (r.uhookDailyLastOpen === today) return;
    await chrome.storage.local.set({ uhookDailyLastOpen: today });
    const tab = await chrome.tabs.create({ url: UHOOK_DAILY_URL, active: false });
    await chrome.storage.session.set({ uhookDailyTabId: tab.id });
}

// 只关自己打开的那个标签，用户手动开的不动
async function uhookDailyCloseIfOurs(sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) return;
    const r = await chrome.storage.session.get("uhookDailyTabId");
    if (r.uhookDailyTabId !== tabId) return;
    await chrome.storage.session.remove("uhookDailyTabId");
    chrome.tabs.remove(tabId).catch(function () {});
}

if (UHOOK_IS_EDGE) {
    const now = new Date();
    const next = uhookDailyTime(now);
    if (next <= now) next.setDate(next.getDate() + 1);
    chrome.alarms.create(UHOOK_DAILY_ALARM, { when: next.getTime(), periodInMinutes: 24 * 60 });
    chrome.alarms.onAlarm.addListener(function (alarm) {
        if (alarm.name === UHOOK_DAILY_ALARM) uhookDailyMaybeOpen();
    });
    uhookDailyMaybeOpen();
} else {
    chrome.alarms.clear(UHOOK_DAILY_ALARM);
}

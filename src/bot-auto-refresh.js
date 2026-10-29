/**
 * 交易 bot 面板自动刷新：在 http://192.168.5.97:8081/trade 上每 10 秒点一次
 * "Auto Refresh all bots now" 按钮。
 *
 * 页面是 SPA，manifest 按整个 host 注入，每次 tick 再判断当前路径，
 * 这样从别的路由切到 /trade 也能生效；按钮每次重新查找，以免组件重渲染后引用失效。
 */
(function () {
    "use strict";

    if (window.__botAutoRefreshLoaded) {
        return;
    }
    window.__botAutoRefreshLoaded = true;

    const INTERVAL_MS = 10000;
    const BUTTON_SELECTOR = 'button[title="Auto Refresh all bots now"]';

    setInterval(function () {
        if (!location.pathname.startsWith("/trade")) {
            return;
        }
        const btn = document.querySelector(BUTTON_SELECTOR);
        if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
            btn.click();
        }
    }, INTERVAL_MS);
})();

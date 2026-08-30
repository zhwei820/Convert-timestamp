/**
 * DevTools 入口页脚本（页面本身不可见）
 *
 * 只做一件事：在 DevTools 里注册「请求复制」面板。
 * 面板逻辑全部在 devtools-panel.html / devtools-panel.js 里。
 */
(function () {
    "use strict";

    chrome.devtools.panels.create(
        "请求复制",
        null,
        "devtools-panel.html"
    );
})();

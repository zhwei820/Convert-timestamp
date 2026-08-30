/**
 * DevTools 入口页脚本（页面本身不可见）
 *
 * 只做一件事：在 DevTools 里注册「请求复制」面板。
 * 面板逻辑全部在 devtools-panel.html / devtools-panel.js 里。
 */
(function () {
    "use strict";

    // iconPath 传空串表示不要图标（该参数在 API schema 里是必填的 string，不能传 null）
    chrome.devtools.panels.create(
        "请求复制",
        "",
        "devtools-panel.html"
    );
})();

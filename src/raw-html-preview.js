/**
 * Raw HTML 预览按钮
 *
 * 在 GitHub / GitLab 直接返回 HTML 源码（text/plain）的 raw 链接上，
 * 注入一个浮动按钮，点击后把当前文档替换成渲染后的页面。
 *
 * 适配 URL 形如：
 *   - https://gitlab.*.com/<group>/<project>/-/raw/<ref>/<path>.html
 *   - https://github.com/<owner>/<repo>/raw/<ref>/<path>.html
 *   - https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.html
 */
(function () {
    "use strict";

    if (window.__rawHtmlPreviewLoaded) {
        return;
    }
    window.__rawHtmlPreviewLoaded = true;

    const BTN_ID = "__convert_timestamp_raw_html_preview_btn__";

    function isRawHtmlUrl() {
        const host = location.hostname;
        const path = location.pathname;
        const isHtmlExt = /\.html?(?:$|[?#])/i.test(path);
        if (!isHtmlExt) {
            return false;
        }
        if (host === "raw.githubusercontent.com") {
            return true;
        }
        if (host === "github.com" && /\/raw\//.test(path)) {
            return true;
        }
        if (/^gitlab\.[^.]+\.com$/i.test(host) && /\/-\/raw\//.test(path)) {
            return true;
        }
        return false;
    }

    function extractRawHtml() {
        // GitLab/GitHub 把 text/plain 内容包在 <pre> 中
        const pre = document.body && document.body.querySelector("pre");
        if (pre && pre.textContent) {
            return pre.textContent;
        }
        // 兜底：直接拿 body 的纯文本
        return document.body ? document.body.innerText || "" : "";
    }

    function looksLikeHtml(text) {
        if (!text) return false;
        const head = text.trimStart().slice(0, 200).toLowerCase();
        return head.startsWith("<!doctype") || head.startsWith("<html") || /<[a-z!]/.test(head);
    }

    function renderHtml(html) {
        try {
            document.open("text/html", "replace");
            document.write(html);
            document.close();
        } catch (e) {
            console.warn("[raw-html-preview] render failed:", e);
            alert("渲染失败：" + (e && e.message ? e.message : e));
        }
    }

    function injectButton() {
        if (document.getElementById(BTN_ID)) {
            return;
        }
        const btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.type = "button";
        btn.textContent = "预览 HTML";
        btn.title = "把当前 raw 源码渲染成网页";
        btn.style.cssText = [
            "position:fixed",
            "top:12px",
            "right:12px",
            "z-index:2147483647",
            "padding:8px 14px",
            "background:#1f6feb",
            "color:#fff",
            "border:none",
            "border-radius:6px",
            "font:600 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "cursor:pointer",
            "box-shadow:0 2px 8px rgba(0,0,0,0.25)",
        ].join(";");
        btn.addEventListener("click", function () {
            const raw = extractRawHtml();
            if (!looksLikeHtml(raw)) {
                alert("未识别到 HTML 内容，无法预览。");
                return;
            }
            renderHtml(raw);
        });
        (document.body || document.documentElement).appendChild(btn);
    }

    function init() {
        if (!isRawHtmlUrl()) {
            return;
        }
        if (document.body) {
            injectButton();
        } else {
            document.addEventListener("DOMContentLoaded", injectButton, { once: true });
        }
    }

    init();
})();

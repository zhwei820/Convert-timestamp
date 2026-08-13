/**
 * Raw 文件预览按钮
 *
 * 在 GitHub / GitLab 直接返回源码（text/plain）的 raw 链接上，
 * 注入一个浮动按钮，点击后把当前文档替换成渲染后的页面。
 *   - .html / .htm → 原样渲染成网页
 *   - .md / .markdown → 渲染成排版后的文档
 *
 * 适配 URL 形如：
 *   - https://gitlab.*.com/<group>/<project>/-/raw/<ref>/<path>.md
 *   - https://github.com/<owner>/<repo>/raw/<ref>/<path>.html
 *   - https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>.md
 */
(function () {
    "use strict";

    if (window.__rawHtmlPreviewLoaded) {
        return;
    }
    window.__rawHtmlPreviewLoaded = true;

    const BTN_ID = "__convert_timestamp_raw_html_preview_btn__";
    const core = window.__textPreviewCore;

    function isRawHost() {
        const host = location.hostname;
        const path = location.pathname;
        if (host === "raw.githubusercontent.com") {
            return true;
        }
        if (host === "github.com" && /\/raw\//.test(path)) {
            return true;
        }
        // 自建 GitLab 域名各异，/-/raw/ 是可靠特征
        if (/\/-\/raw\//.test(path)) {
            return true;
        }
        return false;
    }

    /** 返回 "html" | "markdown" | null */
    function getRawKind() {
        if (!isRawHost()) {
            return null;
        }
        const path = location.pathname;
        if (/\.html?(?:$|[?#])/i.test(path)) {
            return "html";
        }
        if (/\.(?:md|markdown)(?:$|[?#])/i.test(path)) {
            return "markdown";
        }
        return null;
    }

    function getFileName() {
        const parts = location.pathname.split("/");
        const name = parts[parts.length - 1] || "";
        try {
            return decodeURIComponent(name);
        } catch (e) {
            return name;
        }
    }

    function extractRawText() {
        // GitLab/GitHub 把 text/plain 内容包在 <pre> 中
        const pre = document.body && document.body.querySelector("pre");
        if (pre && pre.textContent) {
            return pre.textContent;
        }
        // 兜底：直接拿 body 的纯文本
        return document.body ? document.body.innerText || "" : "";
    }

    function render(kind) {
        const raw = extractRawText();
        if (!raw || !raw.trim()) {
            alert("未能提取到文件内容，无法预览。");
            return;
        }
        try {
            if (kind === "html") {
                if (!core.looksLikeHtml(raw)) {
                    alert("未识别到 HTML 内容，无法预览。");
                    return;
                }
                // HTML 原样渲染；用 blob: 跳转以避开 GitLab/GitHub 的 CSP
                // （document.write 会复用当前 origin，内联 <script> 会被拦截）
                core.replaceCurrentPage(raw);
                return;
            }
            core.replaceCurrentPage(core.buildPreviewDocument(raw, getFileName(), { markdown: true }));
        } catch (e) {
            console.warn("[raw-html-preview] render failed:", e);
            alert("渲染失败：" + (e && e.message ? e.message : e));
        }
    }

    function injectButton(kind) {
        if (document.getElementById(BTN_ID)) {
            return;
        }
        const btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.type = "button";
        btn.textContent = kind === "html" ? "预览 HTML" : "预览 Markdown";
        btn.title = kind === "html"
            ? "把当前 raw 源码渲染成网页"
            : `把 ${getFileName()} 渲染为可读文档`;
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
            render(kind);
        });
        (document.body || document.documentElement).appendChild(btn);
    }

    function init() {
        const kind = getRawKind();
        if (!kind) {
            return;
        }
        if (!core) {
            console.warn("[raw-html-preview] text-preview-core 未加载");
            return;
        }
        if (document.body) {
            injectButton(kind);
        } else {
            document.addEventListener("DOMContentLoaded", function () {
                injectButton(kind);
            }, { once: true });
        }
    }

    init();
})();

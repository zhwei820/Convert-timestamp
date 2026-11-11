/**
 * GitHub / GitLab 文件预览按钮
 *
 * raw 页（text/plain 源码）：
 *   - .html / .htm → 渲染成网页（相对路径的 js/css 内联进来）
 *   - .md / .markdown → 渲染成排版后的文档
 * blob 页（仓库文件浏览页）：仅 .html / .htm，从对应 raw 地址抓源码后渲染。
 *
 * 适配 URL 形如：
 *   - https://gitlab.*.com/<group>/<project>/-/raw/<ref>/<path>.md
 *   - https://gitlab.*.com/<group>/<project>/-/blob/<ref>/<path>.html
 *   - https://github.com/<owner>/<repo>/raw/<ref>/<path>.html
 *   - https://github.com/<owner>/<repo>/blob/<ref>/<path>.html
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

    /** blob 页对应的 raw 地址；ref 与路径结构不变，相对资源可直接按它解析 */
    function getBlobRawUrl() {
        const path = location.pathname;
        if (location.hostname === "github.com" && /^\/[^/]+\/[^/]+\/blob\//.test(path)) {
            return location.origin + path.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/raw/");
        }
        if (/\/-\/blob\//.test(path)) {
            return location.origin + path.replace("/-/blob/", "/-/raw/");
        }
        return null;
    }

    /** 返回 "html" | "markdown" | "blob-html" | null */
    function getRawKind() {
        const path = location.pathname;
        const isHtml = /\.html?$/i.test(path);
        if (isRawHost()) {
            if (isHtml) {
                return "html";
            }
            if (/\.(?:md|markdown)$/i.test(path)) {
                return "markdown";
            }
            return null;
        }
        if (isHtml && getBlobRawUrl()) {
            return "blob-html";
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

    async function renderBlobHtml(btn) {
        const rawUrl = getBlobRawUrl();
        btn.disabled = true;
        btn.textContent = "加载中…";
        try {
            const html = await core.bundleHtml(await core.fetchText(rawUrl), rawUrl);
            // assign 而非 replace：Back 能回到仓库页
            location.assign(URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" })));
        } catch (e) {
            console.warn("[raw-html-preview] blob render failed:", e);
            alert("渲染失败：" + (e && e.message ? e.message : e));
        } finally {
            btn.disabled = false;
            btn.textContent = "预览 HTML";
        }
    }

    async function render(kind, btn) {
        if (kind === "blob-html") {
            return renderBlobHtml(btn);
        }
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
                core.replaceCurrentPage(await core.bundleHtml(raw, location.href));
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
        btn.dataset.kind = kind;
        btn.type = "button";
        const isHtml = kind !== "markdown";
        btn.textContent = isHtml ? "预览 HTML" : "预览 Markdown";
        btn.title = isHtml
            ? "把 HTML 源码渲染成网页（相对路径的 js/css 一并加载）"
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
            render(kind, btn);
        });
        (document.body || document.documentElement).appendChild(btn);
    }

    function sync() {
        const kind = getRawKind();
        const existing = document.getElementById(BTN_ID);
        if (existing && existing.dataset.kind !== kind) {
            existing.remove();
        }
        if (kind && document.body) {
            injectButton(kind);
        }
    }

    function init() {
        if (!core) {
            console.warn("[raw-html-preview] text-preview-core 未加载");
            return;
        }
        sync();
        // GitHub / GitLab 的仓库浏览是站内路由切换，不会重新注入 content script
        if (!isRawHost()) {
            let lastHref = location.href;
            setInterval(function () {
                if (location.href !== lastHref) {
                    lastHref = location.href;
                    sync();
                }
            }, 800);
        }
    }

    init();
})();

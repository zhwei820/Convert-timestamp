/**
 * Slack 文件友好预览按钮
 *
 * 在 Slack 文件页面上注入一个浮动按钮，
 * 点击后把原始内容渲染成更易读的页面（Markdown 渲染、HTML 直接渲染等）。
 *
 * 适配 URL 形如：
 *   - https://files.slack.com/files-pri/<team>-<file>/<name>
 *   - https://slack-files.com/files-pri-safe/<team>-<file>/<name>?c=...
 *     （.html 走 files-pri-safe 时 Slack 以纯文本下发，浏览器只显示源码）
 */
(function () {
    "use strict";

    if (window.__slackFilePreviewLoaded) return;
    window.__slackFilePreviewLoaded = true;

    const BTN_ID = "__slack_file_preview_btn__";
    const core = window.__textPreviewCore;

    function isSlackFilePage() {
        const host = location.hostname;
        const path = location.pathname;
        return (
            (host === "files.slack.com" || host === "slack-files.com") &&
            /^\/files-pri(-safe)?\//.test(path)
        );
    }

    function getFileName() {
        // location.pathname 不含 ?query，直接取最后一段即可
        const parts = location.pathname.split("/");
        let name = parts[parts.length - 1] || "";
        try {
            name = decodeURIComponent(name);
        } catch (e) {
            // 保持原样
        }
        return name;
    }

    function isTextFile(filename) {
        const ext = filename.split(".").pop().toLowerCase();
        return [
            "md", "markdown", "txt", "text",
            "json", "yaml", "yml", "xml",
            "js", "ts", "jsx", "tsx",
            "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp",
            "css", "scss", "less",
            "sh", "bash", "zsh",
            "log", "cfg", "conf", "ini", "toml",
            "csv", "tsv",
            "sql", "graphql",
            "html", "htm",
            "diff", "patch",
        ].includes(ext) || /^[^.]+$/.test(ext); // 无后缀也视为文本
    }

    function extractFileContent() {
        // Slack 文件页面用 <pre> 显示文件内容
        // 找页面中最大的内容型 <pre>（排除消息区域的）
        const pres = document.querySelectorAll("pre");
        let best = null;
        let bestLen = 0;
        for (const pre of pres) {
            const text = pre.textContent;
            if (!text.trim()) continue;
            // 排除聊天消息区域里的 pre（代码块消息）
            if (pre.closest('[class*="message" i]') || pre.closest('[class*="chat" i]') || pre.closest('[data-qa*="message" i]')) {
                continue;
            }
            const len = text.length;
            if (len > bestLen) {
                bestLen = len;
                best = text;
            }
        }
        if (best) return best;

        // 兜底：纯文本文档（slack-files.com 把 .html 以 text/plain 下发）
        // 某些情况下浏览器不会包 <pre>，直接取 body 文本
        if (document.contentType && document.contentType.indexOf("text/") === 0 && document.contentType !== "text/html") {
            return (document.body && (document.body.innerText || document.body.textContent)) || null;
        }
        return null;
    }

    function renderPreview(content, filename) {
        try {
            if (core.isHtmlFile(filename)) {
                if (!core.looksLikeHtml(content)) {
                    alert("未识别到 HTML 内容，无法预览。");
                    return;
                }
                // HTML 文件直接原样渲染，而不是展示转义后的源码
                core.openInNewTab(content);
                return;
            }
            core.openInNewTab(core.buildPreviewDocument(content, filename));
        } catch (e) {
            console.warn("[slack-file-preview] render failed:", e);
            alert("渲染失败：" + (e && e.message ? e.message : e));
        }
    }

    function injectButton() {
        if (document.getElementById(BTN_ID)) return;

        const filename = getFileName();
        if (!isTextFile(filename)) return;

        const isHtml = core.isHtmlFile(filename);
        const btn = document.createElement("button");
        btn.id = BTN_ID;
        btn.type = "button";
        btn.textContent = isHtml ? "🌐 渲染 HTML" : "📄 友好预览";
        btn.title = isHtml
            ? `将 ${filename} 源码渲染成网页`
            : `将 ${filename} 渲染为可读页面`;
        btn.style.cssText = [
            "position:fixed",
            "top:12px",
            "right:12px",
            "z-index:2147483647",
            "padding:10px 18px",
            "background:#1264a3",
            "color:#fff",
            "border:none",
            "border-radius:8px",
            "font:600 14px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "cursor:pointer",
            "box-shadow:0 4px 12px rgba(0,0,0,0.2)",
            "transition:transform 0.15s,box-shadow 0.15s",
            "letter-spacing:0.3px",
        ].join(";");

        btn.addEventListener("mouseenter", () => {
            btn.style.transform = "translateY(-1px)";
            btn.style.boxShadow = "0 6px 16px rgba(0,0,0,0.25)";
        });
        btn.addEventListener("mouseleave", () => {
            btn.style.transform = "";
            btn.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
        });

        btn.addEventListener("click", () => {
            const content = extractFileContent();
            if (!content || !content.trim()) {
                alert("未能提取到文件内容。\n\n请确认页面已完全加载，且文件是文本类型。");
                return;
            }
            renderPreview(content, filename);
        });

        (document.body || document.documentElement).appendChild(btn);
    }

    function init() {
        if (!isSlackFilePage()) return;
        if (!core) {
            console.warn("[slack-file-preview] text-preview-core 未加载");
            return;
        }
        const filename = getFileName();
        if (!isTextFile(filename)) return;

        // 等待页面内容加载
        const tryInject = () => {
            const content = extractFileContent();
            if (content && content.trim()) {
                injectButton();
            } else {
                // 内容还没渲染，轮询等待
                setTimeout(tryInject, 1000);
            }
        };

        if (document.body) {
            setTimeout(tryInject, 1500);
        } else {
            document.addEventListener("DOMContentLoaded", () => setTimeout(tryInject, 1500), { once: true });
        }

        // 最长等待 15 秒
        let waited = 0;
        const pollTimer = setInterval(() => {
            waited += 1000;
            if (document.getElementById(BTN_ID)) {
                clearInterval(pollTimer);
                return;
            }
            if (waited >= 15000) {
                clearInterval(pollTimer);
                // 超时后仍尝试注入按钮（可能内容提取失败但按钮给用户手动尝试的机会）
                const filename = getFileName();
                if (isTextFile(filename) && !document.getElementById(BTN_ID)) {
                    injectButton();
                }
            }
        }, 1000);
    }

    init();
})();

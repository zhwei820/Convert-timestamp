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

    function isMarkdownFile(filename) {
        const ext = filename.split(".").pop().toLowerCase();
        return ext === "md" || ext === "markdown";
    }

    function isHtmlFile(filename) {
        const ext = filename.split(".").pop().toLowerCase();
        return ext === "html" || ext === "htm";
    }

    function looksLikeHtml(text) {
        if (!text) return false;
        const head = text.trimStart().slice(0, 200).toLowerCase();
        return head.startsWith("<!doctype") || head.startsWith("<html") || /<[a-z!]/.test(head);
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

    function simpleMarkdownRender(text) {
        // 基本的 Markdown → HTML 转换
        let html = text
            // 转义 HTML 特殊字符（避免 XSS）
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            // 代码块 (```)
            .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
                const langClass = lang ? ` class="lang-${lang}"` : "";
                return `<pre${langClass}><code>${code.trim()}</code></pre>`;
            })
            // 行内代码 (`)
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            // 标题 (###)
            .replace(/^### (.+)$/gm, "<h3>$1</h3>")
            .replace(/^## (.+)$/gm, "<h2>$1</h2>")
            .replace(/^# (.+)$/gm, "<h1>$1</h1>")
            // 加粗 ** ** 或 __ __
            .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
            .replace(/__(.+?)__/g, "<strong>$1</strong>")
            // 斜体 * * 或 _ _
            .replace(/\*(.+?)\*/g, "<em>$1</em>")
            .replace(/_(.+?)_/g, "<em>$1</em>")
            // 删除线 ~~ ~~
            .replace(/~~(.+?)~~/g, "<del>$1</del>")
            // 链接 [text](url)
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            // 无序列表
            .replace(/^[\s]*[-*+] (.+)$/gm, "<li>$1</li>")
            // 有序列表
            .replace(/^[\s]*\d+\. (.+)$/gm, "<li>$1</li>")
            // 水平线
            .replace(/^---$/gm, "<hr>")
            .replace(/^\*\*\*$/gm, "<hr>")
            // 表格 (pipe tables)
            .replace(/^\|(.+)\|\n\|([-| :]+)\|\n((?:\|.+\|(?:\n|$))*)/gm, (_m, hRow, _s, bRows) => {
                const headers = hRow.split("|").filter(c => c.trim()).map(h => `<th>${h.trim()}</th>`).join("");
                const rows = bRows.trim().split("\n").map(row => {
                    const cells = row.split("|").filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join("");
                    return `<tr>${cells}</tr>`;
                }).join("");
                return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
            })
            // 段落（双换行）
            .replace(/\n\n/g, "</p><p>")
            // 换行
            .replace(/\n/g, "<br>");

        // 给连续 <li> 包裹 <ul>/<ol>
        html = html.replace(/((?:<li>.*?<\/li><br>?)+)/g, "<ul>$1</ul>");

        return `<p>${html}</p>`;
    }

    function getPreviewHtml(content, filename) {
        const isMd = isMarkdownFile(filename);
        const bodyHtml = isMd
            ? simpleMarkdownRender(content)
            : `<pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.5 Menlo,Consolas,monospace;background:#f5f5f5;padding:16px;border-radius:8px;overflow-x:auto;">${content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</pre>`;

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Preview: ${filename}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif;background:#fff;color:#1d1c1d;line-height:1.6;padding:32px 24px;max-width:960px;margin:0 auto}
h1{font-size:28px;margin:24px 0 12px;border-bottom:1px solid #e8e8e8;padding-bottom:8px}
h2{font-size:22px;margin:20px 0 10px}
h3{font-size:18px;margin:16px 0 8px}
p{margin:8px 0}
a{color:#1264a3;text-decoration:none}
a:hover{text-decoration:underline}
code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:0.9em}
pre{background:#f5f5f5;padding:12px 16px;border-radius:6px;overflow-x:auto;margin:12px 0}
pre code{background:none;padding:0}
ul,ol{margin:8px 0;padding-left:24px}
li{margin:4px 0}
hr{border:none;border-top:1px solid #e0e0e0;margin:20px 0}
blockquote{border-left:4px solid #ddd;margin:12px 0;padding:4px 16px;color:#555}
table{border-collapse:collapse;margin:12px 0;width:100%}
th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}
th{background:#f5f5f5}
.header{display:flex;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:16px;border-bottom:2px solid #1264a3}
.header h1{font-size:20px;margin:0;border:none;padding:0;color:#1264a3}
.header .meta{font-size:13px;color:#888}
.alert{margin:24px 0;padding:12px 16px;border-radius:6px;background:#fff3e0;border:1px solid #ffc107;font-size:14px}
</style>
</head>
<body>
<div class="header">
<h1>${filename}</h1>
<span class="meta">${isMd ? "Markdown" : "Text"} · ${content.length} 字符</span>
</div>
<div class="body">
${bodyHtml}
</div>
</body>
</html>`;
    }

    function openAsBlob(html) {
        // 用 blob: URL 打开新标签页，避开当前页面的 CSP（内联 <script> 会被拦截）
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
    }

    function renderPreview(content, filename) {
        try {
            if (isHtmlFile(filename)) {
                if (!looksLikeHtml(content)) {
                    alert("未识别到 HTML 内容，无法预览。");
                    return;
                }
                // HTML 文件直接原样渲染，而不是展示转义后的源码
                openAsBlob(content);
                return;
            }
            openAsBlob(getPreviewHtml(content, filename));
        } catch (e) {
            console.warn("[slack-file-preview] render failed:", e);
            alert("渲染失败：" + (e && e.message ? e.message : e));
        }
    }

    function injectButton() {
        if (document.getElementById(BTN_ID)) return;

        const filename = getFileName();
        if (!isTextFile(filename)) return;

        const isHtml = isHtmlFile(filename);
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

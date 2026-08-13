/**
 * 文本预览核心（Markdown 渲染 + 预览页壳）
 *
 * 由 raw-html-preview.js / slack-file-preview.js 共用，
 * 通过 window.__textPreviewCore 暴露，必须在两者之前注入。
 */
(function () {
    "use strict";

    if (window.__textPreviewCore) return;

    // 行内代码占位符用的哨兵字符，正常文本不会出现
    const SENTINEL = "\u0000";

    // 允许在 Markdown 里直接书写的行内标签（PRD 表格常用 <br>）
    const INLINE_TAG_WHITELIST = /&lt;(\/?)(br|b|strong|i|em|u|s|del|code|sub|sup|kbd|mark)\s*\/?&gt;/gi;

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function sanitizeUrl(url) {
        const u = String(url).trim();
        if (/^(javascript|vbscript):/i.test(u)) return "#";
        if (/^data:/i.test(u) && !/^data:image\//i.test(u)) return "#";
        return u;
    }

    function renderInline(text) {
        const codes = [];
        let out = escapeHtml(text);

        // 行内代码先抽成占位，避免内部内容被后续规则改写
        out = out.replace(/(`+)([\s\S]*?)\1/g, (_m, _fence, code) => {
            codes.push(code.replace(/^ (.*) $/, "$1"));
            return SENTINEL + (codes.length - 1) + SENTINEL;
        });

        out = out
            // 图片 ![alt](url)
            .replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g,
                (_m, alt, url) => `<img src="${sanitizeUrl(url)}" alt="${alt}" loading="lazy">`)
            // 链接 [text](url)
            .replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g,
                (_m, label, url) => `<a href="${sanitizeUrl(url)}" target="_blank" rel="noopener">${label}</a>`)
            // 裸链接（排除已经落在 href="..." 里的）
            .replace(/(^|[\s(【（])(https?:\/\/[^\s<>()"'【】（）]+)/g,
                (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
            // 加粗
            .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, "$1<strong>$2</strong>")
            // 删除线
            .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
            // 斜体：`_` 只在非单词边界成对时生效，避免 snake_case_name 被拆开
            .replace(/\*(?=\S)([^*]*?\S)\*/g, "<em>$1</em>")
            .replace(/(^|[^\w*])_(?=\S)([^_]*?\S)_(?![\w])/g, "$1<em>$2</em>");

        // 放行少量安全的行内标签
        out = out.replace(INLINE_TAG_WHITELIST, (_m, slash, tag) => `<${slash}${tag.toLowerCase()}>`);

        return out.replace(new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g"),
            (_m, idx) => `<code>${codes[Number(idx)]}</code>`);
    }

    const RE_FENCE = /^ {0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
    const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
    const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
    const RE_QUOTE = /^ {0,3}>\s?/;
    const RE_LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;
    const RE_TABLE_ROW = /^\s*\|/;

    function isTableDelimiter(line) {
        if (!line || line.indexOf("|") < 0) return false;
        const cells = splitTableRow(line);
        return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
    }

    function splitTableRow(row) {
        let s = row.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (/\|$/.test(s) && !/\\\|$/.test(s)) s = s.slice(0, -1);
        return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    }

    function alignOf(cell) {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return "";
    }

    function isBlockStart(line) {
        return RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) ||
            RE_QUOTE.test(line) || RE_LIST_ITEM.test(line) || RE_TABLE_ROW.test(line);
    }

    function buildList(items) {
        let idx = 0;

        function build() {
            const baseIndent = items[idx].indent;
            const type = items[idx].type;
            let html = "<" + type + ">";
            while (idx < items.length && items[idx].indent >= baseIndent) {
                if (items[idx].indent > baseIndent) {
                    // 兜底：首项就比基准更深时不至于死循环
                    html += build();
                    continue;
                }
                if (items[idx].type !== type) break;
                const item = items[idx++];
                const task = item.lines[0].match(/^\[([ xX])\]\s+(.*)$/);
                const head = task
                    ? `<input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${renderInline(task[2])}`
                    : renderInline(item.lines[0]);
                const rendered = [head].concat(item.lines.slice(1).map(renderInline)).join("<br>");
                html += (task ? '<li class="task">' : "<li>") + rendered;
                if (idx < items.length && items[idx].indent > baseIndent) html += build();
                html += "</li>";
            }
            return html + "</" + type + ">";
        }

        let out = "";
        while (idx < items.length) out += build();
        return out;
    }

    function renderMarkdown(text) {
        const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
        const out = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            if (!line.trim()) {
                i++;
                continue;
            }

            // 围栏代码块
            const fence = line.match(RE_FENCE);
            if (fence) {
                const closeRe = fence[1][0] === "`" ? /^ {0,3}```+\s*$/ : /^ {0,3}~~~+\s*$/;
                const buf = [];
                i++;
                while (i < lines.length && !closeRe.test(lines[i])) buf.push(lines[i++]);
                if (i < lines.length) i++; // 吃掉结束围栏
                const cls = fence[2] ? ` class="lang-${escapeHtml(fence[2])}"` : "";
                out.push(`<pre><code${cls}>${escapeHtml(buf.join("\n"))}</code></pre>`);
                continue;
            }

            // 标题
            const heading = line.match(RE_HEADING);
            if (heading) {
                const level = heading[1].length;
                out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
                i++;
                continue;
            }

            // 分割线
            if (RE_HR.test(line)) {
                out.push("<hr>");
                i++;
                continue;
            }

            // 表格
            if (RE_TABLE_ROW.test(line) && isTableDelimiter(lines[i + 1])) {
                const aligns = splitTableRow(lines[i + 1]).map(alignOf);
                const cell = (content, tag, col) => {
                    const style = aligns[col] ? ` style="text-align:${aligns[col]}"` : "";
                    return `<${tag}${style}>${renderInline(content)}</${tag}>`;
                };
                const head = splitTableRow(line).map((c, n) => cell(c, "th", n)).join("");
                i += 2;
                const rows = [];
                while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
                    rows.push(`<tr>${splitTableRow(lines[i]).map((c, n) => cell(c, "td", n)).join("")}</tr>`);
                    i++;
                }
                out.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
                continue;
            }

            // 引用块
            if (RE_QUOTE.test(line)) {
                const buf = [];
                while (i < lines.length && (RE_QUOTE.test(lines[i]) || (buf.length && lines[i].trim() && !isBlockStart(lines[i])))) {
                    buf.push(lines[i].replace(RE_QUOTE, ""));
                    i++;
                }
                out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
                continue;
            }

            // 列表（含嵌套、任务列表）
            if (RE_LIST_ITEM.test(line)) {
                const items = [];
                while (i < lines.length) {
                    const item = lines[i].match(RE_LIST_ITEM);
                    if (item) {
                        items.push({
                            indent: item[1].replace(/\t/g, "    ").length,
                            type: /^\d/.test(item[2]) ? "ol" : "ul",
                            lines: [item[4]],
                        });
                        i++;
                        continue;
                    }
                    if (!lines[i].trim()) {
                        const next = lines[i + 1] || "";
                        if (RE_LIST_ITEM.test(next) || /^\s{2,}\S/.test(next)) {
                            i++;
                            continue;
                        }
                        break;
                    }
                    // 缩进的续行归属上一个列表项
                    if (/^\s{2,}\S/.test(lines[i]) && items.length) {
                        items[items.length - 1].lines.push(lines[i].trim());
                        i++;
                        continue;
                    }
                    break;
                }
                out.push(buildList(items));
                continue;
            }

            // 段落：连续非空行合并，单换行保留为 <br>（中文文档更贴近作者排版）
            const para = [];
            while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
                para.push(lines[i].trim());
                i++;
            }
            if (!para.length) {
                i++;
                continue;
            }
            out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
        }

        return out.join("\n");
    }

    const PREVIEW_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif;background:#fff;color:#1d1c1d;line-height:1.7;padding:32px 24px 96px;max-width:960px;margin:0 auto}
h1,h2,h3,h4,h5,h6{line-height:1.35}
h1{font-size:28px;margin:28px 0 12px;border-bottom:1px solid #e8e8e8;padding-bottom:8px}
h2{font-size:22px;margin:24px 0 10px;border-bottom:1px solid #f0f0f0;padding-bottom:6px}
h3{font-size:18px;margin:20px 0 8px}
h4{font-size:16px;margin:16px 0 6px}
h5,h6{font-size:14px;margin:14px 0 6px;color:#555}
p{margin:10px 0}
a{color:#1264a3;text-decoration:none}
a:hover{text-decoration:underline}
img{max-width:100%}
code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-family:Menlo,Consolas,monospace;font-size:0.88em}
pre{background:#f6f8fa;border:1px solid #eaecef;padding:12px 16px;border-radius:6px;overflow-x:auto;margin:14px 0}
pre code{background:none;padding:0;font-size:13px;line-height:1.55}
ul,ol{margin:10px 0;padding-left:26px}
ul ul,ul ol,ol ul,ol ol{margin:4px 0}
li{margin:4px 0}
li.task{list-style:none;margin-left:-20px}
hr{border:none;border-top:1px solid #e0e0e0;margin:24px 0}
blockquote{border-left:4px solid #d0d7de;margin:14px 0;padding:2px 16px;color:#57606a;background:#f9fafb}
blockquote p{margin:6px 0}
table{border-collapse:collapse;margin:14px 0;width:100%;font-size:14px}
th,td{border:1px solid #d0d7de;padding:8px 12px;text-align:left;vertical-align:top}
th{background:#f6f8fa;white-space:nowrap}
tbody tr:nth-child(even){background:#fbfcfd}
.header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #1264a3}
.header h1{font-size:20px;margin:0;border:none;padding:0;color:#1264a3;word-break:break-all}
.header .meta{font-size:13px;color:#888}
`;

    /** 生成完整的预览页面（Markdown 渲染，其他文本走等宽 <pre>） */
    function buildPreviewDocument(content, filename, options) {
        const opts = options || {};
        const asMarkdown = opts.markdown !== undefined ? opts.markdown : isMarkdownFile(filename);
        const bodyHtml = asMarkdown
            ? renderMarkdown(content)
            : `<pre style="white-space:pre-wrap;word-break:break-word">${escapeHtml(content)}</pre>`;

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Preview: ${escapeHtml(filename)}</title>
<style>${PREVIEW_CSS}</style>
</head>
<body>
<div class="header">
<h1>${escapeHtml(filename)}</h1>
<span class="meta">${asMarkdown ? "Markdown" : "Text"} · ${content.length} 字符${opts.sourceLabel ? " · " + escapeHtml(opts.sourceLabel) : ""}</span>
</div>
<div class="body">
${bodyHtml}
</div>
</body>
</html>`;
    }

    function extOf(filename) {
        const name = String(filename || "");
        const dot = name.lastIndexOf(".");
        return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
    }

    function isMarkdownFile(filename) {
        const ext = extOf(filename);
        return ext === "md" || ext === "markdown";
    }

    function isHtmlFile(filename) {
        const ext = extOf(filename);
        return ext === "html" || ext === "htm";
    }

    function looksLikeHtml(text) {
        if (!text) return false;
        const head = text.trimStart().slice(0, 200).toLowerCase();
        return head.startsWith("<!doctype") || head.startsWith("<html") || /<[a-z!]/.test(head);
    }

    /** blob: URL 可以绕开宿主页面的 CSP（内联 <script> 会被拦截） */
    function toBlobUrl(html) {
        return URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    }

    function openInNewTab(html) {
        window.open(toBlobUrl(html), "_blank");
    }

    function replaceCurrentPage(html) {
        location.replace(toBlobUrl(html));
    }

    window.__textPreviewCore = {
        escapeHtml: escapeHtml,
        renderInline: renderInline,
        renderMarkdown: renderMarkdown,
        buildPreviewDocument: buildPreviewDocument,
        extOf: extOf,
        isMarkdownFile: isMarkdownFile,
        isHtmlFile: isHtmlFile,
        looksLikeHtml: looksLikeHtml,
        openInNewTab: openInNewTab,
        replaceCurrentPage: replaceCurrentPage,
    };
})();

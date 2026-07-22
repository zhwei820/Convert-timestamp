/**
 * CSV / TSV 解析 + HTML 表格生成（无第三方依赖）
 *
 * 暴露到 window.__csvUtils：
 *   - parseCsv(text, delimiter?)  → rows[][]
 *   - detectDelimiter(text)       → "," | "\t" | ";" | "|"
 *   - renderTableHtml(rows)       → 表格片段 HTML 字符串
 *   - buildViewerHtml(rows, meta) → 完整独立 HTML 文档字符串
 */
(function (root) {
    "use strict";

    function detectDelimiter(text) {
        const sample = text.slice(0, 4096);
        const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
        let inQuotes = false;
        for (let i = 0; i < sample.length; i++) {
            const c = sample[i];
            if (c === '"') {
                inQuotes = !inQuotes;
                continue;
            }
            if (inQuotes) continue;
            if (c in counts) counts[c]++;
        }
        let best = ",";
        let bestN = -1;
        for (const [k, v] of Object.entries(counts)) {
            if (v > bestN) {
                bestN = v;
                best = k;
            }
        }
        return best;
    }

    function parseCsv(text, delimiter) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
        delimiter = delimiter || detectDelimiter(text);

        const rows = [];
        let row = [];
        let field = "";
        let inQuotes = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (inQuotes) {
                if (c === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += c;
                }
                continue;
            }
            if (c === '"') {
                inQuotes = true;
            } else if (c === delimiter) {
                row.push(field);
                field = "";
            } else if (c === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            } else if (c === "\r") {
                // 与后续 \n 合并处理；\r 单独出现时也视为换行
                if (text[i + 1] !== "\n") {
                    row.push(field);
                    rows.push(row);
                    row = [];
                    field = "";
                }
            } else {
                field += c;
            }
        }
        if (field.length || row.length) {
            row.push(field);
            rows.push(row);
        }
        return rows;
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function renderTableHtml(rows) {
        if (!rows || rows.length === 0) {
            return '<p class="empty">（空文件）</p>';
        }
        const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
        const header = rows[0];
        const body = rows.slice(1);
        const th = [];
        for (let i = 0; i < colCount; i++) {
            th.push(`<th><span class="idx">${i + 1}</span> ${escapeHtml(header[i] || "")}</th>`);
        }
        const tr = body.map((r, ri) => {
            const tds = [];
            for (let i = 0; i < colCount; i++) {
                tds.push(`<td>${escapeHtml(r[i] || "")}</td>`);
            }
            return `<tr><td class="rownum">${ri + 2}</td>${tds.join("")}</tr>`;
        });
        return `<table class="csv-table">
<thead><tr><th class="rownum">#</th>${th.join("")}</tr></thead>
<tbody>${tr.join("")}</tbody>
</table>`;
    }

    function buildViewerHtml(rows, meta) {
        meta = meta || {};
        const filename = meta.filename || "CSV Preview";
        const delimiter = meta.delimiter || "";
        const rowCount = rows.length;
        const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
        const table = renderTableHtml(rows);
        const delimLabel = delimiter === "\t" ? "TAB" : delimiter;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(filename)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans SC',sans-serif;background:#f7f8fa;color:#1d1c1d}
.header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e5e7eb;padding:12px 20px;display:flex;align-items:center;gap:16px;z-index:10;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.header h1{margin:0;font-size:16px;color:#1264a3;font-weight:600}
.header .meta{font-size:13px;color:#666;display:flex;gap:14px}
.header .meta span b{color:#333;font-weight:600}
.wrap{padding:16px 20px 32px;overflow-x:auto}
.csv-table{border-collapse:collapse;font:13px/1.5 Menlo,Consolas,monospace;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.06);border-radius:6px;overflow:hidden}
.csv-table{table-layout:auto}
.csv-table th,.csv-table td{border:1px solid #e5e7eb;padding:6px 10px;text-align:left;vertical-align:top;white-space:pre-wrap;word-break:break-word;min-width:120px;max-width:200px}
.csv-table td.rownum,.csv-table th.rownum{min-width:0}
.csv-table thead th{background:#f0f4f8;color:#1264a3;font-weight:600;position:sticky;top:53px;z-index:5}
.csv-table th .idx{display:inline-block;min-width:20px;color:#9aa;font-weight:400;margin-right:4px}
.csv-table td.rownum,.csv-table th.rownum{background:#fafbfc;color:#9aa;text-align:right;font-weight:400;position:sticky;left:0;z-index:4}
.csv-table thead th.rownum{z-index:6}
.csv-table tbody tr:hover td{background:#fffbea}
.csv-table tbody tr:hover td.rownum{background:#fff3c4}
.empty{color:#888;padding:40px;text-align:center}
</style>
</head>
<body>
<div class="header">
<h1>${escapeHtml(filename)}</h1>
<div class="meta">
<span>行数 <b>${rowCount}</b></span>
<span>列数 <b>${colCount}</b></span>
<span>分隔符 <b>${escapeHtml(delimLabel)}</b></span>
</div>
</div>
<div class="wrap">${table}</div>
</body>
</html>`;
    }

    root.__csvUtils = { parseCsv, detectDelimiter, renderTableHtml, buildViewerHtml, escapeHtml };
})(typeof window !== "undefined" ? window : globalThis);

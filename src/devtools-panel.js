/**
 * DevTools「请求复制」面板
 *
 * 解决的问题：DevTools 原生的 Copy 菜单里请求和响应是分开的两条，
 * 想把「完整链接 + Query 参数 + 请求体 + 响应体」一次性贴出去得手工拼。
 *
 * 面板监听 chrome.devtools.network，选中一条（或多条）请求后
 * 按 Markdown / JSON 拼成一段文本，一键写进剪贴板。
 * 响应体通过 entry.getContent() 懒加载，不预先占内存。
 */
(function () {
    "use strict";

    const MAX_ENTRIES = 500;              // 列表最多保留的请求数，超出丢弃最旧的
    const MAX_BODY = 200 * 1024;          // 单个 body 的复制上限，超出截断
    const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token)$/i;
    const XHR_TYPES = { xhr: true, fetch: true };

    const els = {
        filter: document.getElementById("filterInput"),
        xhrOnly: document.getElementById("xhrOnly"),
        preserveLog: document.getElementById("preserveLog"),
        withHeaders: document.getElementById("withHeaders"),
        format: document.getElementById("formatSel"),
        clearBtn: document.getElementById("clearBtn"),
        count: document.getElementById("countEl"),
        list: document.getElementById("listEl"),
        copyBtn: document.getElementById("copyBtn"),
        hint: document.getElementById("detailHint"),
        preview: document.getElementById("previewEl"),
        toast: document.getElementById("toast"),
    };

    const state = {
        items: [],            // { id, entry, contentPromise }
        selected: [],         // id 数组，保持点选顺序
        seq: 0,
        renderToken: 0,       // 防止慢的 getContent 回来后覆盖新的选择
        listQueued: false,
    };

    /* ---------------- 工具 ---------------- */

    function esc(s) {
        return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    }

    function safeUrl(url) {
        try {
            return new URL(url);
        } catch (e) {
            return null;
        }
    }

    function fromBase64(b64) {
        try {
            const bin = atob(b64);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            return new TextDecoder("utf-8").decode(bytes);
        } catch (e) {
            return "";
        }
    }

    function clip(text) {
        if (text.length <= MAX_BODY) {
            return text;
        }
        return text.slice(0, MAX_BODY) + "\n…（已截断，原始长度 " + text.length + " 字符）";
    }

    /** JSON 就格式化，其余原样返回 */
    function pretty(text, mime) {
        if (!text) {
            return "";
        }
        if (/json/i.test(mime || "") || /^\s*[{[]/.test(text)) {
            try {
                return JSON.stringify(JSON.parse(text), null, 2);
            } catch (e) { /* 不是合法 JSON，原样输出 */ }
        }
        return text;
    }

    /** 能解析成 JSON 就返回对象，否则返回原字符串 —— 给 JSON 输出格式用 */
    function maybeJson(text) {
        try {
            return JSON.parse(text);
        } catch (e) {
            return text;
        }
    }

    function langOf(mime) {
        if (/json/i.test(mime)) return "json";
        if (/html/i.test(mime)) return "html";
        if (/xml/i.test(mime)) return "xml";
        if (/javascript/i.test(mime)) return "js";
        if (/css/i.test(mime)) return "css";
        return "";
    }

    /** 正文里本身有 ``` 时，围栏要更长 */
    function fenceFor(text) {
        const runs = text.match(/`{3,}/g);
        const n = runs ? Math.max.apply(null, runs.map((s) => s.length)) + 1 : 3;
        return "`".repeat(n);
    }

    function codeBlock(text, mime) {
        const fence = fenceFor(text);
        return fence + langOf(mime || "") + "\n" + text + "\n" + fence;
    }

    function toast(msg) {
        els.toast.textContent = msg;
        els.toast.classList.add("show");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => els.toast.classList.remove("show"), 1600);
    }

    /* ---------------- 数据 ---------------- */

    function addEntry(entry) {
        if (!entry || !entry.request) {
            return;
        }
        state.items.push({ id: ++state.seq, entry: entry, contentPromise: null });
        if (state.items.length > MAX_ENTRIES) {
            const dropped = state.items.splice(0, state.items.length - MAX_ENTRIES);
            const goneIds = dropped.map((it) => it.id);
            state.selected = state.selected.filter((id) => goneIds.indexOf(id) === -1);
        }
    }

    function passFilter(item) {
        if (els.xhrOnly.checked && !XHR_TYPES[item.entry._resourceType]) {
            return false;
        }
        const kw = els.filter.value.trim().toLowerCase();
        return !kw || item.entry.request.url.toLowerCase().indexOf(kw) !== -1;
    }

    function visibleItems() {
        return state.items.filter(passFilter);
    }

    function itemById(id) {
        return state.items.find((it) => it.id === id) || null;
    }

    /**
     * 响应体懒加载。
     * getHAR() 拿到的条目可能已经带 response.content.text，就不用再问一次。
     */
    function loadContent(item) {
        if (item.contentPromise) {
            return item.contentPromise;
        }
        const cached = item.entry.response && item.entry.response.content;
        if (cached && typeof cached.text === "string") {
            item.contentPromise = Promise.resolve({ text: cached.text, encoding: cached.encoding || "" });
            return item.contentPromise;
        }
        item.contentPromise = new Promise((resolve) => {
            try {
                item.entry.getContent(function (text, encoding) {
                    resolve({ text: text || "", encoding: encoding || "" });
                });
            } catch (e) {
                resolve({ text: "", encoding: "" });
            }
        });
        return item.contentPromise;
    }

    function bodyText(content, mime) {
        const raw = content.encoding === "base64" ? fromBase64(content.text) : content.text;
        return pretty(clip(raw || ""), mime);
    }

    /* ---------------- 列表渲染 ---------------- */

    function statusClass(status) {
        if (status >= 500) return "s5";
        if (status >= 400) return "s4";
        if (status >= 300) return "s3";
        if (status >= 200) return "s2";
        return "";
    }

    function scheduleList() {
        if (state.listQueued) {
            return;
        }
        state.listQueued = true;
        requestAnimationFrame(() => {
            state.listQueued = false;
            renderList();
        });
    }

    function renderList() {
        const items = visibleItems();
        els.count.textContent = items.length + " / " + state.items.length;

        if (!items.length) {
            els.list.innerHTML = '<div class="empty">暂无请求<br>面板打开后发生的请求才会记录，刷新页面即可</div>';
            return;
        }

        const atBottom = els.list.scrollTop + els.list.clientHeight >= els.list.scrollHeight - 4;
        els.list.innerHTML = items.map(function (item) {
            const req = item.entry.request;
            const res = item.entry.response || {};
            const url = safeUrl(req.url);
            const path = url ? url.pathname + url.search : req.url;
            const selected = state.selected.indexOf(item.id) !== -1 ? " selected" : "";
            return '<div class="row' + selected + '" data-id="' + item.id + '" title="' + esc(req.url) + '">' +
                '<span class="method">' + esc(req.method) + "</span>" +
                '<span class="status ' + statusClass(res.status) + '">' + esc(res.status || "-") + "</span>" +
                '<span class="path">' + esc(path) + "</span>" +
                '<span class="host">' + esc(url ? url.host : "") + "</span>" +
                "</div>";
        }).join("");

        if (atBottom) {
            els.list.scrollTop = els.list.scrollHeight;
        }
    }

    /* ---------------- 文本拼装 ---------------- */

    function queryPairs(req) {
        const url = safeUrl(req.url);
        if (url) {
            // 用 URLSearchParams 解码，比 HAR 的 queryString 稳（%xx、+ 都按规范处理）
            return Array.from(url.searchParams.entries()).map(([name, value]) => ({ name, value }));
        }
        return (req.queryString || []).map((q) => ({ name: q.name, value: q.value }));
    }

    function headerPairs(headers) {
        return (headers || []).map(function (h) {
            return { name: h.name, value: SENSITIVE_HEADER.test(h.name) ? "***" : h.value };
        });
    }

    function buildMarkdown(item, content) {
        const req = item.entry.request;
        const res = item.entry.response || {};
        const url = safeUrl(req.url);
        const resMime = (res.content && res.content.mimeType) || "";
        const out = [];

        out.push("## " + req.method + " " + (url ? url.pathname : req.url));
        out.push("");
        out.push("- 链接：`" + req.url + "`");
        out.push("- 状态：" + (res.status || "-") + " " + (res.statusText || "") +
            " · 耗时 " + Math.round(item.entry.time || 0) + " ms");

        const query = queryPairs(req);
        if (query.length) {
            out.push("");
            out.push("**Query 参数**");
            out.push("");
            query.forEach((q) => out.push("- " + q.name + " = " + q.value));
        }

        if (els.withHeaders.checked) {
            const headers = headerPairs(req.headers);
            if (headers.length) {
                out.push("");
                out.push("**请求头**（敏感项已替换为 `***`）");
                out.push("");
                headers.forEach((h) => out.push("- " + h.name + ": " + h.value));
            }
        }

        const post = req.postData;
        if (post && post.text) {
            out.push("");
            out.push("**请求体**" + (post.mimeType ? "（" + post.mimeType + "）" : ""));
            out.push("");
            out.push(codeBlock(pretty(clip(post.text), post.mimeType), post.mimeType));
        }

        out.push("");
        out.push("**响应体**" + (resMime ? "（" + resMime + "）" : ""));
        out.push("");
        const body = bodyText(content, resMime);
        out.push(body ? codeBlock(body, resMime) : "（空）");

        return out.join("\n");
    }

    function buildJsonObject(item, content) {
        const req = item.entry.request;
        const res = item.entry.response || {};
        const resMime = (res.content && res.content.mimeType) || "";
        const obj = {
            method: req.method,
            url: req.url,
            status: res.status || null,
            timeMs: Math.round(item.entry.time || 0),
        };

        const query = queryPairs(req);
        if (query.length) {
            obj.query = {};
            query.forEach((q) => { obj.query[q.name] = q.value; });
        }

        if (els.withHeaders.checked) {
            obj.requestHeaders = {};
            headerPairs(req.headers).forEach((h) => { obj.requestHeaders[h.name] = h.value; });
        }

        if (req.postData && req.postData.text) {
            obj.requestBody = maybeJson(clip(req.postData.text));
        }

        const raw = content.encoding === "base64" ? fromBase64(content.text) : content.text;
        obj.responseBody = raw ? maybeJson(clip(raw)) : null;
        if (resMime) {
            obj.responseMimeType = resMime;
        }
        return obj;
    }

    function buildText(items, contents) {
        if (els.format.value === "json") {
            const arr = items.map((item, i) => buildJsonObject(item, contents[i]));
            return JSON.stringify(arr.length === 1 ? arr[0] : arr, null, 2);
        }
        return items.map((item, i) => buildMarkdown(item, contents[i])).join("\n\n---\n\n");
    }

    /* ---------------- 预览 ---------------- */

    function renderPreview() {
        const token = ++state.renderToken;
        const items = state.selected.map(itemById).filter(Boolean);

        if (!items.length) {
            els.preview.textContent = "";
            els.copyBtn.disabled = true;
            els.hint.textContent = "在左侧点选一个请求（⌘ / Ctrl + 点击可多选）";
            return;
        }

        els.hint.textContent = "读取响应体…";
        Promise.all(items.map(loadContent)).then(function (contents) {
            if (token !== state.renderToken) {
                return; // 选择已经变了，丢弃这次结果
            }
            els.preview.textContent = buildText(items, contents);
            els.copyBtn.disabled = false;
            els.hint.textContent = "已选 " + items.length + " 条 · 下方即为将要复制的内容";
        });
    }

    /* ---------------- 剪贴板 ---------------- */

    function copyText(text) {
        function fallback() {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try {
                ok = document.execCommand("copy");
            } catch (e) { /* 下面统一提示失败 */ }
            document.body.removeChild(ta);
            toast(ok ? "已复制" : "复制失败，请手动选中下方文本");
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => toast("已复制"), fallback);
            return;
        }
        fallback();
    }

    /* ---------------- 事件 ---------------- */

    els.list.addEventListener("click", function (e) {
        const row = e.target.closest(".row");
        if (!row) {
            return;
        }
        const id = Number(row.dataset.id);
        if (e.metaKey || e.ctrlKey) {
            const i = state.selected.indexOf(id);
            if (i === -1) {
                state.selected.push(id);
            } else {
                state.selected.splice(i, 1);
            }
        } else {
            state.selected = [id];
        }
        renderList();
        renderPreview();
    });

    els.copyBtn.addEventListener("click", function () {
        if (els.preview.textContent) {
            copyText(els.preview.textContent);
        }
    });

    els.clearBtn.addEventListener("click", function () {
        state.items = [];
        state.selected = [];
        renderList();
        renderPreview();
    });

    els.filter.addEventListener("input", renderList);
    els.xhrOnly.addEventListener("change", renderList);
    [els.format, els.withHeaders].forEach((el) => el.addEventListener("change", renderPreview));

    /* ---------------- 初始化 ---------------- */

    document.documentElement.dataset.theme =
        chrome.devtools.panels.themeName === "dark" ? "dark" : "light";

    // 面板打开前已经发生的请求，从当前 HAR 里补上
    chrome.devtools.network.getHAR(function (har) {
        (har && har.entries ? har.entries : []).forEach(addEntry);
        renderList();
    });

    chrome.devtools.network.onRequestFinished.addListener(function (entry) {
        addEntry(entry);
        scheduleList();
    });

    chrome.devtools.network.onNavigated.addListener(function () {
        if (els.preserveLog.checked) {
            return;
        }
        state.items = [];
        state.selected = [];
        renderList();
        renderPreview();
    });

    renderList();
})();

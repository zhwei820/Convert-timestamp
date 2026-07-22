/**
 * CSV Viewer 页面逻辑（B：独立 chrome-extension 页面）
 *
 * 页面自带拖放区 + 文件选择按钮；解析后就地渲染表格。
 * 依赖 csv-parser.js 挂载的 window.__csvUtils。
 */
(function () {
    "use strict";

    const utils = window.__csvUtils;
    const dropView = document.getElementById("dropView");
    const tableView = document.getElementById("tableView");
    const fileInput = document.getElementById("fileInput");
    const pickBtn = document.getElementById("pickBtn");
    const resetBtn = document.getElementById("resetBtn");
    const titleEl = document.getElementById("titleEl");
    const rowCountEl = document.getElementById("rowCountEl");
    const colCountEl = document.getElementById("colCountEl");
    const delimEl = document.getElementById("delimEl");
    const tableWrap = document.getElementById("tableWrap");

    function loadFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
            const text = String(reader.result || "");
            try {
                const delimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : utils.detectDelimiter(text);
                const rows = utils.parseCsv(text, delimiter);
                render(rows, file.name, delimiter);
            } catch (e) {
                alert("解析失败：" + (e && e.message ? e.message : e));
            }
        };
        reader.onerror = function () { alert("读取文件失败。"); };
        reader.readAsText(file, "UTF-8");
    }

    function render(rows, filename, delimiter) {
        titleEl.textContent = filename;
        document.title = filename;
        rowCountEl.textContent = String(rows.length);
        colCountEl.textContent = String(rows.reduce((m, r) => Math.max(m, r.length), 0));
        delimEl.textContent = delimiter === "\t" ? "TAB" : delimiter;
        tableWrap.innerHTML = utils.renderTableHtml(rows);
        dropView.classList.add("hidden");
        tableView.classList.remove("hidden");
        utils.attachColumnCopy(tableWrap);
    }

    function reset() {
        tableView.classList.add("hidden");
        dropView.classList.remove("hidden");
        fileInput.value = "";
        tableWrap.innerHTML = "";
    }

    pickBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => loadFile(e.target.files[0]));
    resetBtn.addEventListener("click", reset);

    // 拖放区
    ["dragenter", "dragover"].forEach(ev => {
        dropView.addEventListener(ev, (e) => {
            e.preventDefault();
            dropView.classList.add("hover");
        });
    });
    ["dragleave", "drop"].forEach(ev => {
        dropView.addEventListener(ev, (e) => {
            e.preventDefault();
            dropView.classList.remove("hover");
        });
    });
    dropView.addEventListener("drop", (e) => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        loadFile(file);
    });

    // 允许把文件拖到页面任何地方（表格视图下也支持"再拖一个"覆盖）
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
        if (e.target.closest && e.target.closest("#dropView")) return; // 已由 dropView 处理
        e.preventDefault();
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) loadFile(file);
    });
})();

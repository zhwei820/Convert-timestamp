/**
 * CSV 拖拽预览（A：任意页面）
 *
 * 用户把本地 CSV/TSV 文件拖到任何已加载的网页上，出现一个悬浮"释放此处预览"的
 * 落点。释放后不下载、不导航到 file://，而是原地解析并在新标签页以表格渲染。
 *
 * 设计要点：
 *   - 只监听 dataTransfer.types 包含 "Files" 的拖拽，不干扰页面内部的 DOM 拖拽。
 *   - 落点为悬浮小面板而非全屏遮罩，避免破坏页面自身的上传拖放区。
 *   - 只处理 .csv / .tsv / .txt 后缀；其它文件放过（用户可拖到页面别处走正常流程）。
 *   - 依赖 csv-parser.js 中的 window.__csvUtils（同为 content script，共享 isolated world）。
 */
(function () {
    "use strict";

    if (window.__csvDropPreviewLoaded) return;
    window.__csvDropPreviewLoaded = true;

    const PANEL_ID = "__csv_drop_preview_panel__";
    const ACCEPT_EXT = /\.(csv|tsv|txt)$/i;
    let dragDepth = 0;
    let panel = null;

    function hasFiles(dt) {
        if (!dt) return false;
        if (dt.types) {
            for (let i = 0; i < dt.types.length; i++) {
                if (dt.types[i] === "Files") return true;
            }
        }
        return false;
    }

    function ensurePanel() {
        if (panel && document.body.contains(panel)) return panel;
        panel = document.createElement("div");
        panel.id = PANEL_ID;
        panel.style.cssText = [
            "position:fixed",
            "top:20px",
            "right:20px",
            "z-index:2147483647",
            "min-width:220px",
            "padding:18px 22px",
            "background:rgba(18,100,163,0.96)",
            "color:#fff",
            "border:2px dashed rgba(255,255,255,0.6)",
            "border-radius:12px",
            "font:600 14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "box-shadow:0 8px 24px rgba(0,0,0,0.25)",
            "pointer-events:auto",
            "user-select:none",
            "text-align:center",
            "transition:transform 0.15s,background 0.15s",
        ].join(";");
        panel.innerHTML = `
<div style="font-size:24px;margin-bottom:6px">📄</div>
<div>释放此处预览 CSV</div>
<div style="font-size:11px;font-weight:400;opacity:0.85;margin-top:6px">支持 .csv / .tsv / .txt</div>`;
        // 面板自身的拖拽事件：允许 drop
        panel.addEventListener("dragover", function (e) {
            e.preventDefault();
            e.stopPropagation();
            panel.style.background = "rgba(76,175,80,0.96)";
            panel.style.transform = "scale(1.04)";
        });
        panel.addEventListener("dragleave", function (e) {
            e.stopPropagation();
            panel.style.background = "rgba(18,100,163,0.96)";
            panel.style.transform = "";
        });
        panel.addEventListener("drop", function (e) {
            e.preventDefault();
            e.stopPropagation();
            hidePanel(true);
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            handleFile(file);
        });
        return panel;
    }

    function showPanel() {
        const p = ensurePanel();
        if (!p.isConnected) {
            (document.body || document.documentElement).appendChild(p);
        }
    }

    function hidePanel(force) {
        if (!panel) return;
        if (force) dragDepth = 0;
        if (dragDepth <= 0 && panel.isConnected) {
            panel.remove();
            dragDepth = 0;
        }
    }

    function handleFile(file) {
        if (!ACCEPT_EXT.test(file.name)) {
            alert(`不支持的文件类型：${file.name}\n目前仅支持 .csv / .tsv / .txt`);
            return;
        }
        const reader = new FileReader();
        reader.onload = function () {
            const text = String(reader.result || "");
            const utils = window.__csvUtils;
            if (!utils) {
                console.warn("[csv-drop-preview] __csvUtils 未加载");
                alert("CSV 解析模块未就绪，请刷新页面后重试。");
                return;
            }
            try {
                const delimiter = file.name.toLowerCase().endsWith(".tsv") ? "\t" : utils.detectDelimiter(text);
                const rows = utils.parseCsv(text, delimiter);
                const html = utils.buildViewerHtml(rows, { filename: file.name, delimiter });
                const blob = new Blob([html], { type: "text/html;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                window.open(url, "_blank");
            } catch (e) {
                console.warn("[csv-drop-preview] parse failed:", e);
                alert("解析失败：" + (e && e.message ? e.message : e));
            }
        };
        reader.onerror = function () {
            alert("读取文件失败。");
        };
        reader.readAsText(file, "UTF-8");
    }

    // 全局拖拽监听：只在 dataTransfer 包含 Files 时介入
    window.addEventListener("dragenter", function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        dragDepth++;
        showPanel();
    }, true);

    window.addEventListener("dragover", function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        // 只对面板外的区域"允许 drop"以让浏览器不打开文件；面板自己已 preventDefault
        // 不阻止事件继续冒泡到页面自身的拖放区（如 GitHub 上传区）。
    }, true);

    window.addEventListener("dragleave", function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        dragDepth--;
        if (dragDepth <= 0) hidePanel(true);
    }, true);

    window.addEventListener("drop", function (e) {
        // 落到页面其它区域：不干预，正常走页面/浏览器默认行为
        if (!hasFiles(e.dataTransfer)) return;
        hidePanel(true);
    }, true);

    window.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && panel && panel.isConnected) {
            hidePanel(true);
        }
    }, true);
})();

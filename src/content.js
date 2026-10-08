/**
 * 把选中文字发送到 background.js，用于更新右键菜单标题
 */
console.log('[content.js] injected at', location.href);

function getSelectedText() {
    let active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        try {
            let start = active.selectionStart;
            let end = active.selectionEnd;
            if (typeof start === "number" && typeof end === "number" && start !== end) {
                return active.value.substring(start, end);
            }
        } catch (e) {
            // 部分 input type（checkbox/button 等）不支持 selectionStart
        }
    }
    let selection = window.getSelection();
    return selection ? selection.toString() : "";
}

window.addEventListener("mouseup", function () {
    let text = getSelectedText();

    // background service worker 可能休眠或未注册 listener，吞掉 rejection 避免控制台报错
    try {
        let sending = chrome.runtime.sendMessage(text);
        if (sending && typeof sending.catch === "function") {
            sending.catch(function () {});
        }
    } catch (e) {}
});

// xterm.js 终端：选区只存在 xterm 内部（canvas 渲染），DOM 里拿不到。
// 借 xterm 在 helper textarea 上注册的 copy 处理，由它把选区写入剪贴板。
// 该处理没选区时也会写入空串，所以只在拖选 / 双击三击后触发，避免普通点击清空剪贴板。
let xtermDown = null;

window.addEventListener("mousedown", function (e) {
    let root = e.button === 0 && e.target.closest && e.target.closest(".xterm");
    // 终端内程序（zellij 等）开了鼠标模式时 xterm 不做选区，复制由 xterm-osc52.js 走 OSC 52；
    // 按住 Shift/Option 时 xterm 会强制自己选区，照常处理
    if (root && root.classList.contains("enable-mouse-events") && !e.shiftKey && !e.altKey) {
        console.log("[content.js] xterm 处于鼠标模式，交给 OSC 52 复制");
        root = null;
    }
    xtermDown = root ? { root: root, x: e.clientX, y: e.clientY } : null;
}, true);

window.addEventListener("mouseup", function (e) {
    let down = xtermDown;
    xtermDown = null;
    if (!down) return;
    let dragged = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 3;
    if (!dragged && e.detail < 2) {
        console.log("[content.js] xterm 单击，不复制");
        return;
    }

    let ta = down.root.querySelector(".xterm-helper-textarea");
    if (!ta) {
        console.warn("[content.js] xterm 未找到 .xterm-helper-textarea，跳过复制");
        return;
    }
    // 等 xterm 自己的 mouseup 处理完选区
    setTimeout(function () {
        // 冒泡阶段读 xterm 写入的内容，只为日志
        window.addEventListener("copy", function (ev) {
            let text = ev.clipboardData ? ev.clipboardData.getData("text/plain") : "";
            console.log("[content.js] xterm 复制内容(" + text.length + " 字符):", text);
        }, { once: true });
        ta.focus();
        let ok = document.execCommand("copy");
        console.log("[content.js] xterm execCommand('copy') =", ok, dragged ? "拖选" : "多击 detail=" + e.detail);
    }, 0);
}, true);

// 右键「翻译」：background 把结果发回选区所在 frame，在右键位置弹浮层
let lastContextMenuPos = null;

window.addEventListener("contextmenu", function (e) {
    lastContextMenuPos = { x: e.clientX, y: e.clientY };
}, true);

chrome.runtime.onMessage.addListener(function (message) {
    if (message && message.type === "translate-result") {
        showTranslatePopup(message);
    }
});

function showTranslatePopup(message) {
    let old = document.getElementById("__ct-translate-popup");
    if (old) old.remove();

    let box = document.createElement("div");
    box.id = "__ct-translate-popup";
    box.style.cssText = "position:fixed;z-index:2147483647;max-width:320px;padding:10px 12px;" +
        "background:#fff;color:#222;border:1px solid #ddd;border-radius:6px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.18);font:14px/1.5 -apple-system,Arial,sans-serif;" +
        "text-align:left;white-space:pre-wrap;word-break:break-word;";

    let source = document.createElement("div");
    source.style.cssText = "color:#888;font-size:12px;margin-bottom:4px;";
    source.textContent = message.source;
    let result = document.createElement("div");
    result.style.color = message.error ? "#d33" : "#222";
    result.textContent = message.error || message.translation;
    box.appendChild(source);
    box.appendChild(result);
    document.documentElement.appendChild(box);

    let pos = lastContextMenuPos || { x: window.innerWidth / 2, y: window.innerHeight / 3 };
    let left = Math.max(8, Math.min(pos.x, window.innerWidth - box.offsetWidth - 8));
    let top = pos.y + 12;
    if (top + box.offsetHeight > window.innerHeight - 8) {
        top = Math.max(8, pos.y - box.offsetHeight - 12);
    }
    box.style.left = left + "px";
    box.style.top = top + "px";

    function close(e) {
        if (e.type === "keydown" && e.key !== "Escape") return;
        if (e.type === "mousedown" && box.contains(e.target)) return;
        box.remove();
        window.removeEventListener("mousedown", close, true);
        window.removeEventListener("keydown", close, true);
    }
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
}

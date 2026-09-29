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

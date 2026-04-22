/**
 * 发送消息到 background.js，并在开启时把选中文字复制到剪贴板
 */
console.log('[content.js] injected at', location.href);
let autoCopyEnabled = true;

chrome.storage.local.get(["autoCopyOnSelect"], function (result) {
    autoCopyEnabled = result.autoCopyOnSelect !== false;
});

chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.autoCopyOnSelect) {
        autoCopyEnabled = changes.autoCopyOnSelect.newValue !== false;
    }
});

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
console.log('Selected text:', text, 'Auto-copy enabled:', autoCopyEnabled);

    // background service worker 可能休眠或未注册 listener，吞掉 rejection 避免控制台报错
    try {
        let sending = chrome.runtime.sendMessage(text);
        if (sending && typeof sending.catch === "function") {
            sending.catch(function () {});
        }
    } catch (e) {}
console.log('Selected text:', text, 'Auto-copy enabled:', autoCopyEnabled);
    if (!text || !autoCopyEnabled) {
        return;
    }

    copySelectionToClipboard(text);
});

function copySelectionToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function (err) {
            if (!fallbackCopy(text)) {
                alert("复制到剪贴板失败: " + (err && err.message ? err.message : err));
            }
        });
        return;
    }
    if (!fallbackCopy(text)) {
        alert("复制到剪贴板失败");
    }
}

function fallbackCopy(text) {
    try {
        let textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        let ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
    } catch (e) {
        console.warn("复制到剪贴板失败:", e);
        return false;
    }
}
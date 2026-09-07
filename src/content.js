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

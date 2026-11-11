// raw.githubusercontent.com 带 CSP sandbox，在它上面生成的 blob: 页也继承沙箱、脚本全被拦；
// 所以 HTML 交给扩展的 manifest sandbox 页渲染（那里允许内联脚本）。
(async function () {
    const key = "htmlPreview:" + location.hash.slice(1);
    const got = await chrome.storage.session.get(key);
    const html = got[key];
    if (!html) {
        document.body.textContent = "预览内容已失效，请回到原页面重新点击预览。";
        return;
    }
    const title = new DOMParser().parseFromString(html, "text/html").title;
    if (title) document.title = title;

    const frame = document.createElement("iframe");
    frame.src = "html-sandbox.html";
    frame.addEventListener("load", function () {
        frame.contentWindow.postMessage({ type: "html-preview-render", html: html }, "*");
    }, { once: true });
    document.body.appendChild(frame);
})();

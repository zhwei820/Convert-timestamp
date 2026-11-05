// uhook 前端把 JWT 存在 localStorage.token（SSO 回调后由 SPA 写入，不刷新页面），所以轮询而不是只在加载时读一次
(function () {
    "use strict";

    const POLL_MS = 5000;
    const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
    let lastSent = null;

    function check() {
        let token;
        try {
            token = localStorage.getItem("token");
        } catch (e) {
            return;
        }
        if (!token || token === lastSent || !JWT_RE.test(token)) return;
        lastSent = token;
        chrome.runtime.sendMessage({ type: "vault-uhook-token", token: token }, function (resp) {
            if (chrome.runtime.lastError || (resp && resp.error)) {
                lastSent = null;
                console.warn("[uhook-token] 发送失败:", chrome.runtime.lastError ? chrome.runtime.lastError.message : resp.error);
            }
        });
    }

    check();
    setInterval(check, POLL_MS);
})();

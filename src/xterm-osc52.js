/**
 * 网页终端（xterm.js）里的 zellij / tmux / vim 通过 OSC 52 转义序列请求复制：
 *   ESC ] 52 ; <目标> ; <base64> (BEL | ESC \)
 * xterm.js 默认不处理 OSC 52，这里从 WebSocket 下行数据里截出来自己写剪贴板。
 * 必须跑在 MAIN world 且 document_start，赶在页面创建 WebSocket 之前替换构造函数。
 */
(function () {
    const NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket || NativeWebSocket.__osc52Hooked) return;

    const OSC52_START = "\x1b]52;";
    // 序列可能被拆到多帧；未闭合的尾巴超过这个长度就丢弃，防止无限累积
    const MAX_PENDING = 4 * 1024 * 1024;

    function decodeBase64Utf8(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    function writeClipboard(text) {
        navigator.clipboard.writeText(text).then(function () {
            console.log("[xterm-osc52] 已复制(" + text.length + " 字符):", text);
        }, function (err) {
            console.warn("[xterm-osc52] 写剪贴板失败:", err && err.message ? err.message : err, "内容:", text);
        });
    }

    function scan(state, chunk) {
        let buf = state.pending + chunk;
        state.pending = "";
        let from = 0;
        for (;;) {
            let start = buf.indexOf(OSC52_START, from);
            if (start === -1) {
                // 保留可能是 OSC52_START 前半截的结尾
                let keep = Math.min(buf.length, OSC52_START.length - 1);
                let tail = buf.slice(buf.length - keep);
                let esc = tail.indexOf("\x1b");
                state.pending = esc === -1 ? "" : tail.slice(esc);
                return;
            }
            let bel = buf.indexOf("\x07", start);
            let st = buf.indexOf("\x1b\\", start);
            let end = bel === -1 ? st : (st === -1 ? bel : Math.min(bel, st));
            if (end === -1) {
                state.pending = buf.length - start > MAX_PENDING ? "" : buf.slice(start);
                return;
            }
            let body = buf.slice(start + OSC52_START.length, end);
            let data = body.slice(body.indexOf(";") + 1);
            if (data && data !== "?") {
                try {
                    writeClipboard(decodeBase64Utf8(data));
                } catch (e) {
                    console.warn("[xterm-osc52] base64 解码失败:", e.message);
                }
            }
            from = end + 1;
        }
    }

    function attach(ws) {
        const state = { pending: "", decoder: new TextDecoder() };
        ws.addEventListener("message", function (ev) {
            let d = ev.data;
            if (typeof d === "string") {
                scan(state, d);
            } else if (d instanceof ArrayBuffer) {
                scan(state, state.decoder.decode(d, { stream: true }));
            } else if (d instanceof Blob) {
                d.arrayBuffer().then(function (ab) {
                    scan(state, state.decoder.decode(ab, { stream: true }));
                });
            }
        });
    }

    const Hooked = new Proxy(NativeWebSocket, {
        construct: function (target, args, newTarget) {
            const ws = Reflect.construct(target, args, newTarget);
            try { attach(ws); } catch (e) {}
            return ws;
        }
    });
    NativeWebSocket.__osc52Hooked = true;
    window.WebSocket = Hooked;
})();

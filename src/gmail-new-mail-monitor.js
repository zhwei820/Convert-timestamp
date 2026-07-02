/**
 * Gmail 新邮件监听器
 *
 * manifest 用宽 match（scheme://host/path）放行，这里再按主机名收敛到 mail.google.com。
 * 通过监听 <title> 的未读计数（"Inbox (N)" / "收件箱 (N)"）+ 定时兜底扫描，
 * 一旦计数上涨就通过 chrome.runtime.sendMessage 让 background.js 弹一个
 * chrome.notifications 桌面通知。
 *
 * 仅监听当前 tab，关闭页面即停止。
 */
(function () {
    "use strict";

    if (!/^mail\.google\.com$/i.test(location.hostname)) {
        return;
    }

    if (window.__gmailNewMailMonitorLoaded) {
        return;
    }
    window.__gmailNewMailMonitorLoaded = true;

    console.log("[gmail-new-mail-monitor] script injected at", location.href);

    let lastUnread = null;         // 最近一次从 title 里读到的未读数
    let baselineEstablished = false;
    let lastNotifyAt = 0;          // 防抖，避免同一波变化触发多个通知

    /**
     * 从 document.title 里提取未读数。
     * 典型 title:
     *   "Inbox (3) - walter.zhou@bit.com - Gmail"
     *   "收件箱 (3) - walter.zhou@bit.com - Gmail"
     *   "(3) Inbox - walter.zhou@bit.com - Gmail"   (较老版本)
     * 打开单封邮件时 title 变成 "Subject - user - Gmail"（无计数），
     * 这种情况返回 null，让调用方保留上一次的计数不动。
     */
    function parseUnreadFromTitle() {
        const t = document.title || "";
        const m = t.match(/\((\d+)\)/);
        if (!m) return null;
        return parseInt(m[1], 10);
    }

    /**
     * 尝试从收件箱列表里抓最上面一行未读邮件的发件人/主题。
     * Gmail DOM 类名是混淆的、常变的，抓不到就返回 null，让通知退化为通用文案。
     */
    function findLatestUnread() {
        try {
            // 未读行通常带 class "zE"，行本身是 tr.zA
            const rows = document.querySelectorAll("tr.zA.zE");
            if (!rows || rows.length === 0) return null;
            const row = rows[0];

            // 发件人：.yX 内一般有 .zF（带 name 属性）或 .yP
            const senderEl =
                row.querySelector(".yX .zF") ||
                row.querySelector(".yX .yP") ||
                row.querySelector(".yX");
            // 主题：.y6 内的 span 或 .bog
            const subjectEl =
                row.querySelector(".y6 span") ||
                row.querySelector(".bog");

            const sender = senderEl && (senderEl.getAttribute("name") || senderEl.textContent) || "";
            const subject = subjectEl && subjectEl.textContent || "";
            return {
                sender: sender.trim(),
                subject: subject.trim(),
            };
        } catch (e) {
            return null;
        }
    }

    function check() {
        const cur = parseUnreadFromTitle();
        if (cur === null) {
            // 当前 title 不含计数（例如正在看单封邮件），不动 baseline
            return;
        }

        if (!baselineEstablished) {
            lastUnread = cur;
            baselineEstablished = true;
            console.log("[gmail-new-mail-monitor] baseline unread:", cur);
            return;
        }

        if (cur > lastUnread) {
            const delta = cur - lastUnread;
            // 200ms 内不重复触发（title 有时会连续 mutate 两三次）
            const now = Date.now();
            if (now - lastNotifyAt > 200) {
                lastNotifyAt = now;
                console.log("[gmail-new-mail-monitor] new mail arrived, delta =", delta, "total unread =", cur);
                notifyNewMail(delta, cur);
            }
        }
        lastUnread = cur;
    }

    function notifyNewMail(delta, totalUnread) {
        const latest = findLatestUnread();
        const payload = {
            type: "gmail-new-mail",
            delta: delta,
            totalUnread: totalUnread,
            sender: latest ? latest.sender : "",
            subject: latest ? latest.subject : "",
            url: location.href,
            pageTitle: document.title,
            host: location.host,
        };
        try {
            const sending = chrome.runtime.sendMessage(payload);
            if (sending && typeof sending.catch === "function") {
                sending.catch(function () {});
            }
        } catch (e) {
            // background 可能未就绪，忽略
        }
    }

    function start() {
        // 监听 <title> 变化：Gmail 更新未读数就靠改 title
        const titleEl = document.querySelector("head > title");
        if (titleEl) {
            new MutationObserver(function () {
                check();
            }).observe(titleEl, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        }

        // Gmail 有时会替换整个 <title> 节点，所以也监听 <head> 的子节点变化
        if (document.head) {
            new MutationObserver(function () {
                check();
            }).observe(document.head, {
                childList: true,
                subtree: false,
            });
        }

        // 兜底定时器：每 10s 强制检查一次
        setInterval(check, 10000);

        // 立即建立基线
        check();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();

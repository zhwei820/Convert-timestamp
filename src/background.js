console.log("[background] service worker booting");

importScripts("utils.js");

let titleId = "convert";

try {
    if (chrome.contextMenus && chrome.contextMenus.create) {
        chrome.contextMenus.create({
            title: "时间戳转换",
            id: titleId,
            contexts: ["selection"],
        });
    } else {
        console.warn("[background] chrome.contextMenus unavailable");
    }
} catch (e) {
    // 已存在的菜单 id 重复注册会抛错，忽略即可
    console.warn("[background] contextMenus.create error:", e && e.message);
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
    chrome.contextMenus.onClicked.addListener(function (info) {
        if (info.menuItemId !== titleId) return;
        // service worker 没有 localStorage 也没有 alert，菜单回调只用来把转换结果存到 chrome.storage 供 popup 读取
        try {
            chrome.storage.local.get(["timestampJudgeType"], function (res) {
                const judgeType = (res && res.timestampJudgeType) || "3";
                const convertStr = convert(info.selectionText, judgeType);
                chrome.storage.local.set({ selectText: convertStr });
            });
        } catch (e) {
            console.error("[background] contextMenus.onClicked error:", e);
        }
    });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    console.log("[background] onMessage received:", message);
    if (message && typeof message === "object" && message.type === "gitlab-pipeline-finished") {
        try {
            handleGitlabPipelineFinished(message, sender);
        } catch (e) {
            console.error("[background] handleGitlabPipelineFinished threw:", e);
        }
        return;
    }
    if (message && typeof message === "object" && message.type === "gmail-new-mail") {
        try {
            handleGmailNewMail(message, sender);
        } catch (e) {
            console.error("[background] handleGmailNewMail threw:", e);
        }
        return;
    }
    try {
        chrome.storage.local.get(["timestampJudgeType"], function (res) {
            const judgeType = (res && res.timestampJudgeType) || "3";
            const convertStr = convert(message, judgeType) + " ";
            chrome.contextMenus.update(titleId, {
                "title": convertStr,
            });
        });
    } catch (e) {
        console.error("[background] context menu update threw:", e);
    }
});

const STATUS_LABEL = {
    success: "成功",
    passed: "成功",
    failed: "失败",
    canceled: "已取消",
    cancelled: "已取消",
    skipped: "已跳过",
    manual: "等待手动操作",
};

const STATUS_EMOJI = {
    success: "✅",
    passed: "✅",
    failed: "❌",
    canceled: "⏹",
    cancelled: "⏹",
    skipped: "⤼",
    manual: "✋",
};

function handleGitlabPipelineFinished(message, sender) {
    console.log("[background] handleGitlabPipelineFinished:", message);

    const status = String(message.toStatus || "").toLowerCase();
    const label = STATUS_LABEL[status] || status;
    const emoji = STATUS_EMOJI[status] || "ℹ";
    const host = message.host || (sender && sender.url ? new URL(sender.url).host : "GitLab");
    const url = message.url || (sender && sender.url) || "";
    const pageTitle = message.pageTitle || "";

    const notificationId = "gitlab-pipeline-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const title = emoji + " GitLab Pipeline " + label;
    const body = (pageTitle ? pageTitle + "\n" : "") + host + "\n" + url;

    if (url) {
        chrome.storage.local.get(["gitlabNotificationUrls"], function (result) {
            const map = (result && result.gitlabNotificationUrls) || {};
            map[notificationId] = url;
            const keys = Object.keys(map);
            if (keys.length > 50) {
                keys.sort();
                for (let i = 0; i < keys.length - 50; i++) delete map[keys[i]];
            }
            chrome.storage.local.set({ gitlabNotificationUrls: map });
        });
    }

    if (!chrome.notifications) {
        console.error("[background] chrome.notifications is undefined — 'notifications' permission missing?");
        return;
    }

    chrome.notifications.create(
        notificationId,
        {
            type: "basic",
            iconUrl: chrome.runtime.getURL("img/WechatIMG750.jpg"),
            title: title,
            message: body,
            priority: 2,
            requireInteraction: true,
        },
        function (createdId) {
            if (chrome.runtime.lastError) {
                console.error(
                    "[background] notifications.create failed:",
                    chrome.runtime.lastError.message,
                    "— try checking macOS System Settings → Notifications → Google Chrome, and check the icon path is reachable"
                );
            } else {
                console.log("[background] notification created:", createdId);
            }
        }
    );
}

chrome.notifications.onClicked.addListener(function (notificationId) {
    if (notificationId.indexOf("gitlab-pipeline-") === 0) {
        chrome.storage.local.get(["gitlabNotificationUrls"], function (result) {
            const map = (result && result.gitlabNotificationUrls) || {};
            const url = map[notificationId];
            if (url) {
                chrome.tabs.create({ url: url });
                delete map[notificationId];
                chrome.storage.local.set({ gitlabNotificationUrls: map });
            }
            chrome.notifications.clear(notificationId);
        });
        return;
    }
    if (notificationId.indexOf("gmail-new-mail-") === 0) {
        chrome.storage.local.get(["gmailNotificationUrls"], function (result) {
            const map = (result && result.gmailNotificationUrls) || {};
            const url = map[notificationId];
            if (url) {
                chrome.tabs.create({ url: url });
                delete map[notificationId];
                chrome.storage.local.set({ gmailNotificationUrls: map });
            }
            chrome.notifications.clear(notificationId);
        });
        return;
    }
});

function handleGmailNewMail(message, sender) {
    console.log("[background] handleGmailNewMail:", message);

    const delta = Number(message.delta) || 1;
    const totalUnread = Number(message.totalUnread) || 0;
    const host = message.host || (sender && sender.url ? new URL(sender.url).host : "mail.google.com");
    const url = message.url || (sender && sender.url) || "https://mail.google.com/mail/";
    const mailSender = (message.sender || "").trim();
    const subject = (message.subject || "").trim();

    const notificationId = "gmail-new-mail-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const title = "📧 Gmail 新邮件" + (delta > 1 ? "(" + delta + " 封)" : "");
    // 优先展示发件人 / 主题；抓不到就退化为未读总数
    let body;
    if (mailSender || subject) {
        body =
            (mailSender ? "发件人: " + mailSender + "\n" : "") +
            (subject ? "主题: " + subject + "\n" : "") +
            "未读总数: " + totalUnread;
    } else {
        body = "未读总数: " + totalUnread + "\n" + host;
    }

    if (url) {
        chrome.storage.local.get(["gmailNotificationUrls"], function (result) {
            const map = (result && result.gmailNotificationUrls) || {};
            map[notificationId] = url;
            const keys = Object.keys(map);
            if (keys.length > 50) {
                keys.sort();
                for (let i = 0; i < keys.length - 50; i++) delete map[keys[i]];
            }
            chrome.storage.local.set({ gmailNotificationUrls: map });
        });
    }

    if (!chrome.notifications) {
        console.error("[background] chrome.notifications is undefined — 'notifications' permission missing?");
        return;
    }

    chrome.notifications.create(
        notificationId,
        {
            type: "basic",
            iconUrl: chrome.runtime.getURL("img/WechatIMG750.jpg"),
            title: title,
            message: body,
            priority: 2,
            requireInteraction: false,
        },
        function (createdId) {
            if (chrome.runtime.lastError) {
                console.error(
                    "[background] gmail notifications.create failed:",
                    chrome.runtime.lastError.message
                );
            } else {
                console.log("[background] gmail notification created:", createdId);
            }
        }
    );
}
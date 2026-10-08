console.log("[background] service worker booting");

importScripts("utils.js", "sol-price-badge.js");

let titleId = "convert";
let translateMenuTitle = "翻译「%s」";

// 只注册一项：扩展有两项及以上时浏览器会把它们收进二级菜单。
// 点击时按选区内容决定转换时间戳还是翻译，标题只是提示，过期也不影响点击行为
if (chrome.contextMenus && chrome.contextMenus.removeAll) {
    chrome.contextMenus.removeAll(function () {
        chrome.contextMenus.create({
            title: translateMenuTitle,
            id: titleId,
            contexts: ["selection"],
        });
    });
} else {
    console.warn("[background] chrome.contextMenus unavailable");
}

// 非时间文本（如英文单词）会转出 NaN / Invalid Date
function convertSelection(text, callback) {
    chrome.storage.local.get(["timestampJudgeType"], function (res) {
        const judgeType = (res && res.timestampJudgeType) || "3";
        const convertStr = String(convert(text, judgeType));
        const valid = !!convertStr.trim() && !/NaN|Invalid Date/.test(convertStr);
        callback(valid ? convertStr : null);
    });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
        if (info.menuItemId !== titleId) return;
        convertSelection(info.selectionText, function (convertStr) {
            if (convertStr === null) {
                translateSelection(info, tab);
                return;
            }
            // service worker 没有 localStorage 也没有 alert，转换结果存到 chrome.storage 供 popup 读取
            chrome.storage.local.set({ selectText: convertStr });
        });
    });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    console.log("[background] onMessage received:", message);
    if (message && typeof message === "object" && message.type === "translate-tts") {
        synthesizeSpeech(message.text, sendResponse);
        return true;
    }
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
    // 空串是普通点击，此时菜单本就不显示，不动它
    if (typeof message !== "string" || !message.trim()) return;
    try {
        convertSelection(message, function (convertStr) {
            chrome.contextMenus.update(titleId, {
                "title": convertStr === null ? translateMenuTitle : convertStr + " ",
            });
        });
    } catch (e) {
        console.error("[background] context menu update threw:", e);
    }
});

const DEFAULT_TRANSLATOR_REGION = "eastus";
const DEFAULT_SPEECH_REGION = "eastus";
const SPEECH_VOICE = "en-US-JennyNeural";

// Azure TTS 合成 mp3，以 data URL 回给页面播放；未配置 key 或失败时页面退回浏览器自带语音
function synthesizeSpeech(rawText, sendResponse) {
    const text = String(rawText || "").trim();
    chrome.storage.local.get(["azureSpeechKey", "azureSpeechRegion"], function (res) {
        const key = ((res && res.azureSpeechKey) || "").trim();
        const region = ((res && res.azureSpeechRegion) || DEFAULT_SPEECH_REGION).trim();
        if (!key || !text) {
            sendResponse({ error: "未配置 Azure Speech Key" });
            return;
        }
        const escaped = text.replace(/[<>&'"]/g, function (c) {
            return { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c];
        });
        fetch("https://" + region + ".tts.speech.microsoft.com/cognitiveservices/v1", {
            method: "POST",
            headers: {
                "Ocp-Apim-Subscription-Key": key,
                "Content-Type": "application/ssml+xml",
                "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            },
            body: "<speak version='1.0' xml:lang='en-US'><voice name='" + SPEECH_VOICE + "'>" + escaped + "</voice></speak>",
        })
            .then(function (resp) {
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                return resp.arrayBuffer();
            })
            .then(function (buf) {
                const bytes = new Uint8Array(buf);
                let binary = "";
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                }
                sendResponse({ audio: "data:audio/mpeg;base64," + btoa(binary) });
            })
            .catch(function (e) {
                console.warn("[background] Azure TTS failed:", e);
                sendResponse({ error: e && e.message });
            });
    });
}
const SINGLE_WORD = /^[A-Za-z][A-Za-z'-]*$/;

// 单词走词典接口取置信度前三的义项：/translate 对单词只给一个不看语境的译文（acquire → 收购）
function translateSelection(info, tab) {
    const text = (info.selectionText || "").trim();
    chrome.storage.local.get(["azureTranslatorKey", "azureTranslatorRegion"], function (res) {
        const key = ((res && res.azureTranslatorKey) || "").trim();
        const region = ((res && res.azureTranslatorRegion) || DEFAULT_TRANSLATOR_REGION).trim();
        if (!key) {
            showTranslation(tab, info.frameId, { source: text, error: "未配置 Azure Translator Key，请在扩展弹窗中填写" });
            return;
        }
        const post = function (path) {
            const headers = {
                "Ocp-Apim-Subscription-Key": key,
                "Content-Type": "application/json; charset=UTF-8",
            };
            // global 资源不需要区域头；区域资源必须带
            if (region && region !== "global") headers["Ocp-Apim-Subscription-Region"] = region;
            return fetch(
                "https://api.cognitive.microsofttranslator.com/" + path + "?api-version=3.0&from=en&to=zh-Hans",
                { method: "POST", headers: headers, body: JSON.stringify([{ Text: text }]) }
            ).then(function (resp) {
                return resp.json().catch(function () { return null; }).then(function (data) {
                    if (!resp.ok) throw new Error((data && data.error && data.error.message) || "HTTP " + resp.status);
                    return data;
                });
            });
        };
        const translateText = function () {
            return post("translate").then(function (data) { return data[0].translations[0].text; });
        };
        const pending = SINGLE_WORD.test(text)
            ? post("dictionary/lookup").then(function (data) {
                const senses = data[0].translations
                    .slice()
                    .sort(function (a, b) { return b.confidence - a.confidence; })
                    .map(function (t) { return t.displayTarget; })
                    .filter(function (t, i, arr) { return arr.indexOf(t) === i; })
                    .slice(0, 3);
                return senses.length ? senses.join("；") : translateText();
            })
            : translateText();
        pending
            .then(function (result) {
                showTranslation(tab, info.frameId, { source: text, translation: result });
            })
            .catch(function (e) {
                console.error("[background] translate failed:", e);
                showTranslation(tab, info.frameId, { source: text, error: "翻译失败: " + (e && e.message) });
            });
    });
}

// 点击菜单时直接往选区所在 frame 注入浮层（activeTab 授权），不依赖页面里已有的 content.js：
// 扩展重载后未刷新的页面里 content.js 已失效
function showTranslation(tab, frameId, payload) {
    if (!tab || tab.id === undefined || tab.id < 0) {
        console.warn("[background] translate: no tab to show result", payload);
        return;
    }
    chrome.scripting.executeScript(
        {
            target: { tabId: tab.id, frameIds: [frameId || 0] },
            func: renderTranslatePopup,
            args: [payload],
        },
        function () {
            if (chrome.runtime.lastError) {
                console.warn("[background] translate popup inject failed:", chrome.runtime.lastError.message, payload);
            }
        }
    );
}

// 序列化后在页面里执行，只能用参数和页面全局
function renderTranslatePopup(payload) {
    let old = document.getElementById("__ct-translate-popup");
    if (old) old.remove();

    let box = document.createElement("div");
    box.id = "__ct-translate-popup";
    box.style.cssText = "position:fixed;z-index:2147483647;max-width:320px;padding:10px 12px;" +
        "background:#fff;color:#222;border:1px solid #ddd;border-radius:6px;" +
        "box-shadow:0 4px 16px rgba(0,0,0,.18);font:14px/1.5 -apple-system,Arial,sans-serif;" +
        "text-align:left;white-space:pre-wrap;word-break:break-word;";

    let header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:flex-start;gap:6px;margin-bottom:4px;";
    let source = document.createElement("div");
    source.style.cssText = "flex:1;color:#888;font-size:12px;";
    source.textContent = payload.source;
    let speakBtn = document.createElement("button");
    speakBtn.type = "button";
    speakBtn.title = "朗读";
    speakBtn.textContent = "🔊";
    speakBtn.style.cssText = "flex:none;padding:0 2px;border:none;background:none;cursor:pointer;font-size:14px;line-height:1.4;";
    header.appendChild(source);
    header.appendChild(speakBtn);

    let audio = null;
    let audioUrl = null;
    function speakWithBrowser() {
        if (!window.speechSynthesis) return;
        speechSynthesis.cancel();
        let u = new SpeechSynthesisUtterance(payload.source);
        u.lang = "en-US";
        speechSynthesis.speak(u);
    }
    function playAudio() {
        if (audio) audio.pause();
        audio = new Audio(audioUrl);
        // 页面 CSP 禁 data: 媒体时播放会失败
        audio.play().catch(speakWithBrowser);
    }
    speakBtn.addEventListener("click", function () {
        if (audioUrl) {
            playAudio();
            return;
        }
        try {
            chrome.runtime.sendMessage({ type: "translate-tts", text: payload.source }, function (resp) {
                if (chrome.runtime.lastError || !resp || !resp.audio) {
                    speakWithBrowser();
                    return;
                }
                audioUrl = resp.audio;
                playAudio();
            });
        } catch (e) {
            speakWithBrowser();
        }
    });
    let result = document.createElement("div");
    result.style.color = payload.error ? "#d33" : "#222";
    result.textContent = payload.error || payload.translation;
    box.appendChild(header);
    box.appendChild(result);
    document.documentElement.appendChild(box);

    // 定位到选区下方；input/textarea 里的选区拿不到矩形，用输入框本身
    let rect = null;
    let active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
        rect = active.getBoundingClientRect();
    } else {
        let sel = window.getSelection();
        if (sel && sel.rangeCount) rect = sel.getRangeAt(0).getBoundingClientRect();
    }
    if (!rect || (!rect.width && !rect.height)) {
        rect = { left: window.innerWidth / 2 - box.offsetWidth / 2, top: window.innerHeight / 3, bottom: window.innerHeight / 3 };
    }
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8));
    let top = rect.bottom + 8;
    if (top + box.offsetHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - box.offsetHeight - 8);
    }
    box.style.left = left + "px";
    box.style.top = top + "px";

    function close(e) {
        if (e.type === "keydown" && e.key !== "Escape") return;
        if (e.type === "mousedown" && box.contains(e.target)) return;
        box.remove();
        if (audio) audio.pause();
        if (window.speechSynthesis) speechSynthesis.cancel();
        window.removeEventListener("mousedown", close, true);
        window.removeEventListener("keydown", close, true);
    }
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
}

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
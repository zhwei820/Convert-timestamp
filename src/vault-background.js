// 密码库：服务器（cc-ds.py /vault）只存密文；解密只发生在这里。
// 密钥层次：主密码 --PBKDF2--> KEK --AES-GCM 包裹--> 库密钥 K --AES-GCM--> 条目 JSON。
// Touch ID 存的是 K，所以改主密码不影响 Touch ID。解锁后的 K 只放在 storage.session（仅扩展页面和 SW 可读，浏览器关闭即清）。

const VAULT_NATIVE_HOST = "com.bit.timestamp_vault";
const VAULT_DEFAULT_SERVER = "http://127.0.0.1:8000";
const VAULT_PBKDF2_ITERATIONS = 600000;
const VAULT_DEFAULT_AUTOLOCK_MIN = 15;
const VAULT_PENDING_TTL_MS = 3 * 60 * 1000;
const VAULT_AUTOLOCK_ALARM = "vault-autolock";

function vaultB64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function vaultUnb64(s) {
    return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
}

function vaultAesKey(raw) {
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function vaultEncrypt(raw, plain) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, await vaultAesKey(raw), plain));
    return { iv: vaultB64(iv), ct: vaultB64(ct) };
}

async function vaultDecrypt(raw, box) {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: vaultUnb64(box.iv) }, await vaultAesKey(raw), vaultUnb64(box.ct));
    return new Uint8Array(plain);
}

async function vaultDeriveKek(password, salt, iterations) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations }, base, 256);
    return new Uint8Array(bits);
}

async function vaultWrapKey(key, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const kek = await vaultDeriveKek(password, salt, VAULT_PBKDF2_ITERATIONS);
    return {
        kdf: { name: "PBKDF2-SHA256", iterations: VAULT_PBKDF2_ITERATIONS, salt: vaultB64(salt) },
        wrappedKey: await vaultEncrypt(kek, key),
    };
}

async function vaultUnwrapKey(blob, password) {
    const kek = await vaultDeriveKek(password, vaultUnb64(blob.kdf.salt), blob.kdf.iterations);
    try {
        return await vaultDecrypt(kek, blob.wrappedKey);
    } catch (e) {
        throw new Error("主密码错误");
    }
}

async function vaultDecryptEntries(blob, key) {
    const plain = await vaultDecrypt(key, blob.data);
    return JSON.parse(new TextDecoder().decode(plain)).entries;
}

async function vaultEncryptEntries(key, entries) {
    return vaultEncrypt(key, new TextEncoder().encode(JSON.stringify({ entries: entries })));
}

async function vaultSettings() {
    const r = await chrome.storage.local.get(["vaultServerUrl", "vaultToken", "vaultAutoLockMin", "vaultTouchId"]);
    return {
        serverUrl: (r.vaultServerUrl || VAULT_DEFAULT_SERVER).replace(/\/+$/, ""),
        token: r.vaultToken || "",
        autoLockMin: r.vaultAutoLockMin || VAULT_DEFAULT_AUTOLOCK_MIN,
        touchId: !!r.vaultTouchId,
    };
}

// 服务器连不上时退回最近一次拉到的密文缓存（只读）；Token 错误不退回，那是配置问题
async function vaultFetchRemote() {
    const s = await vaultSettings();
    if (!s.token) throw new Error("未配置密码库服务器 Token");
    let resp;
    try {
        resp = await fetch(s.serverUrl + "/vault", { headers: { "X-Vault-Token": s.token }, cache: "no-store" });
    } catch (e) {
        const cached = (await chrome.storage.local.get(["vaultCache"])).vaultCache;
        if (!cached || cached.server !== s.serverUrl) throw new Error("连不上密码库服务器 " + s.serverUrl);
        return { rev: cached.rev, blob: cached.blob, offline: true };
    }
    const data = await resp.json().catch(function () { return null; });
    if (!resp.ok) throw new Error("密码库服务器返回 " + resp.status + ": " + ((data && data.error && data.error.message) || ""));
    await chrome.storage.local.set({ vaultCache: { server: s.serverUrl, rev: data.rev, blob: data.blob } });
    return { rev: data.rev, blob: data.blob, offline: false };
}

async function vaultPut(blob, baseRev) {
    const s = await vaultSettings();
    const resp = await fetch(s.serverUrl + "/vault", {
        method: "PUT",
        headers: { "X-Vault-Token": s.token, "Content-Type": "application/json" },
        body: JSON.stringify({ baseRev: baseRev, blob: blob }),
    });
    const data = await resp.json().catch(function () { return null; });
    if (resp.status === 409) throw new Error("服务器上的密码库已在别处修改，请重试");
    if (!resp.ok) throw new Error("保存失败 " + resp.status + ": " + ((data && data.error && data.error.message) || ""));
    await chrome.storage.local.set({ vaultCache: { server: s.serverUrl, rev: data.rev, blob: blob } });
    return data.rev;
}

async function vaultSessionKey() {
    const r = await chrome.storage.session.get(["vaultKey"]);
    return r.vaultKey ? vaultUnb64(r.vaultKey) : null;
}

async function vaultSetUnlocked(key) {
    await chrome.storage.session.set({ vaultKey: vaultB64(key), vaultLastUsed: Date.now() });
}

async function vaultTouch() {
    await chrome.storage.session.set({ vaultLastUsed: Date.now() });
}

async function vaultLock() {
    await chrome.storage.session.remove(["vaultKey", "vaultLastUsed"]);
}

async function vaultRequireKey() {
    const key = await vaultSessionKey();
    if (!key) throw new Error("密码库已锁定");
    await vaultTouch();
    return key;
}

async function vaultLoadEntries() {
    const key = await vaultRequireKey();
    const remote = await vaultFetchRemote();
    if (!remote.blob) throw new Error("服务器上还没有密码库");
    return { entries: await vaultDecryptEntries(remote.blob, key), offline: remote.offline };
}

// 串行化写操作，避免两次写拿同一个 rev 自己跟自己冲突
let vaultWriteChain = Promise.resolve();

function vaultMutate(fn) {
    const run = vaultWriteChain.then(async function () {
        const key = await vaultRequireKey();
        const remote = await vaultFetchRemote();
        if (remote.offline) throw new Error("密码库服务器离线，暂时不能修改");
        if (!remote.blob) throw new Error("服务器上还没有密码库");
        const entries = await vaultDecryptEntries(remote.blob, key);
        const result = fn(entries);
        const blob = Object.assign({}, remote.blob, { data: await vaultEncryptEntries(key, entries) });
        await vaultPut(blob, remote.rev);
        return result;
    });
    vaultWriteChain = run.catch(function () {});
    return run;
}

function vaultNative(message) {
    return new Promise(function (resolve, reject) {
        chrome.runtime.sendNativeMessage(VAULT_NATIVE_HOST, message, function (resp) {
            if (chrome.runtime.lastError) {
                reject(new Error("Touch ID 组件不可用（是否已运行 native/install.sh？）：" + chrome.runtime.lastError.message));
                return;
            }
            if (!resp || !resp.ok) {
                const err = new Error((resp && resp.error) || "Touch ID 失败");
                err.notEnrolled = !!(resp && resp.notEnrolled);
                reject(err);
                return;
            }
            resolve(resp);
        });
    });
}

// 多个输入框同时点解锁时只弹一次系统认证框
let vaultTouchIdInFlight = null;

function vaultUnlockWithTouchId() {
    if (vaultTouchIdInFlight) return vaultTouchIdInFlight;
    vaultTouchIdInFlight = (async function () {
        const s = await vaultSettings();
        if (!s.touchId) throw new Error("未启用 Touch ID 解锁");
        let resp;
        try {
            resp = await vaultNative({ cmd: "retrieve" });
        } catch (e) {
            if (e.notEnrolled) await chrome.storage.local.set({ vaultTouchId: false });
            throw e;
        }
        const key = vaultUnb64(resp.key);
        const remote = await vaultFetchRemote();
        if (!remote.blob) throw new Error("服务器上还没有密码库");
        try {
            await vaultDecryptEntries(remote.blob, key);
        } catch (e) {
            // 密码库被重建过，钥匙串里是旧库的密钥
            await vaultNative({ cmd: "clear" }).catch(function () {});
            await chrome.storage.local.set({ vaultTouchId: false });
            throw new Error("Touch ID 保存的密钥与当前密码库不匹配，请用主密码解锁后重新启用");
        }
        await vaultSetUnlocked(key);
    })().finally(function () {
        vaultTouchIdInFlight = null;
    });
    return vaultTouchIdInFlight;
}

function vaultNewId() {
    return vaultB64(crypto.getRandomValues(new Uint8Array(12))).replace(/[+/=]/g, "");
}

function vaultParseUrl(raw) {
    if (!raw) return null;
    try {
        return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "https://" + raw);
    } catch (e) {
        return null;
    }
}

// 页面主机等于条目主机或是其子域；https 条目不填进 http 页面
function vaultEntryMatches(entry, origin) {
    const u = vaultParseUrl(entry.url);
    if (!u) return false;
    const page = new URL(origin);
    if (u.protocol === "https:" && page.protocol !== "https:") return false;
    const host = u.hostname.replace(/^www\./, "");
    return page.hostname === host || page.hostname.endsWith("." + host);
}

// 用浏览器给出的 sender 判定来源，不信 content script 自报。
// 只允许顶层 frame 或与顶层同源的 frame，跨域 iframe 一律拒绝
function vaultFrameOrigin(sender) {
    if (!sender.tab || !sender.url) return null;
    let origin;
    try {
        origin = sender.origin || new URL(sender.url).origin;
    } catch (e) {
        return null;
    }
    if (!/^https?:\/\//.test(origin)) return null;
    if (sender.frameId !== 0) {
        let top = null;
        try {
            top = new URL(sender.tab.url).origin;
        } catch (e) {}
        if (origin !== top) return null;
    }
    return origin;
}

function vaultIsExtensionPage(sender) {
    return sender.id === chrome.runtime.id && !!sender.url && sender.url.indexOf(chrome.runtime.getURL("")) === 0;
}

function vaultCleanEntry(e, existing) {
    const now = Date.now();
    return {
        id: (existing && existing.id) || vaultNewId(),
        title: String(e.title || "").trim() || ((vaultParseUrl(e.url) || {}).hostname || "未命名"),
        url: String(e.url || "").trim(),
        username: String(e.username || ""),
        password: String(e.password || ""),
        notes: String(e.notes || ""),
        createdAt: (existing && existing.createdAt) || now,
        updatedAt: now,
    };
}

function vaultSameLogin(a, b) {
    const ua = vaultParseUrl(a.url);
    const ub = vaultParseUrl(b.url);
    return !!ua && !!ub && ua.hostname === ub.hostname && a.username === b.username;
}

async function vaultStatus() {
    const s = await vaultSettings();
    const status = {
        serverUrl: s.serverUrl,
        hasToken: !!s.token,
        touchId: s.touchId,
        autoLockMin: s.autoLockMin,
        unlocked: !!(await vaultSessionKey()),
        exists: false,
        offline: false,
        error: null,
    };
    if (!s.token) return status;
    try {
        const remote = await vaultFetchRemote();
        status.exists = !!remote.blob;
        status.offline = remote.offline;
    } catch (e) {
        status.error = e.message;
    }
    return status;
}

const vaultPageHandlers = {
    "vault-status": function () {
        return vaultStatus();
    },
    "vault-config": async function (msg) {
        await chrome.storage.local.set({
            vaultServerUrl: String(msg.serverUrl || VAULT_DEFAULT_SERVER).trim(),
            vaultToken: String(msg.token || "").trim(),
        });
        return vaultStatus();
    },
    "vault-create": async function (msg) {
        if (!msg.password || msg.password.length < 8) throw new Error("主密码至少 8 位");
        const remote = await vaultFetchRemote();
        if (remote.offline) throw new Error("密码库服务器离线");
        if (remote.blob) throw new Error("服务器上已有密码库，请直接解锁");
        const key = crypto.getRandomValues(new Uint8Array(32));
        const blob = Object.assign({ v: 1 }, await vaultWrapKey(key, msg.password), { data: await vaultEncryptEntries(key, []) });
        await vaultPut(blob, remote.rev);
        await vaultSetUnlocked(key);
        return {};
    },
    "vault-unlock": async function (msg) {
        const remote = await vaultFetchRemote();
        if (!remote.blob) throw new Error("服务器上还没有密码库");
        await vaultSetUnlocked(await vaultUnwrapKey(remote.blob, String(msg.password || "")));
        return {};
    },
    "vault-unlock-touchid": async function () {
        await vaultUnlockWithTouchId();
        return {};
    },
    "vault-lock": async function () {
        await vaultLock();
        return {};
    },
    "vault-list": async function () {
        return vaultLoadEntries();
    },
    "vault-save-entry": function (msg) {
        return vaultMutate(function (entries) {
            const i = entries.findIndex(function (e) { return e.id === msg.entry.id; });
            const entry = vaultCleanEntry(msg.entry, i >= 0 ? entries[i] : null);
            if (i >= 0) entries[i] = entry;
            else entries.push(entry);
            return { entry: entry };
        });
    },
    "vault-delete-entry": function (msg) {
        return vaultMutate(function (entries) {
            const i = entries.findIndex(function (e) { return e.id === msg.id; });
            if (i >= 0) entries.splice(i, 1);
            return {};
        });
    },
    "vault-import": function (msg) {
        return vaultMutate(function (entries) {
            const counts = { added: 0, updated: 0, skipped: 0 };
            (msg.entries || []).forEach(function (raw) {
                if (!raw.password) {
                    counts.skipped++;
                    return;
                }
                const i = entries.findIndex(function (e) { return vaultSameLogin(e, raw); });
                if (i < 0) {
                    entries.push(vaultCleanEntry(raw));
                    counts.added++;
                } else if (entries[i].password === raw.password) {
                    counts.skipped++;
                } else {
                    entries[i] = vaultCleanEntry(Object.assign({}, entries[i], { password: raw.password }), entries[i]);
                    counts.updated++;
                }
            });
            return counts;
        });
    },
    "vault-touchid-enable": async function () {
        const key = await vaultRequireKey();
        await vaultNative({ cmd: "store", key: vaultB64(key) });
        await chrome.storage.local.set({ vaultTouchId: true });
        return {};
    },
    "vault-touchid-disable": async function () {
        await vaultNative({ cmd: "clear" }).catch(function () {});
        await chrome.storage.local.set({ vaultTouchId: false });
        return {};
    },
    "vault-change-password": async function (msg) {
        if (!msg.newPassword || msg.newPassword.length < 8) throw new Error("新主密码至少 8 位");
        const run = vaultWriteChain.then(async function () {
            const remote = await vaultFetchRemote();
            if (remote.offline) throw new Error("密码库服务器离线");
            const key = await vaultUnwrapKey(remote.blob, String(msg.oldPassword || ""));
            await vaultPut(Object.assign({}, remote.blob, await vaultWrapKey(key, msg.newPassword)), remote.rev);
            return {};
        });
        vaultWriteChain = run.catch(function () {});
        return run;
    },
    "vault-set-autolock": async function (msg) {
        const minutes = Math.max(1, Math.min(480, parseInt(msg.minutes, 10) || VAULT_DEFAULT_AUTOLOCK_MIN));
        await chrome.storage.local.set({ vaultAutoLockMin: minutes });
        return { minutes: minutes };
    },
    "vault-open": async function () {
        await chrome.tabs.create({ url: chrome.runtime.getURL("src/vault.html") });
        return {};
    },
};

async function vaultAutofillQuery(origin) {
    const s = await vaultSettings();
    if (!(await vaultSessionKey())) return { locked: true, touchId: s.touchId };
    const loaded = await vaultLoadEntries();
    return {
        locked: false,
        entries: loaded.entries
            .filter(function (e) { return vaultEntryMatches(e, origin); })
            .map(function (e) { return { id: e.id, title: e.title, username: e.username }; }),
    };
}

async function vaultGetPending(tabId) {
    const map = (await chrome.storage.session.get(["vaultPending"])).vaultPending || {};
    const p = map[tabId];
    if (p && Date.now() - p.at > VAULT_PENDING_TTL_MS) {
        delete map[tabId];
        await chrome.storage.session.set({ vaultPending: map });
        return null;
    }
    return p || null;
}

async function vaultSetPending(tabId, pending) {
    const map = (await chrome.storage.session.get(["vaultPending"])).vaultPending || {};
    if (pending) map[tabId] = pending;
    else delete map[tabId];
    await chrome.storage.session.set({ vaultPending: map });
}

// 解锁时能判断是否已存过；锁定时先记下，保存时再判断
async function vaultPendingKind(origin, username, password) {
    if (!(await vaultSessionKey())) return "unknown";
    const loaded = await vaultLoadEntries();
    const same = loaded.entries.find(function (e) { return vaultEntryMatches(e, origin) && e.username === username; });
    if (!same) return "new";
    return same.password === password ? "same" : "update";
}

const vaultContentHandlers = {
    // 没配置密码库就不在密码框上显示图标
    "vault-af-enabled": async function () {
        return { enabled: !!(await vaultSettings()).token };
    },
    "vault-af-query": function (msg, origin) {
        return vaultAutofillQuery(origin);
    },
    "vault-af-unlock": async function (msg, origin) {
        await vaultUnlockWithTouchId();
        return vaultAutofillQuery(origin);
    },
    "vault-af-fill": async function (msg, origin) {
        const loaded = await vaultLoadEntries();
        const entry = loaded.entries.find(function (e) { return e.id === msg.id; });
        if (!entry || !vaultEntryMatches(entry, origin)) throw new Error("该条目不属于当前网站");
        return { username: entry.username, password: entry.password };
    },
    "vault-af-open": async function () {
        await chrome.tabs.create({ url: chrome.runtime.getURL("src/vault.html") });
        return {};
    },
    "vault-af-capture": async function (msg, origin, sender) {
        const username = String(msg.username || "");
        const password = String(msg.password || "");
        if (!password) return {};
        let kind = "unknown";
        try {
            kind = await vaultPendingKind(origin, username, password);
        } catch (e) {
            console.warn("[vault] capture: cannot compare with vault:", e.message);
        }
        if (kind === "same") return {};
        await vaultSetPending(sender.tab.id, { origin: origin, username: username, password: password, kind: kind, at: Date.now() });
        return {};
    },
    "vault-af-pending": async function (msg, origin, sender) {
        if (sender.frameId !== 0) return { pending: null };
        const p = await vaultGetPending(sender.tab.id);
        if (!p || p.origin !== origin) return { pending: null };
        const s = await vaultSettings();
        return {
            pending: { username: p.username, kind: p.kind },
            locked: !(await vaultSessionKey()),
            touchId: s.touchId,
        };
    },
    "vault-af-resolve": async function (msg, origin, sender) {
        const p = await vaultGetPending(sender.tab.id);
        if (!p || p.origin !== origin) return {};
        if (msg.action !== "save") {
            await vaultSetPending(sender.tab.id, null);
            return {};
        }
        if (!(await vaultSessionKey())) await vaultUnlockWithTouchId();
        const result = await vaultMutate(function (entries) {
            const i = entries.findIndex(function (e) { return vaultEntryMatches(e, p.origin) && e.username === p.username; });
            if (i < 0) {
                entries.push(vaultCleanEntry({ title: new URL(p.origin).hostname, url: p.origin, username: p.username, password: p.password }));
                return { saved: "new" };
            }
            if (entries[i].password === p.password) return { saved: "same" };
            entries[i] = vaultCleanEntry(Object.assign({}, entries[i], { password: p.password }), entries[i]);
            return { saved: "update" };
        });
        await vaultSetPending(sender.tab.id, null);
        return result;
    },
};

function isVaultMessage(message) {
    return !!message && typeof message === "object" && typeof message.type === "string" && message.type.indexOf("vault-") === 0;
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!isVaultMessage(message)) return;
    let handler = null;
    let origin = null;
    if (vaultIsExtensionPage(sender)) {
        handler = vaultPageHandlers[message.type];
    } else if (vaultContentHandlers[message.type]) {
        origin = vaultFrameOrigin(sender);
        if (!origin) {
            sendResponse({ error: "此页面 / iframe 不允许使用密码库" });
            return;
        }
        handler = vaultContentHandlers[message.type];
    }
    if (!handler) {
        sendResponse({ error: "unknown vault message" });
        return;
    }
    Promise.resolve()
        .then(function () { return handler(message, origin, sender); })
        .then(function (result) { sendResponse(result || {}); })
        .catch(function (e) {
            console.warn("[vault]", message.type, "failed:", e && e.message);
            sendResponse({ error: (e && e.message) || String(e) });
        });
    return true;
});

chrome.alarms.create(VAULT_AUTOLOCK_ALARM, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async function (alarm) {
    if (alarm.name !== VAULT_AUTOLOCK_ALARM) return;
    const r = await chrome.storage.session.get(["vaultKey", "vaultLastUsed"]);
    if (!r.vaultKey) return;
    const s = await vaultSettings();
    if (Date.now() - (r.vaultLastUsed || 0) > s.autoLockMin * 60 * 1000) await vaultLock();
});

if (chrome.idle && chrome.idle.onStateChanged) {
    chrome.idle.onStateChanged.addListener(function (state) {
        if (state === "locked") vaultLock();
    });
}

chrome.tabs.onRemoved.addListener(function (tabId) {
    vaultSetPending(tabId, null);
});

(function () {
    "use strict";

    const CLIPBOARD_CLEAR_MS = 30000;
    const GEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
    const GEN_LENGTH = 20;

    const $ = function (id) { return document.getElementById(id); };
    let status = null;
    let entries = [];
    let editingId = null;
    // 每次锁定只自动弹一次 Touch ID：取消后不再追着弹；手动点「锁定」的不弹
    let autoTouchIdArmed = true;

    function send(msg) {
        return new Promise(function (resolve, reject) {
            chrome.runtime.sendMessage(msg, function (resp) {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else if (resp && resp.error) reject(new Error(resp.error));
                else resolve(resp || {});
            });
        });
    }

    let toastTimer = null;
    function toast(text) {
        const t = $("toast");
        t.textContent = text;
        t.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove("show"); }, 1800);
    }

    // 按钮执行期间禁用，错误写到对应的错误行
    function action(button, errorEl, fn) {
        button.addEventListener("click", function () {
            errorEl.textContent = "";
            button.disabled = true;
            Promise.resolve()
                .then(fn)
                .catch(function (e) { errorEl.textContent = e.message; })
                .finally(function () { button.disabled = false; });
        });
    }

    function showView(name) {
        ["viewConfig", "viewCreate", "viewUnlock", "viewMain"].forEach(function (id) {
            $(id).hidden = id !== name;
        });
        const focus = { viewConfig: "cfgToken", viewCreate: "createPw", viewUnlock: "unlockPw", viewMain: "search" }[name];
        if (focus) $(focus).focus();
    }

    async function refresh() {
        status = await send({ type: "vault-status" });
        $("statusText").textContent = status.unlocked ? (status.offline ? "已解锁 · 服务器离线（只读）" : "已解锁") : "";
        if (!status.hasToken || (status.error && !status.unlocked)) {
            $("cfgUrl").value = status.serverUrl;
            $("cfgError").textContent = status.error || "";
            $("cfgCancel").hidden = true;
            showView("viewConfig");
            return;
        }
        if (!status.exists) {
            showView("viewCreate");
            return;
        }
        if (!status.unlocked) {
            $("unlockTouchId").hidden = !status.touchId;
            $("touchIdOffHint").hidden = !!status.touchId;
            showView("viewUnlock");
            maybeAutoTouchId();
            return;
        }
        autoTouchIdArmed = true;
        showView("viewMain");
        renderSettings();
        await loadEntries();
    }

    // 页面在后台或屏幕已锁时不弹框，等切回来（focus）/ 屏幕解锁（idle active）再弹
    function maybeAutoTouchId() {
        if (!autoTouchIdArmed || !status || !status.touchId || $("viewUnlock").hidden || !document.hasFocus()) return;
        function prompt(state) {
            if (state === "locked" || !autoTouchIdArmed) return;
            autoTouchIdArmed = false;
            $("unlockTouchId").click();
        }
        if (chrome.idle) chrome.idle.queryState(60, prompt);
        else prompt("active");
    }

    async function loadEntries() {
        const resp = await send({ type: "vault-list" });
        entries = resp.entries;
        renderList();
    }

    function hostOf(url) {
        try {
            return new URL(/:\/\//.test(url) ? url : "https://" + url).hostname;
        } catch (e) {
            return url;
        }
    }

    function copy(text, label) {
        navigator.clipboard.writeText(text).then(function () {
            toast("已复制" + label + (label === "密码" ? "，30 秒后清空剪贴板" : ""));
            if (label !== "密码") return;
            // 页面需仍处于聚焦状态才能写剪贴板，否则清空失败
            setTimeout(function () {
                navigator.clipboard.writeText("").catch(function () {});
            }, CLIPBOARD_CLEAR_MS);
        });
    }

    function button(text, cls, fn) {
        const b = document.createElement("button");
        b.textContent = text;
        if (cls) b.className = cls;
        b.addEventListener("click", fn);
        return b;
    }

    function fieldsText(fields) {
        return Object.keys(fields || {}).map(function (k) { return k + "=" + fields[k]; }).join("\n");
    }

    function parseFields(text) {
        const out = {};
        text.split("\n").forEach(function (line) {
            const i = line.indexOf("=");
            if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
        return out;
    }

    function fieldValues(e) {
        return Object.keys(e.fields || {}).map(function (k) { return e.fields[k]; });
    }

    function renderList() {
        const q = $("search").value.trim().toLowerCase();
        const list = $("list");
        list.textContent = "";
        const shown = entries
            .filter(function (e) {
                return !q || [e.title, e.url, e.username].concat(fieldValues(e)).some(function (v) { return (v || "").toLowerCase().indexOf(q) >= 0; });
            })
            .sort(function (a, b) { return a.title.localeCompare(b.title); });
        $("empty").hidden = entries.length > 0;
        shown.forEach(function (e) {
            const row = document.createElement("div");
            row.className = "entry";
            const info = document.createElement("div");
            info.className = "info";
            const title = document.createElement("div");
            title.className = "title";
            title.textContent = e.title;
            const sub = document.createElement("div");
            sub.className = "sub";
            sub.textContent = fieldValues(e).concat(e.username || "（无用户名）", hostOf(e.url)).join(" · ");
            info.appendChild(title);
            info.appendChild(sub);
            const actions = document.createElement("div");
            actions.className = "actions";
            actions.appendChild(button("复制用户名", "ghost", function () { copy(e.username, "用户名"); }));
            actions.appendChild(button("复制密码", "ghost", function () { copy(e.password, "密码"); }));
            if (e.url) {
                actions.appendChild(button("打开", "ghost", function () {
                    chrome.tabs.create({ url: /:\/\//.test(e.url) ? e.url : "https://" + e.url });
                }));
            }
            actions.appendChild(button("编辑", "ghost", function () { openEditor(e); }));
            actions.appendChild(button("删除", "danger", function () {
                if (!confirm("删除「" + e.title + "」？")) return;
                send({ type: "vault-delete-entry", id: e.id })
                    .then(loadEntries)
                    .then(function () { toast("已删除"); })
                    .catch(function (err) { alert(err.message); });
            }));
            row.appendChild(info);
            row.appendChild(actions);
            list.appendChild(row);
        });
    }

    function openEditor(e) {
        editingId = e ? e.id : null;
        $("editorTitle").textContent = e ? "编辑" : "新增";
        $("edTitle").value = e ? e.title : "";
        $("edUrl").value = e ? e.url : "";
        $("edUser").value = e ? e.username : "";
        $("edPw").value = e ? e.password : "";
        $("edPw").type = "password";
        $("edShow").textContent = "显示";
        $("edNotes").value = e ? e.notes : "";
        $("edFields").value = e ? fieldsText(e.fields) : "";
        $("edError").textContent = "";
        $("editor").hidden = false;
        $("settings").hidden = true;
        $("edTitle").focus();
    }

    // 拒绝采样，避免取模偏差
    function generatePassword() {
        const out = [];
        const limit = 256 - (256 % GEN_CHARS.length);
        while (out.length < GEN_LENGTH) {
            const bytes = crypto.getRandomValues(new Uint8Array(GEN_LENGTH * 2));
            for (let i = 0; i < bytes.length && out.length < GEN_LENGTH; i++) {
                if (bytes[i] < limit) out.push(GEN_CHARS[bytes[i] % GEN_CHARS.length]);
            }
        }
        return out.join("");
    }

    function renderSettings() {
        $("touchIdText").textContent = status.touchId ? "Touch ID 解锁：已启用" : "Touch ID 解锁：未启用";
        $("touchIdToggle").textContent = status.touchId ? "停用" : "启用";
        $("autoLock").value = status.autoLockMin;
    }

    // 兼容 Chrome（name,url,username,password,note）、1Password（Title,Url,Username,Password,Notes）、
    // Bitwarden（name,login_uri,login_username,login_password,notes,type）导出的 CSV
    const CSV_COLUMNS = {
        title: ["name", "title"],
        url: ["url", "login_uri", "website", "urls"],
        username: ["username", "login_username", "user name", "email"],
        password: ["password", "login_password"],
        notes: ["note", "notes", "extra"],
    };

    function parseImport(text) {
        const rows = window.__csvUtils.parseCsv(text, ",");
        if (rows.length < 2) throw new Error("CSV 里没有数据");
        const header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
        const col = {};
        Object.keys(CSV_COLUMNS).forEach(function (field) {
            col[field] = header.findIndex(function (h) { return CSV_COLUMNS[field].indexOf(h) >= 0; });
        });
        if (col.password < 0) throw new Error("没找到 password 列，表头: " + rows[0].join(", "));
        const typeCol = header.indexOf("type");
        return rows.slice(1)
            .filter(function (r) { return typeCol < 0 || !r[typeCol] || r[typeCol] === "login"; })
            .map(function (r) {
                const pick = function (f) { return col[f] >= 0 ? (r[col[f]] || "").trim() : ""; };
                return { title: pick("title"), url: pick("url"), username: pick("username"), password: r[col.password] || "", notes: pick("notes") };
            })
            .filter(function (e) { return e.password; });
    }

    action($("cfgSave"), $("cfgError"), async function () {
        await send({ type: "vault-config", serverUrl: $("cfgUrl").value, token: $("cfgToken").value });
        $("cfgToken").value = "";
        await refresh();
    });
    $("cfgCancel").addEventListener("click", function () { refresh(); });

    action($("createBtn"), $("createError"), async function () {
        if ($("createPw").value !== $("createPw2").value) throw new Error("两次输入不一致");
        await send({ type: "vault-create", password: $("createPw").value });
        $("createPw").value = $("createPw2").value = "";
        await refresh();
    });

    action($("unlockBtn"), $("unlockError"), async function () {
        await send({ type: "vault-unlock", password: $("unlockPw").value });
        $("unlockPw").value = "";
        await refresh();
    });
    $("unlockPw").addEventListener("keydown", function (e) {
        if (e.key === "Enter") $("unlockBtn").click();
    });
    action($("unlockTouchId"), $("unlockError"), async function () {
        await send({ type: "vault-unlock-touchid" });
        await refresh();
    });

    $("search").addEventListener("input", renderList);
    $("addBtn").addEventListener("click", function () { openEditor(null); });
    $("lockBtn").addEventListener("click", function () {
        autoTouchIdArmed = false;
        send({ type: "vault-lock" }).then(refresh);
    });
    $("settingsBtn").addEventListener("click", function () {
        $("settings").hidden = !$("settings").hidden;
        $("editor").hidden = true;
    });

    $("edShow").addEventListener("click", function () {
        const show = $("edPw").type === "password";
        $("edPw").type = show ? "text" : "password";
        $("edShow").textContent = show ? "隐藏" : "显示";
    });
    $("edGen").addEventListener("click", function () {
        $("edPw").value = generatePassword();
        $("edPw").type = "text";
        $("edShow").textContent = "隐藏";
    });
    $("edCancel").addEventListener("click", function () { $("editor").hidden = true; });
    action($("edSave"), $("edError"), async function () {
        if (!$("edPw").value) throw new Error("密码不能为空");
        await send({
            type: "vault-save-entry",
            entry: {
                id: editingId,
                title: $("edTitle").value,
                url: $("edUrl").value,
                username: $("edUser").value,
                password: $("edPw").value,
                notes: $("edNotes").value,
                fields: parseFields($("edFields").value),
            },
        });
        $("editor").hidden = true;
        await loadEntries();
        toast("已保存");
    });

    $("importBtn").addEventListener("click", function () { $("importFile").click(); });
    $("importFile").addEventListener("change", function () {
        const file = $("importFile").files[0];
        $("importFile").value = "";
        if (!file) return;
        file.text()
            .then(function (text) { return send({ type: "vault-import", entries: parseImport(text) }); })
            .then(function (r) {
                toast("导入完成：新增 " + r.added + "，更新 " + r.updated + "，跳过 " + r.skipped);
                return loadEntries();
            })
            .catch(function (e) { alert("导入失败：" + e.message); });
    });

    action($("touchIdToggle"), $("settingsError"), async function () {
        await send({ type: status.touchId ? "vault-touchid-disable" : "vault-touchid-enable" });
        await refresh();
        toast(status.touchId ? "已启用 Touch ID 解锁" : "已停用 Touch ID 解锁");
    });
    $("autoLock").addEventListener("change", function () {
        send({ type: "vault-set-autolock", minutes: $("autoLock").value }).then(function (r) {
            $("autoLock").value = r.minutes;
            toast("已设置");
        });
    });
    action($("changePwBtn"), $("settingsError"), async function () {
        await send({ type: "vault-change-password", oldPassword: $("oldPw").value, newPassword: $("newPw").value });
        $("oldPw").value = $("newPw").value = "";
        toast("主密码已修改");
    });
    $("serverBtn").addEventListener("click", function () {
        $("cfgUrl").value = status.serverUrl;
        $("cfgToken").value = "";
        $("cfgError").textContent = "";
        $("cfgCancel").hidden = false;
        showView("viewConfig");
    });

    // 自动锁定 / 别处解锁时同步界面
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area === "session" && changes.vaultKey) refresh().catch(function () {});
    });

    window.addEventListener("focus", maybeAutoTouchId);
    if (chrome.idle && chrome.idle.onStateChanged) {
        chrome.idle.onStateChanged.addListener(function (state) {
            if (state === "active") maybeAutoTouchId();
        });
    }

    refresh().catch(function (e) {
        $("cfgError").textContent = e.message;
        showView("viewConfig");
    });
})();

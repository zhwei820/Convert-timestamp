// 密码库自动填充 / 保存提示。
// 页面脚本能读写 DOM，所以：UI 放在 closed shadow root 里；只响应 isTrusted 的点击；
// 只在用户点选后才向 background 要一条凭据，来源校验在 background 用 sender 做
(function () {
    "use strict";
    if (window.__ctVaultAutofill) return;
    window.__ctVaultAutofill = true;

    const USERNAME_TYPES = ["", "text", "email", "tel"];
    const USERNAME_HINT = /user|login|email|account|phone|mobile|账号|帐号|用户/i;
    const EXTRA_HINT = /domain|org|company|tenant|workspace|corp|企业|组织|租户|域/i;
    const LOGIN_BUTTON = /log\s*in|sign\s*in|submit|continue|next|登录|登入|确定|继续|下一步/i;

    let enabled = null;
    let host = null;
    let shadow = null;
    let iconEl = null;
    let menuEl = null;
    let anchor = null;
    let lastCapture = { key: "", at: 0 };
    // 组织域名等框常在单独的 form 或前一步 SPA 页面里，提交密码时可能已不在 DOM 中
    const rememberedExtra = {};

    function send(msg) {
        return new Promise(function (resolve) {
            try {
                chrome.runtime.sendMessage(msg, function (resp) {
                    if (chrome.runtime.lastError) resolve({ error: "扩展已重新加载，请刷新页面" });
                    else resolve(resp || {});
                });
            } catch (e) {
                resolve({ error: "扩展已重新加载，请刷新页面" });
            }
        });
    }

    function isVisible(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.1;
    }

    function scopeOf(el) {
        return el.form || el.closest("form") || document;
    }

    function inputType(el) {
        return (el.getAttribute("type") || "").toLowerCase();
    }

    function visiblePasswords(scope) {
        return Array.prototype.filter.call(scope.querySelectorAll("input[type=password]"), isVisible);
    }

    function usernameBefore(pw) {
        const inputs = Array.prototype.slice.call(scopeOf(pw).querySelectorAll("input"));
        for (let i = inputs.indexOf(pw) - 1; i >= 0; i--) {
            const el = inputs[i];
            if (isTextInput(el)) return el;
        }
        return null;
    }

    function fieldKey(el) {
        return el.id || el.name || "";
    }

    function isTextInput(el) {
        return USERNAME_TYPES.indexOf(inputType(el)) >= 0 && isVisible(el) && !el.readOnly && !el.disabled;
    }

    // 账号框之前的其它文本框（如组织域名），按 id / name 存取，没有的无法回填所以不收
    function extraFieldsBefore(pw, user) {
        const out = {};
        const inputs = Array.prototype.slice.call(scopeOf(pw).querySelectorAll("input"));
        const end = inputs.indexOf(user || pw);
        inputs.slice(0, end).forEach(function (el) {
            const key = fieldKey(el);
            if (key && isTextInput(el) && el.value.trim()) out[key] = el.value.trim();
        });
        return out;
    }

    function isExtraField(el) {
        return el instanceof HTMLInputElement && !!fieldKey(el) && isTextInput(el) &&
            EXTRA_HINT.test(el.id + " " + el.name + " " + (el.getAttribute("placeholder") || ""));
    }

    function documentExtraFields() {
        const out = {};
        Array.prototype.forEach.call(document.querySelectorAll("input"), function (el) {
            if (isExtraField(el) && el.value.trim()) out[fieldKey(el)] = el.value.trim();
        });
        return out;
    }

    function fillExtraFields(fields) {
        const keys = Object.keys(fields || {});
        if (!keys.length) return;
        Array.prototype.forEach.call(document.querySelectorAll("input"), function (el) {
            const key = fieldKey(el);
            if (key && keys.indexOf(key) >= 0 && isTextInput(el) && el.value !== fields[key]) setValue(el, fields[key]);
        });
    }

    function fieldsLabel(fields) {
        return Object.keys(fields || {}).map(function (k) { return fields[k]; }).join(" / ");
    }

    // 返回 { user, pw }；不是登录相关输入框返回 null
    function loginFields(el) {
        if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null;
        if (inputType(el) === "password") return { user: usernameBefore(el), pw: el };
        if (USERNAME_TYPES.indexOf(inputType(el)) < 0) return null;
        const pws = visiblePasswords(scopeOf(el));
        const pw = pws.find(function (p) { return el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING; });
        const user = pw && usernameBefore(pw);
        if (user === el) return { user: el, pw: pw };
        // 紧挨账号框上方、带 id / name 的框（如组织域名）也出图标，回填由 fillExtraFields 按 id / name 完成
        if (user && fieldKey(el) && usernameBefore(user) === el) return { user: user, pw: pw };
        // 两步登录的第一步（只有账号框）
        const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
        if (!pws.length && (/username|email/.test(ac) || USERNAME_HINT.test((el.name || "") + " " + (el.id || "")))) {
            return { user: el, pw: null };
        }
        if (isExtraField(el)) {
            const anyPw = visiblePasswords(document)[0] || null;
            return { user: anyPw && usernameBefore(anyPw), pw: anyPw };
        }
        return null;
    }

    function ensureHost() {
        if (host && host.isConnected) return;
        host = document.createElement("div");
        host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
        shadow = host.attachShadow({ mode: "closed" });
        shadow.innerHTML =
            "<style>" +
            ":host{all:initial}" +
            "*{box-sizing:border-box;font:13px/1.4 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}" +
            ".icon{position:fixed;width:22px;height:22px;border:none;border-radius:4px;background:#5e44d1;color:#fff;cursor:pointer;" +
            "display:flex;align-items:center;justify-content:center;font-size:12px;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.25)}" +
            ".menu,.bar{position:fixed;min-width:240px;max-width:340px;background:#fff;color:#222;border:1px solid #ddd;border-radius:8px;" +
            "box-shadow:0 6px 24px rgba(0,0,0,.18);padding:6px;}" +
            ".item{display:block;width:100%;text-align:left;border:none;background:none;padding:6px 8px;border-radius:6px;cursor:pointer;color:#222}" +
            ".item:hover{background:#f0edff}" +
            ".t{font-weight:600}.u{color:#666;font-size:12px}" +
            ".msg{padding:6px 8px;color:#555}.err{color:#d33}" +
            ".row{display:flex;gap:6px;padding:4px 8px;justify-content:flex-end}" +
            ".btn{border:none;border-radius:6px;padding:5px 10px;cursor:pointer;background:#5e44d1;color:#fff}" +
            ".btn.ghost{background:#eee;color:#333}" +
            ".bar{top:12px;right:12px;padding:10px}" +
            "</style>";
        document.documentElement.appendChild(host);
    }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    // mousedown 阻止默认行为，点我们的 UI 时输入框不失焦
    function onTrustedClick(node, fn) {
        node.addEventListener("mousedown", function (e) { e.preventDefault(); });
        node.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (!e.isTrusted) return;
            fn(e);
        });
    }

    function position() {
        if (!anchor || !anchor.isConnected) {
            hideAll();
            return;
        }
        const r = anchor.getBoundingClientRect();
        if (iconEl) {
            iconEl.style.left = r.right - 26 + "px";
            iconEl.style.top = r.top + (r.height - 22) / 2 + "px";
        }
        if (menuEl) {
            menuEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 348)) + "px";
            menuEl.style.top = r.bottom + 4 + "px";
        }
    }

    function hideMenu() {
        if (menuEl) menuEl.remove();
        menuEl = null;
    }

    function hideAll() {
        hideMenu();
        if (iconEl) iconEl.remove();
        iconEl = null;
        anchor = null;
    }

    function showIcon(input) {
        ensureHost();
        anchor = input;
        if (!iconEl) {
            iconEl = el("button", "icon", "🔑");
            iconEl.title = "从密码库填充";
            onTrustedClick(iconEl, function () {
                if (menuEl) hideMenu();
                else openMenu();
            });
            shadow.appendChild(iconEl);
        }
        position();
    }

    function renderMenu(build) {
        hideMenu();
        menuEl = el("div", "menu");
        build(menuEl);
        shadow.appendChild(menuEl);
        position();
    }

    function openVaultButton(box) {
        const b = el("button", "btn ghost", "打开密码库");
        onTrustedClick(b, function () {
            send({ type: "vault-af-open" });
            hideMenu();
        });
        box.appendChild(b);
    }

    function renderQueryResult(resp) {
        renderMenu(function (box) {
            if (resp.error) {
                box.appendChild(el("div", "msg err", resp.error));
                return;
            }
            if (resp.locked) {
                box.appendChild(el("div", "msg", "🔒 密码库已锁定"));
                if (resp.unlockError) box.appendChild(el("div", "msg err", resp.unlockError));
                const row = el("div", "row");
                if (resp.touchId) {
                    const b = el("button", "btn", "Touch ID 解锁");
                    onTrustedClick(b, touchIdUnlock);
                    row.appendChild(b);
                }
                openVaultButton(row);
                box.appendChild(row);
                return;
            }
            if (!resp.entries.length) {
                box.appendChild(el("div", "msg", "密码库里没有这个网站的账号"));
                const row = el("div", "row");
                openVaultButton(row);
                box.appendChild(row);
                return;
            }
            resp.entries.forEach(function (entry) {
                const item = el("button", "item");
                item.appendChild(el("div", "t", entry.title));
                const extra = fieldsLabel(entry.fields);
                item.appendChild(el("div", "u", (extra ? extra + " · " : "") + (entry.username || "（无用户名）")));
                onTrustedClick(item, function () { fill(entry.id); });
                box.appendChild(item);
            });
        });
    }

    // 失败（取消 / 未启用等）后重新查询，退回带错误提示的锁定菜单
    function touchIdUnlock() {
        renderMenu(function (box) { box.appendChild(el("div", "msg", "等待 Touch ID 认证…")); });
        send({ type: "vault-af-unlock" }).then(function (resp) {
            if (!resp.error) {
                renderQueryResult(resp);
                return;
            }
            send({ type: "vault-af-query" }).then(function (q) {
                renderQueryResult(Object.assign(q, { unlockError: resp.error }));
            });
        });
    }

    // 点钥匙图标是用户主动操作，锁定且启用了 Touch ID 就直接弹指纹
    function openMenu() {
        renderMenu(function (box) { box.appendChild(el("div", "msg", "读取密码库…")); });
        send({ type: "vault-af-query" }).then(function (resp) {
            if (resp.locked && resp.touchId) touchIdUnlock();
            else renderQueryResult(resp);
        });
    }

    // 走原型上的 setter：React 等框架拦截了实例上的 value 属性，直接赋值它们感知不到
    function setValue(input, value) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        input.focus();
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function fill(id) {
        const fields = anchor && loginFields(anchor);
        if (!fields) return;
        send({ type: "vault-af-fill", id: id }).then(function (resp) {
            if (resp.error) {
                renderQueryResult(resp);
                return;
            }
            fillExtraFields(resp.fields);
            if (fields.user && resp.username && isVisible(fields.user)) setValue(fields.user, resp.username);
            if (fields.pw && isVisible(fields.pw)) setValue(fields.pw, resp.password);
            hideMenu();
        });
    }

    // 只缓存「已启用」：页面打开后才去配置密码库时，不刷新页面也能出图标
    function maybeShow(target) {
        if (target === anchor || !loginFields(target) || !isVisible(target)) return;
        const show = function () {
            if (enabled && document.activeElement === target) showIcon(target);
        };
        if (enabled) {
            show();
            return;
        }
        send({ type: "vault-af-enabled" }).then(function (resp) {
            enabled = !!resp.enabled;
            show();
        });
    }

    document.addEventListener("focusin", function (e) { maybeShow(e.target); }, true);
    // 页面自动聚焦发生在本脚本注入之前，收不到 focusin；点击已聚焦的输入框时补上
    document.addEventListener("pointerdown", function (e) {
        if (e.target === document.activeElement) maybeShow(e.target);
    }, true);

    document.addEventListener("focusout", function (e) {
        if (e.target !== anchor) return;
        setTimeout(function () {
            if (anchor && document.activeElement !== anchor) hideAll();
        }, 150);
    }, true);

    let repositionQueued = false;
    function queueReposition() {
        if (repositionQueued || !anchor) return;
        repositionQueued = true;
        requestAnimationFrame(function () {
            repositionQueued = false;
            position();
        });
    }
    window.addEventListener("scroll", queueReposition, true);
    window.addEventListener("resize", queueReposition);
    window.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && menuEl) hideMenu();
    }, true);

    // ---------- 保存提示 ----------

    function capture(scope) {
        const pws = visiblePasswords(scope).filter(function (p) { return p.value; });
        if (!pws.length) return;
        // 改密表单（旧 / 新 / 确认）取最后一个，即新密码
        const pw = pws[pws.length - 1];
        const user = usernameBefore(pws[0]);
        const username = user ? user.value.trim() : "";
        const extra = Object.assign({}, rememberedExtra, documentExtraFields(), extraFieldsBefore(pws[0], user));
        const key = username + "\n" + pw.value + "\n" + JSON.stringify(extra);
        if (key === lastCapture.key && Date.now() - lastCapture.at < 3000) return;
        lastCapture = { key: key, at: Date.now() };
        send({ type: "vault-af-capture", username: username, password: pw.value, fields: extra }).then(function () {
            // SPA 登录不跳转页面，稍后在本页提示；跳转了则由新页面加载时提示
            if (window === window.top) setTimeout(checkPending, 1500);
        });
    }

    document.addEventListener("input", function (e) {
        if (isExtraField(e.target) && e.target.value.trim()) rememberedExtra[fieldKey(e.target)] = e.target.value.trim();
    }, true);

    document.addEventListener("submit", function (e) {
        if (e.target instanceof HTMLFormElement) capture(e.target);
    }, true);

    document.addEventListener("click", function (e) {
        const btn = e.target instanceof Element && e.target.closest("button,input[type=submit],input[type=button],[role=button]");
        if (!btn) return;
        const form = btn.closest("form");
        if (form) {
            capture(form);
        } else if (LOGIN_BUTTON.test(btn.textContent || btn.value || "")) {
            capture(document);
        }
    }, true);

    document.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement && inputType(e.target) === "password") {
            capture(scopeOf(e.target));
        }
    }, true);

    let barEl = null;

    function showSaveBar(resp) {
        ensureHost();
        if (barEl) barEl.remove();
        barEl = el("div", "bar");
        const p = resp.pending;
        const label = [fieldsLabel(p.fields), p.username].filter(Boolean).join(" / ");
        const who = label ? "「" + label + "」" : "";
        const verb = p.kind === "update" ? "更新" : "保存";
        const msg = el("div", "msg", verb + who + "的密码到密码库？");
        barEl.appendChild(msg);
        const row = el("div", "row");
        const close = function () {
            if (barEl) barEl.remove();
            barEl = null;
        };
        if (resp.locked && !resp.touchId) {
            msg.textContent = "密码库已锁定，解锁后刷新页面即可" + verb + who + "的密码";
            openVaultButton(row);
        } else {
            const save = el("button", "btn", resp.locked ? "Touch ID 解锁并" + verb : verb);
            onTrustedClick(save, function () {
                save.textContent = "保存中…";
                send({ type: "vault-af-resolve", action: "save" }).then(function (r) {
                    if (r.error) {
                        msg.textContent = r.error;
                        msg.className = "msg err";
                        save.textContent = "重试";
                        return;
                    }
                    msg.textContent = r.saved === "same" ? "密码库里已是这个密码" : "已" + (r.saved === "update" ? "更新" : "保存");
                    row.remove();
                    setTimeout(close, 1500);
                });
            });
            row.appendChild(save);
        }
        const dismiss = el("button", "btn ghost", "不用了");
        onTrustedClick(dismiss, function () {
            send({ type: "vault-af-resolve", action: "dismiss" });
            close();
        });
        row.appendChild(dismiss);
        barEl.appendChild(row);
        shadow.appendChild(barEl);
    }

    function checkPending() {
        send({ type: "vault-af-pending" }).then(function (resp) {
            if (resp && resp.pending) showSaveBar(resp);
        });
    }

    if (window === window.top) checkPending();
    if (document.activeElement) maybeShow(document.activeElement);
})();

/**
 * 知乎朗读
 *
 * 检测到 www.zhihu.com 时，自动朗读页面里的问题和答案。
 * 朗读每条内容前先点击「阅读全文」展开全文。
 *
 * 说明：Edge 原生「大声朗读」没有扩展 API，这里用 Web Speech API
 * (speechSynthesis)，在 Edge 中同样走 Edge 的语音引擎（含自然语音）。
 *
 * 支持页面：
 *   - 首页信息流 (.TopstoryItem > .ContentItem)
 *   - 问题详情页 (.QuestionHeader-title + .AnswerItem)
 */
(function () {
    "use strict";

    if (window.__zhihuReadAloudLoaded) {
        return;
    }
    window.__zhihuReadAloudLoaded = true;

    if (!/(^|\.)zhihu\.com$/.test(location.hostname)) {
        return;
    }

    const BTN_ID = "__zhihu_read_aloud_btn__";
    const NEXT_BTN_ID = "__zhihu_read_aloud_next_btn__";
    const HIGHLIGHT_STYLE = "2px solid #1772f6";

    let reading = false;
    let stopRequested = false;
    let skipRequested = false;
    let currentItem = null;

    function log(...args) {
        console.log("[zhihu-read-aloud]", ...args);
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    /* ---------- 语音 ---------- */

    function ensureVoices() {
        return new Promise((resolve) => {
            const voices = speechSynthesis.getVoices();
            if (voices.length) {
                resolve(voices);
                return;
            }
            let done = false;
            speechSynthesis.addEventListener(
                "voiceschanged",
                () => {
                    if (!done) {
                        done = true;
                        resolve(speechSynthesis.getVoices());
                    }
                },
                { once: true }
            );
            setTimeout(() => {
                if (!done) {
                    done = true;
                    resolve(speechSynthesis.getVoices());
                }
            }, 1500);
        });
    }

    function pickVoice(voices) {
        const zh = voices.filter((v) => /^zh(-|_)?CN/i.test(v.lang) || v.lang === "zh");
        // 优先 Edge 的在线自然语音（如 Microsoft Xiaoxiao Online Natural）
        return (
            zh.find((v) => /natural/i.test(v.name)) ||
            zh.find((v) => /microsoft/i.test(v.name)) ||
            zh[0] ||
            null
        );
    }

    function splitChunks(text, max = 160) {
        // 长文本分段朗读，规避 Chromium 长 utterance 中途停止的老 bug
        const sentences = text.split(/(?<=[。！？；!?;\n])/);
        const chunks = [];
        let buf = "";
        for (const s of sentences) {
            if (buf.length + s.length > max && buf) {
                chunks.push(buf);
                buf = "";
            }
            if (s.length > max) {
                for (let i = 0; i < s.length; i += max) {
                    chunks.push(s.slice(i, i + max));
                }
            } else {
                buf += s;
            }
        }
        if (buf.trim()) {
            chunks.push(buf);
        }
        return chunks.filter((c) => c.trim());
    }

    function speakChunk(text, voice) {
        return new Promise((resolve, reject) => {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = "zh-CN";
            u.rate = 1.5;
            if (voice) {
                u.voice = voice;
            }
            u.onend = () => resolve();
            u.onerror = (e) => {
                log("utterance error:", e.error);
                if (e.error === "not-allowed") {
                    reject(new Error("not-allowed"));
                } else {
                    resolve(); // interrupted/canceled 等按结束处理
                }
            };
            speechSynthesis.speak(u);
        });
    }

    async function speakText(text, voice) {
        const chunks = splitChunks(text);
        log(`朗读文本共 ${text.length} 字，分 ${chunks.length} 段`);
        for (let i = 0; i < chunks.length; i++) {
            if (stopRequested) {
                log("检测到停止请求，中断朗读");
                return;
            }
            if (skipRequested) {
                log("检测到跳过请求，中断当前条目");
                return;
            }
            log(`朗读第 ${i + 1}/${chunks.length} 段:`, chunks[i].slice(0, 30) + "…");
            await speakChunk(chunks[i], voice);
        }
    }

    /* ---------- 页面内容提取 ---------- */

    async function expandItem(item) {
        const btn = item.querySelector("button.ContentItem-more");
        if (!btn) {
            log("无「阅读全文」按钮，跳过展开");
            return;
        }
        log("点击「阅读全文」展开");
        btn.click();
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            const rc = item.querySelector(".RichContent");
            if (!rc || !rc.classList.contains("is-collapsed")) {
                log("展开完成");
                return;
            }
            await sleep(100);
        }
        log("展开超时(2s)，仍为折叠状态，按现有内容朗读");
    }

    function extractTitle(item) {
        const meta = item.querySelector(".ContentItem-title [itemprop='name']");
        if (meta && meta.content) {
            return meta.content.trim();
        }
        const el = item.querySelector(".ContentItem-title");
        return el ? el.textContent.trim() : "";
    }

    function extractContent(root) {
        const inner = root.querySelector(".RichContent-inner") || root;
        const clone = inner.cloneNode(true);
        clone
            .querySelectorAll("button, noscript, style, figure, img, video, .RichContent-cover")
            .forEach((n) => n.remove());
        return clone.textContent.replace(/\s+/g, " ").replace(/阅读全文\s*$/, "").trim();
    }

    function extractAuthor(item) {
        const el = item.querySelector(".AuthorInfo-name");
        return el ? el.textContent.trim() : "";
    }

    async function buildQueueItem(item, title) {
        await expandItem(item);
        const content = extractContent(item);
        if (!content) {
            return null;
        }
        const author = extractAuthor(item);
        const parts = [];
        if (title) {
            parts.push("问题：" + title);
        }
        parts.push((author ? author + " 的回答：" : "回答：") + content);
        return parts.join("。");
    }

    function collectItems() {
        // 问题详情页
        const qTitle = document.querySelector(".QuestionHeader-title");
        if (qTitle) {
            const items = [
                ...document.querySelectorAll(".List-item .ContentItem.AnswerItem"),
            ];
            return { questionTitle: qTitle.textContent.trim(), items };
        }
        // 首页信息流
        let items = [...document.querySelectorAll(".TopstoryItem .ContentItem")];
        if (!items.length) {
            // 兜底：不依赖 TopstoryItem 容器，直接找回答/文章卡片
            items = [
                ...document.querySelectorAll(
                    ".ContentItem.AnswerItem, .ContentItem.ArticleItem"
                ),
            ];
        }
        return { questionTitle: "", items };
    }

    // 知乎是 SPA，信息流异步渲染，轮询等待内容出现
    async function waitForContent(timeoutMs = 20000) {
        const start = Date.now();
        let logged = false;
        while (Date.now() - start < timeoutMs) {
            const found = collectItems();
            if (found.items.length) {
                log(`内容已渲染，等待了 ${Date.now() - start}ms`);
                return found;
            }
            if (stopRequested) {
                return found;
            }
            if (!logged) {
                log("暂未找到内容条目，等待页面渲染…");
                logged = true;
            }
            await sleep(500);
        }
        log(`等待内容超时(${timeoutMs}ms)`);
        return collectItems();
    }

    /* ---------- 朗读流程 ---------- */

    function highlight(item) {
        clearHighlight();
        currentItem = item;
        item.style.outline = HIGHLIGHT_STYLE;
        item.style.outlineOffset = "2px";
        item.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function clearHighlight() {
        if (currentItem) {
            currentItem.style.outline = "";
            currentItem.style.outlineOffset = "";
            currentItem = null;
        }
    }

    async function startReading() {
        if (reading) {
            return;
        }
        reading = true;
        stopRequested = false;
        updateButton();
        log("开始朗读流程");

        const voices = await ensureVoices();
        const voice = pickVoice(voices);
        log(
            `可用语音 ${voices.length} 个，选用:`,
            voice ? `${voice.name} (${voice.lang})` : "(无中文语音，使用默认)"
        );
        const { questionTitle, items } = await waitForContent();
        log(
            questionTitle
                ? `问题详情页，问题: ${questionTitle.slice(0, 40)}，答案 ${items.length} 条`
                : `信息流页面，条目 ${items.length} 条`
        );
        if (!items.length) {
            log(
                "DOM 诊断:",
                `.TopstoryItem=${document.querySelectorAll(".TopstoryItem").length}`,
                `.ContentItem=${document.querySelectorAll(".ContentItem").length}`,
                `.AnswerItem=${document.querySelectorAll(".AnswerItem").length}`,
                `.RichContent-inner=${document.querySelectorAll(".RichContent-inner").length}`,
                `.Card=${document.querySelectorAll(".Card").length}`
            );
        }

        try {
            if (questionTitle && items.length === 0) {
                await speakText("问题：" + questionTitle, voice);
            }
            let isFirst = true;
            let index = 0;
            for (const item of items) {
                if (stopRequested) {
                    break;
                }
                skipRequested = false;
                index++;
                // 详情页只在第一条答案前朗读一次问题；信息流每条读各自的标题
                const title = questionTitle
                    ? isFirst
                        ? questionTitle
                        : ""
                    : extractTitle(item);
                isFirst = false;
                log(`—— 第 ${index}/${items.length} 条: ${(title || "(无标题)").slice(0, 40)}`);
                const text = await buildQueueItem(item, title);
                if (!text) {
                    log("未提取到内容，跳过");
                    continue;
                }
                if (stopRequested) {
                    break;
                }
                highlight(item);
                await speakText(text, voice);
            }
        } catch (e) {
            if (e && e.message === "not-allowed") {
                // 无用户手势被浏览器拦截，等用户点按钮
                console.warn("[zhihu-read-aloud] 自动朗读被浏览器拦截 (not-allowed)，请点击右下角「朗读」按钮手动开始");
            } else {
                console.warn("[zhihu-read-aloud] 朗读流程异常:", e);
            }
        } finally {
            clearHighlight();
            reading = false;
            stopRequested = false;
            skipRequested = false;
            updateButton();
            log("朗读流程结束");
        }
    }

    function stopReading() {
        log("用户点击停止");
        stopRequested = true;
        speechSynthesis.cancel();
        clearHighlight();
    }

    function skipToNext() {
        if (!reading) {
            return;
        }
        log("用户点击下一条，跳过当前条目");
        skipRequested = true;
        speechSynthesis.cancel();
    }

    /* ---------- 控制按钮 ---------- */

    function updateButton() {
        const btn = document.getElementById(BTN_ID);
        if (btn) {
            btn.textContent = reading ? "⏹ 停止朗读" : "🔊 朗读";
        }
        const nextBtn = document.getElementById(NEXT_BTN_ID);
        if (nextBtn) {
            nextBtn.style.display = reading ? "" : "none";
        }
    }

    function baseButtonStyle(bottom) {
        return [
            "position:fixed",
            `bottom:${bottom}px`,
            "right:24px",
            "z-index:2147483647",
            "padding:10px 16px",
            "background:#1772f6",
            "color:#fff",
            "border:none",
            "border-radius:20px",
            "font:600 34px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
            "cursor:pointer",
            "box-shadow:0 2px 10px rgba(0,0,0,0.3)",
        ].join(";");
    }

    function createButton(id, text, title, bottom, onClick) {
        const btn = document.createElement("button");
        btn.id = id;
        btn.type = "button";
        btn.textContent = text;
        btn.title = title;
        btn.style.cssText = baseButtonStyle(bottom);
        btn.addEventListener("click", onClick);
        return btn;
    }

    function injectButton() {
        const parent = document.body || document.documentElement;
        if (!document.getElementById(BTN_ID)) {
            parent.appendChild(
                createButton(BTN_ID, "🔊 朗读", "朗读页面中的问题和答案", 24, () => {
                    if (reading) {
                        stopReading();
                    } else {
                        startReading();
                    }
                })
            );
        }
        if (!document.getElementById(NEXT_BTN_ID)) {
            parent.appendChild(
                createButton(NEXT_BTN_ID, "⏭ 下一条", "跳过当前，朗读下一个问题和答案", 68, skipToNext)
            );
        }
        updateButton();
        startButtonGuard();
    }

    // 知乎 SPA 重渲染可能把按钮从 DOM 移除，被移除后自动补回，保证始终可见
    let buttonGuard = null;

    function startButtonGuard() {
        if (buttonGuard) {
            return;
        }
        buttonGuard = new MutationObserver(() => {
            if (!document.getElementById(BTN_ID) || !document.getElementById(NEXT_BTN_ID)) {
                log("检测到按钮被移除，重新注入");
                injectButton();
            }
        });
        buttonGuard.observe(document.body || document.documentElement, { childList: true });
    }

    function stopButtonGuard() {
        if (buttonGuard) {
            buttonGuard.disconnect();
            buttonGuard = null;
        }
    }

    window.addEventListener("beforeunload", () => speechSynthesis.cancel());

    function removeButtons() {
        stopButtonGuard();
        [BTN_ID, NEXT_BTN_ID].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.remove();
            }
        });
    }

    function init() {
        log("已加载，页面:", location.href);
        chrome.storage.local.get(["zhihuReadAloudEnabled"], (result) => {
            const enabled = result.zhihuReadAloudEnabled !== false;
            log("启用状态:", enabled);
            if (!enabled) {
                return;
            }
            injectButton();
            // 等信息流渲染完成后自动开始朗读
            setTimeout(() => {
                if (!reading) {
                    log("1.5s 后触发自动朗读");
                    startReading();
                }
            }, 1500);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "local" || !changes.zhihuReadAloudEnabled) {
                return;
            }
            const enabled = changes.zhihuReadAloudEnabled.newValue !== false;
            log("启用状态变更:", enabled);
            if (enabled) {
                injectButton();
            } else {
                stopReading();
                removeButtons();
            }
        });
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        init();
    } else {
        document.addEventListener("DOMContentLoaded", init, { once: true });
    }
})();

/**
 * 知乎答案截图：右键菜单「截图这条回答」的页面侧。
 *
 * 截图本身由 background 用 chrome.debugger 临时把视口拉高到答案高度后 Page.captureScreenshot，
 * 能截超出屏幕的部分；这里负责定位答案、展开全文、加载懒加载图片、
 * 临时去掉会叠进图里的 fixed/sticky 元素，并在截完后复制到剪贴板 + 下载。
 */
(function () {
    "use strict";

    if (window.__zhihuAnswerScreenshotLoaded) {
        return;
    }
    window.__zhihuAnswerScreenshotLoaded = true;

    let lastTarget = null;
    let restoreFns = [];

    document.addEventListener("contextmenu", (e) => {
        lastTarget = e.target;
    }, true);

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    function findAnswer(target) {
        const item = target && target.closest && target.closest(".ContentItem");
        if (!item) {
            return null;
        }
        // 外层卡片有白底和内边距，截出来比裸 ContentItem 好看
        return { item, box: item.closest(".List-item") || item.closest(".Card") || item };
    }

    async function expand(item) {
        const btn = item.querySelector("button.ContentItem-more");
        if (!btn) {
            return;
        }
        btn.click();
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            const rc = item.querySelector(".RichContent");
            if (!rc || !rc.classList.contains("is-collapsed")) {
                return;
            }
            await sleep(100);
        }
    }

    async function loadImages(box) {
        const pending = [];
        box.querySelectorAll("img").forEach((img) => {
            const real = img.dataset.actualsrc || img.dataset.original;
            if (real && img.src !== real && (!img.src || img.src.startsWith("data:"))) {
                img.src = real;
            }
            img.loading = "eager";
            if (!img.complete) {
                pending.push(new Promise((r) => {
                    img.addEventListener("load", r, { once: true });
                    img.addEventListener("error", r, { once: true });
                }));
            }
        });
        await Promise.race([Promise.all(pending), sleep(5000)]);
    }

    function setStyle(el, prop, value) {
        const old = el.style.getPropertyValue(prop);
        const oldPriority = el.style.getPropertyPriority(prop);
        el.style.setProperty(prop, value, "important");
        restoreFns.push(() => el.style.setProperty(prop, old, oldPriority));
    }

    // 答案内部的吸底操作栏放回原位；答案外部的悬浮物（顶栏、朗读按钮等）隐藏
    function neutralizeFloating(box) {
        for (const el of document.body.querySelectorAll("*")) {
            const pos = getComputedStyle(el).position;
            if (pos !== "fixed" && pos !== "sticky") {
                continue;
            }
            if (box.contains(el)) {
                setStyle(el, "position", "static");
                setStyle(el, "transform", "none");
            } else if (!el.contains(box)) {
                setStyle(el, "visibility", "hidden");
            }
        }
    }

    const SHARE_ATTR = "data-zhihu-share-shot";
    const SHARE_CSS = `
        [${SHARE_ATTR}] {
            width: 430px !important; max-width: 430px !important; box-sizing: border-box !important;
            padding: 20px 18px !important; margin: 0 !important; background: #fff !important;
        }
        [${SHARE_ATTR}] .RichText, [${SHARE_ATTR}] .ztext { font-size: 19px !important; line-height: 1.8 !important; }
        [${SHARE_ATTR}] .RichText p { margin: 0 0 0.9em !important; }
        [${SHARE_ATTR}] .RichText img { max-width: 100% !important; height: auto !important; }
        [${SHARE_ATTR}] .AuthorInfo-name { font-size: 17px !important; }
        [${SHARE_ATTR}] .ContentItem-title { font-size: 21px !important; line-height: 1.5 !important; }
        [${SHARE_ATTR}] .ContentItem-actions, [${SHARE_ATTR}] .FollowButton,
        [${SHARE_ATTR}] .ContentItem-expandButton, [${SHARE_ATTR}] .Reward { display: none !important; }
        [${SHARE_ATTR}] .__zhihu_shot_question__ {
            font: 600 22px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
            color: #121212; margin: 0 0 14px; padding-bottom: 12px; border-bottom: 1px solid #ebebeb;
        }
    `;

    // 窄版面 + 大字号，导出图在手机上不用放大就能读
    function applyShareLayout(found) {
        const style = document.createElement("style");
        style.textContent = SHARE_CSS;
        document.head.appendChild(style);
        found.box.setAttribute(SHARE_ATTR, "");
        restoreFns.push(() => {
            style.remove();
            found.box.removeAttribute(SHARE_ATTR);
        });
        // 详情页的问题标题不在答案卡片里，分享出去没有上下文，临时补一个
        const question = document.querySelector(".QuestionHeader-title");
        if (question && !found.item.querySelector(".ContentItem-title")) {
            const h = document.createElement("div");
            h.className = "__zhihu_shot_question__";
            h.textContent = question.textContent.trim();
            found.box.prepend(h);
            restoreFns.push(() => h.remove());
        }
    }

    function restore() {
        restoreFns.reverse().forEach((fn) => fn());
        restoreFns = [];
        if (current) {
            window.scrollTo(current.scrollX, current.scrollY);
            current = null;
        }
    }

    let current = null;

    async function prepare() {
        const found = findAnswer(lastTarget);
        if (!found) {
            return { error: "请在某条回答上右键再截图" };
        }
        await expand(found.item);
        current = { box: found.box, scrollX: window.scrollX, scrollY: window.scrollY };
        applyShareLayout(found);
        await loadImages(found.box);
        return {
            width: window.innerWidth,
            height: Math.ceil(found.box.getBoundingClientRect().height),
            name: fileName(found.item),
        };
    }

    // background 已把视口拉高到答案高度：把答案滚到视口顶端，整条回答就都在视口内
    async function measure() {
        const box = current.box;
        neutralizeFloating(box);
        window.scrollTo(0, box.getBoundingClientRect().top + window.scrollY);
        await sleep(300);
        const r = box.getBoundingClientRect();
        return {
            x: r.left + window.scrollX,
            y: r.top + window.scrollY,
            width: r.width,
            height: r.height,
        };
    }

    function fileName(item) {
        const title = (document.querySelector(".QuestionHeader-title") || item.querySelector(".ContentItem-title"));
        const author = item.querySelector(".AuthorInfo-name");
        const parts = [title && title.textContent.trim().slice(0, 40), author && author.textContent.trim()];
        const base = parts.filter(Boolean).join("-") || "zhihu-answer";
        return base.replace(/[\\/:*?"<>|\s]+/g, "_") + ".png";
    }

    async function deliver(dataUrl, name) {
        const blob = await (await fetch(dataUrl)).blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        try {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            return "截图已复制到剪贴板并下载";
        } catch (e) {
            console.warn("[zhihu-answer-screenshot] clipboard write failed:", e);
            return "截图已下载（复制到剪贴板失败）";
        }
    }

    function toast(text) {
        const el = document.createElement("div");
        el.textContent = text;
        el.style.cssText = [
            "position:fixed", "top:80px", "left:50%", "transform:translateX(-50%)",
            "z-index:2147483647", "padding:10px 18px", "border-radius:8px",
            "background:rgba(0,0,0,0.8)", "color:#fff", "font:14px/1.4 -apple-system,sans-serif",
        ].join(";");
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        const steps = { "zhihu-shot-prepare": prepare, "zhihu-shot-measure": measure };
        if (!msg || !steps[msg.type] && msg.type !== "zhihu-shot-result") {
            return;
        }
        if (steps[msg.type]) {
            steps[msg.type]().then(sendResponse, (e) => {
                sendResponse({ error: "截图准备失败: " + (e && e.message) });
            });
            return true;
        }
        restore();
        if (msg.error) {
            toast(msg.error);
            return;
        }
        deliver(msg.dataUrl, msg.name).then(toast, (e) => toast("保存截图失败: " + (e && e.message)));
    });
})();

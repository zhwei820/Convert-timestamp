/**
 * GitLab pipeline 监听器：DOM 模式
 *
 * 通过 manifest 的 content_scripts.matches 限定到 gitlab.matrixport.com。
 * 在页面上找所有 pipeline 状态元素（兼容 ci-status-icon-* 旧 class 与
 * data-testid="status_<state>_borderless-icon" 新 SVG），通过 MutationObserver
 * + 定时兜底扫描检测从 running/pending 到终态（success/failed/...）的跳变，
 * 然后让 background.js 弹一个 chrome.notifications 通知。
 *
 * 仅监听当前 tab，关闭页面即停止。
 */
(function () {
    "use strict";

    console.log("[gitlab-pipeline-monitor] script injected at", location.href);

    if (window.__gitlabPipelineMonitorLoaded) {
        console.log("[gitlab-pipeline-monitor] already loaded, skipping");
        return;
    }
    window.__gitlabPipelineMonitorLoaded = true;

    const RUNNING_STATES = new Set([
        "running",
        "pending",
        "preparing",
        "created",
        "waiting-for-resource",
        "waiting_for_resource",
        "scheduled",
    ]);

    const TERMINAL_STATES = new Set([
        "success",
        "passed",
        "failed",
        "canceled",
        "cancelled",
        "skipped",
        "manual",
    ]);

    // pipelineKey -> { status, url, ref, project }
    const tracked = new Map();
    let observer = null;
    let pollTimer = null;
    let enabled = false;

    /**
     * 从 status icon 元素的 class / data-testid / SVG <use href> 里提取状态
     *
     * 老版本 GitLab:   class="ci-status-icon-running"
     * 新版本 GitLab:   <svg data-testid="status_running_borderless-icon">
     *                  <use href="...svg#status_running_borderless"></use>
     */
    function extractStatusFromClasses(el) {
        if (!el) return null;
        // 1. 旧版 class
        if (el.classList) {
            for (let i = 0; i < el.classList.length; i++) {
                const c = el.classList[i];
                if (c.indexOf("ci-status-icon-") === 0) {
                    return c.substring("ci-status-icon-".length).toLowerCase();
                }
            }
        }
        // 2. 新版 data-testid，例如 "status_running_borderless-icon"
        const testid =
            (el.getAttribute && el.getAttribute("data-testid")) || "";
        const m = testid.match(/^status_([a-z_]+?)(?:_borderless|_solid|_tanuki)?-icon$/);
        if (m) {
            return m[1].toLowerCase().replace(/_/g, "-");
        }
        // 3. 兜底：找子节点里的 <use href="...#status_xxx_borderless">
        if (el.querySelector) {
            const use = el.querySelector("use[href]");
            if (use) {
                const href = use.getAttribute("href") || "";
                const hm = href.match(/#status_([a-z_]+?)(?:_borderless|_solid|_tanuki)?$/);
                if (hm) return hm[1].toLowerCase().replace(/_/g, "-");
            }
        }
        return null;
    }

    /**
     * 给状态元素找一个稳定的 pipeline 标识。只关心 pipeline 级别，不通知单个 job。
     * 优先级：
     *   1. 祖先 <a href> 命中 /pipelines/<id>
     *   2. data-pipeline-id 属性
     *   3. 当前页面 URL 命中 /pipelines/<id>，且该元素不在某个 /jobs/<id> 链接内
     *      （pipeline 详情页的页头图标兜底，排除每行 job 的图标）
     */
    function findPipelineKey(el) {
        let node = el;
        let insideJobAnchor = false;
        for (let i = 0; i < 10 && node; i++) {
            if (node.tagName === "A" && node.href) {
                const pm = node.href.match(/\/pipelines\/(\d+)/);
                if (pm) {
                    return {
                        key: node.href.replace(/[?#].*$/, ""),
                        url: node.href,
                    };
                }
                if (/\/jobs\/\d+/.test(node.href)) {
                    insideJobAnchor = true;
                }
            }
            if (node.dataset && node.dataset.pipelineId) {
                return {
                    key: "pid:" + node.dataset.pipelineId,
                    url: location.href,
                };
            }
            node = node.parentElement;
        }
        if (insideJobAnchor) return null;
        const pageMatch = location.pathname.match(/\/pipelines\/(\d+)/);
        if (pageMatch) {
            return {
                key: location.origin + location.pathname.replace(/\/pipelines\/(\d+).*/, "/pipelines/" + pageMatch[1]),
                url: location.href,
            };
        }
        return null;
    }

    function findStatusElements() {
        // 同时支持新旧 GitLab：
        //   旧: .ci-status-icon-running ...
        //   新: <svg data-testid="status_running_borderless-icon">
        const set = new Set();
        document
            .querySelectorAll('[class*="ci-status-icon-"]')
            .forEach(function (el) {
                set.add(el);
            });
        document
            .querySelectorAll('[data-testid^="status_"][data-testid$="-icon"]')
            .forEach(function (el) {
                set.add(el);
            });
        return Array.from(set);
    }

    function scanOnce() {
        if (!enabled) return;
        const statusEls = findStatusElements();
        console.log(
            "[gitlab-pipeline-monitor] scanning... found",
            statusEls.length,
            "status element(s)"
        );

        // 当前快照：key -> { status, url }
        const snapshot = new Map();
        for (const el of statusEls) {
            const status = extractStatusFromClasses(el);
            if (!status) continue;
            const info = findPipelineKey(el);
            if (!info) continue;
            // 同一个 pipeline 可能在页面里出现多次，保留第一次扫到的
            if (!snapshot.has(info.key)) {
                snapshot.set(info.key, { status: status, url: info.url });
            }
        }

        // 对比上一次 tracked，找出状态变化
        for (const [key, cur] of snapshot.entries()) {
            const prev = tracked.get(key);
            const newlyRunning =
                RUNNING_STATES.has(cur.status) &&
                (!prev || prev.status !== cur.status);
            if (newlyRunning) {
                console.log(
                    "[gitlab-pipeline-monitor] detected RUNNING pipeline:",
                    {
                        status: cur.status,
                        prevStatus: prev ? prev.status : null,
                        url: cur.url,
                        key: key,
                    }
                );
            }
            if (prev && RUNNING_STATES.has(prev.status) && TERMINAL_STATES.has(cur.status)) {
                console.log(
                    "[gitlab-pipeline-monitor] pipeline FINISHED:",
                    {
                        from: prev.status,
                        to: cur.status,
                        url: cur.url,
                        key: key,
                    }
                );
                notifyFinished(key, prev.status, cur.status, cur.url);
            }
            tracked.set(key, cur);
        }

        // 清理已经从页面消失的条目（避免内存无限增长）
        for (const key of Array.from(tracked.keys())) {
            if (!snapshot.has(key)) {
                tracked.delete(key);
            }
        }
    }

    function notifyFinished(key, fromStatus, toStatus, url) {
        try {
            const payload = {
                type: "gitlab-pipeline-finished",
                pipelineKey: key,
                fromStatus: fromStatus,
                toStatus: toStatus,
                url: url || location.href,
                pageTitle: document.title,
                host: location.host,
            };
            const sending = chrome.runtime.sendMessage(payload);
            if (sending && typeof sending.catch === "function") {
                sending.catch(function () {});
            }
        } catch (e) {
            // background 可能未就绪
        }
        playBeep(toStatus);
    }

    /**
     * 用 Web Audio API 播放一段提示音。不依赖任何音频文件或 OS 通知声音设置。
     * 成功类：两声上升；失败类：两声下降；其它：单声。
     */
    function playBeep(toStatus) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const isFail = toStatus === "failed" || toStatus === "canceled" || toStatus === "cancelled";
            const isSuccess = toStatus === "success" || toStatus === "passed";

            const notes = isSuccess
                ? [880, 1320]       // A5 → E6
                : isFail
                ? [660, 330]        // E5 → E4
                : [880];

            const now = ctx.currentTime;
            const stepDur = 0.18;
            notes.forEach(function (freq, i) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                const start = now + i * (stepDur + 0.04);
                const end = start + stepDur;
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
                gain.gain.linearRampToValueAtTime(0, end);
                osc.connect(gain).connect(ctx.destination);
                osc.start(start);
                osc.stop(end + 0.02);
            });

            // 关掉 AudioContext，避免长期占用
            setTimeout(function () {
                ctx.close().catch(function () {});
            }, (notes.length * 250) + 200);
        } catch (e) {
            console.warn("[gitlab-pipeline-monitor] playBeep failed:", e && e.message);
        }
    }

    function start() {
        if (enabled) return;
        enabled = true;
        console.log("[gitlab-pipeline-monitor] started on", location.href);

        // 首次扫描：建立基线，不发通知
        const baseline = findStatusElements();
        const baselineRunning = [];
        for (const el of baseline) {
            const status = extractStatusFromClasses(el);
            if (!status) continue;
            const info = findPipelineKey(el);
            if (!info) continue;
            if (!tracked.has(info.key)) {
                tracked.set(info.key, { status: status, url: info.url });
                if (RUNNING_STATES.has(status)) {
                    baselineRunning.push({ status: status, url: info.url, key: info.key });
                }
            }
        }
        if (baselineRunning.length > 0) {
            console.log(
                "[gitlab-pipeline-monitor] baseline running pipelines:",
                baselineRunning
            );
        } else {
            console.log("[gitlab-pipeline-monitor] no running pipelines on baseline");
        }

        // 后续 MutationObserver + 周期复扫
        observer = new MutationObserver(function () {
            // 用 microtask 合并爆发性的 DOM 变化
            if (start._scheduled) return;
            start._scheduled = true;
            Promise.resolve().then(function () {
                start._scheduled = false;
                scanOnce();
            });
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "data-testid", "href"],
        });

        // 兜底定时器：每 10s 强制扫一次（防止 SVG 重绘等不触发 attribute 变化的场景）
        pollTimer = setInterval(scanOnce, 10000);
    }

    start();
})();

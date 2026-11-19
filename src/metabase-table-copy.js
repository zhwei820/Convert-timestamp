/**
 * Metabase 表格右键复制
 *
 * Metabase 结果表是虚拟滚动的 div 网格，单元格挂着点击/下钻/拖拽事件，无法选中复制。
 * 右键单元格：复制该格；Shift+右键：复制当前已渲染的整行（Tab 分隔）；
 * 右键列头：复制列名；Alt+右键：放行浏览器原生菜单。
 *
 * 选择器只依赖 role / data-testid；横向也是虚拟滚动，整行只含屏幕上已渲染的列。
 */
(function () {
  if (window.__mbTableCopyInstalled) return;
  window.__mbTableCopyInstalled = true;

  const style = document.createElement('style');
  style.textContent = `
    [data-testid="table-root"] [role="gridcell"],
    [data-testid="table-root"] [role="gridcell"] *,
    [data-testid="table-root"] [role="columnheader"] * {
      user-select: text !important; -webkit-user-select: text !important;
    }`;
  (document.head || document.documentElement).appendChild(style);

  const cellText = (cell) =>
    (cell.querySelector('[data-testid="cell-data"]') || cell).innerText.trim();

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  let toastEl, toastTimer;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
        'background:#303d46;color:#fff;padding:6px 12px;border-radius:6px;font-size:12px;' +
        'max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = 'none'), 1500);
  }

  // 捕获阶段注册，抢在 Metabase 自己的处理之前
  window.addEventListener('contextmenu', (e) => {
    if (e.altKey) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || !target.closest('[data-testid="table-root"]')) return;

    const header = target.closest('[role="columnheader"]');
    const cell = target.closest('[role="gridcell"]');
    if (!header && !cell) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    let text;
    if (header) {
      text = header.innerText.trim();
    } else if (e.shiftKey) {
      const row = cell.closest('[role="row"]');
      text = [...row.querySelectorAll('[role="gridcell"][data-column-id]')]
        .filter((c) => c.dataset.columnId !== '_INDEX')
        .map(cellText)
        .join('\t');
    } else {
      text = cellText(cell);
    }
    copy(text).then(() => toast('已复制：' + (text || '(空)')));
  }, true);
})();

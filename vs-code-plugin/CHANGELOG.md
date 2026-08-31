# 更新日志

## 3.0.0

撤回 2.0.0 的副侧边栏方案，改回状态栏，并**钉在最右端**。

- 回到状态栏显示，位置写死在右侧最末位：`priority = -1000000`（`StatusBarAlignment.Right` 下 priority 越大越靠左，所以要靠右得取足够小的负数）
- 改用带 `id` 的 `createStatusBarItem` 重载，VS Code 会记住用户对这一项的显隐和拖动位置
- **移除**副侧边栏视图容器、WebviewView 卡片、`media/icon.svg`，以及 `solPrice.show` 命令
- **移除** `solPrice.alignment` 和 `solPrice.priority` 两个配置项 —— 位置固定，不再可配
- 恢复 1.0.0 的悬停 Markdown 详情卡、点击 QuickPick 菜单，以及 `solPrice.showChangePercent`、`solPrice.icon` 配置项
- 保留 2.0.0 加的 JSDoc 类型标注（`Snapshot` / `Source` / `Parsed` typedef），`make typecheck` 全绿

## 2.0.0

把价格从底部状态栏搬到右上角的副侧边栏卡片。**已在 3.0.0 撤回** —— 副侧边栏默认关着、需要手动 ⌥⌘B 打开，还占一条编辑器宽度，不如状态栏零操作常驻。

- 新增副侧边栏视图容器 + WebviewView 卡片：大号价格、24h 涨跌幅、24h 高 / 低、更新时间、数据源
- 卡片不可见时停掉定时器，重新露出来立刻补一刷
- 移除状态栏显示及 `alignment` / `priority` / `showChangePercent` / `icon` 四个配置项

## 1.0.0

首个版本，把 Chrome 扩展里的 SOL 价格徽章搬到 VS Code 状态栏。

- 状态栏常驻显示价格 + 24h 涨跌幅，涨绿跌红（可切成红涨绿跌）
- 悬停展示 24h 高 / 低、数据源、更新时间，附「刷新 / 复制 / 设置」链接
- 点击弹出菜单：刷新、复制价格、切换币种、打开行情页、设置、查看日志
- 三个数据源自动回落：Binance → OKX → CoinGecko
- 全部源失败时灰显上一次的价格而不是留白；`globalState` 缓存让冷启动不闪空
- 窗口重新聚焦且数据已过期时自动补刷一次

# SOL 实时价格（VS Code 插件）

在 VS Code **状态栏最右端**常驻显示 Solana 最新价，涨绿跌红，悬停看 24h 涨跌 / 高低点 / 更新时间。

是同仓库那个 Chrome 扩展里 SOL 价格徽章（`../src/sol-price-badge.js`）的 VS Code 版本 —— 浏览器那边把价格写在扩展图标的 badge 上，这边写在状态栏上，都是「屏幕上一直看得见、且零操作」的位置。

```
┌───────────────────────────────────────────────────────────┐
│  资源管理器 │  extension.js                               │
│             │                                             │
│   src/      │   const vscode = require("vscode");         │
│    ...      │                                             │
├───────────────────────────────────────────────────────────┤
│ ⎇ dev  ⊗0 ⚠0        行 1，列 1  UTF-8  ◉ SOL $102.78 -2.16%│
└───────────────────────────────────────────────────────────┘
                                          最右端 ↑ 涨绿跌红
```

## 功能

- **状态栏最右端常驻**：`◉ SOL $102.78 -2.16%`，钉在状态栏右侧的最末位
- **涨绿跌红**：24h 涨跌决定文字颜色；想换成 A 股的红涨绿跌，打开 `solPrice.invertColors`
- **悬停详情**：24h 涨跌幅、24h 高 / 低、数据源、更新时间（含「x 秒前」），外加「立即刷新 / 复制价格 / 设置」三个可点链接
- **点击菜单**：点状态栏弹出菜单 —— 立即刷新、复制价格、切换币种、打开 Binance 行情页、插件设置、查看日志
- **三源自动回落**：Binance → OKX → CoinGecko，前一个失败才走下一个（Binance 在部分地区会被拦，OKX 最通用）
- **拉不到不留白**：全部源都失败时，把上一次的价格**灰掉继续显示**并在悬停里标 ⚠ 和连续失败次数，而不是把状态栏空着 —— 空着比旧价格更容易让人误判
- **冷启动不闪空**：上次的价格存在 `globalState` 里，插件一激活先用缓存把状态栏点亮，再打请求
- **切回窗口自动补刷**：从别处切回 VS Code 时，如果手上数据已过期就立刻刷一次，不用等下一个定时 tick
- **不只是 SOL**：`solPrice.symbol` 改成 `BTC` / `ETH` / 任何 Binance 或 OKX 上对 USDT 的币种代号都行

## 装上跑起来

```bash
cd vs-code-plugin
make            # 看所有可用命令
make install    # 打包 + 装进本机 VS Code，重启后生效（最常用）
make dev        # 开一个加载了本插件的调试窗口，等价于按 F5
```

| 命令 | 作用 |
| --- | --- |
| `make deps` | 装开发依赖（只有类型定义和 tsc，插件运行时零依赖） |
| `make typecheck` | 对着真实的 vscode API 类型定义做检查 |
| `make package` | 打包成 `dist/sol-price-status-bar-<版本>.vsix`（会先跑类型检查） |
| `make install` | `make package` + `code --install-extension --force` |
| `make uninstall` | 从本机 VS Code 卸载 |
| `make dev` | 开调试窗口（等价于 F5） |
| `make clean` | 删掉 `dist/` |
| `make version` | 打印插件 id 和版本 |

不用 make 也行：`npm install && npx @vscode/vsce package`，然后 `code --install-extension`。

装完 **⇧⌘P → `Developer: Reload Window`**（或重启 VS Code）就能在状态栏右下角看到。

## 设置

命令面板搜 `SOL 价格`，或者在设置里搜 `solPrice`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `solPrice.symbol` | `SOL` | 币种代号（对 USDT 计价），只填代号本身，不要带 `USDT` |
| `solPrice.refreshIntervalSeconds` | `30` | 刷新间隔（秒），低于 5 会被抬回 5，避免被交易所限流 |
| `solPrice.showChangePercent` | `true` | 状态栏里跟着显示 24h 涨跌幅 |
| `solPrice.colorize` | `true` | 按涨跌给文字上色 |
| `solPrice.invertColors` | `false` | 换成 A 股习惯的红涨绿跌 |
| `solPrice.icon` | `$(pulse)` | 价格前的图标，[codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) 语法，留空则不显示 |

改设置立即生效，不用重启：改 `symbol` 会立刻重新拉一次，改图标 / 颜色之类的纯显示项直接用手上的数据重画（不会多打一次请求）。

**位置不可配**，写死在状态栏最右端。原理：`StatusBarAlignment.Right` 里 `priority` 是**越大越靠左**（`vscode.d.ts` 原文：*Higher values mean the item should be shown more to the left*），所以这里取了 `-1000000` —— 足够小，能压过别的插件常用的那些负数优先级。

两点说明：

- 状态栏**最右侧的通知铃铛**不是插件能占的位置，它由 VS Code 固定渲染在所有条目之后。所以「最右端」= 所有条目里的最末位，铃铛的左边。
- VS Code 允许用户**拖动**状态栏条目，拖过之后它会记住你的手动位置、不再看 `priority`。想恢复默认位置：右键状态栏 →「重置位置」（Reset Location）。

## 和 Chrome 版的区别

| | Chrome 扩展 badge | VS Code 状态栏 |
| --- | --- | --- |
| 定时机制 | `chrome.alarms`（service worker 随时被回收，不能用 `setInterval`） | `setInterval`（扩展宿主是长驻进程） |
| 刷新下限 | 1 分钟（MV3 硬限制） | 5 秒（自己设的限流保护） |
| 显示宽度 | 约 4 个字符，得按价格量级砍小数位 | 宽松，可以直接放 `SOL $102.78 -2.16%` |
| 数据源 | Binance → CoinGecko | Binance → OKX → CoinGecko |

## 为什么不是右上角

试过副侧边栏方案（v2.0.0），最后撤回了。VS Code 能放动态价格的位置只有这些：

| 位置 | 能不能放动态价格 | 结论 |
| --- | --- | --- |
| 窗口标题栏右上角 | ❌ | 没有对应的贡献点 |
| 编辑器右上角图标区（`editor/title`） | ❌ | 图标和文案是 `package.json` 里的静态值，没有运行时改它的 API |
| 副侧边栏（`viewsContainers.secondarySidebar`） | ✅ | 真在右上角，但**默认关着**、要手动 ⌥⌘B 打开，还占一条编辑器宽度 |
| **底部状态栏** | ✅ | 零操作常驻、不占编辑器空间。当前实现 |

## 排查

- **状态栏一直显示 `SOL —`**：点它 → 「查看日志」，输出面板里有每个数据源的失败原因。常见是公司代理拦了交易所域名 —— 注意 Node 的全局 `fetch` **不走** VS Code 的 `http.proxy` 设置，需要在环境变量层面配代理。
- **换了币种显示不出来**：确认这个代号在 Binance 或 OKX 上有对 USDT 的交易对（比如填 `SOL` 而不是 `SOLANA`）。
- **看不见价格**：右键状态栏，在列表里找「SOL 实时价格」确认没被隐藏；如果之前手动拖过位置，右键 →「重置位置」。

## 源码

只有一个文件：[`src/extension.js`](src/extension.js)，纯 JavaScript，零运行时依赖，不需要编译。类型检查跑 `make typecheck`。

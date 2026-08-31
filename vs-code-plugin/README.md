# SOL 实时价格（VS Code 插件）

在 VS Code **状态栏**常驻显示 Solana 最新价，涨绿跌红，悬停看 24h 涨跌 / 高低点 / 更新时间。

是同仓库那个 Chrome 扩展里 SOL 价格徽章（`../src/sol-price-badge.js`）的 VS Code 版本 —— 浏览器那边把价格写在扩展图标的 badge 上，这边写在状态栏上，都是「屏幕上一直看得见」的位置。

```
                                              ┌─────────────────────────┐
  状态栏右侧 ──────────────────────────────────│ ◉ SOL $102.78  -2.16%   │
                                              └─────────────────────────┘
```

## 功能

- **状态栏常驻**：`◉ SOL $102.78 -2.16%`，默认排在状态栏右侧一组的最左边（最显眼的位置）
- **涨绿跌红**：24h 涨跌决定文字颜色；想换成 A 股的红涨绿跌，打开 `solPrice.invertColors`
- **悬停详情**：24h 涨跌幅、24h 高 / 低、数据源、更新时间，外加「立即刷新 / 复制价格 / 设置」三个可点链接
- **点击菜单**：点状态栏弹出菜单 —— 立即刷新、复制价格、切换币种、打开 Binance 行情页、插件设置、查看日志
- **三源自动回落**：Binance → OKX → CoinGecko，前一个失败才走下一个（Binance 在部分地区会被拦，OKX 最通用）
- **拉不到不留白**：全部源都失败时，把上一次的价格**灰掉继续显示**并在悬停里标 ⚠，而不是把状态栏空着 —— 空着比旧价格更容易让人误判
- **冷启动不闪空**：上次的价格存在 `globalState` 里，插件一激活先用缓存把状态栏点亮，再打请求
- **切回窗口自动补刷**：从别处切回 VS Code 时，如果手上数据已过期就立刻刷一次，不用等下一个定时 tick
- **不只是 SOL**：`solPrice.symbol` 改成 `BTC` / `ETH` / 任何 Binance 或 OKX 上对 USDT 的币种代号都行

## 装上跑起来

**本地调试（改代码看效果）**

```bash
cd vs-code-plugin
npm install          # 可选，只装类型定义，插件本身零运行时依赖
code .
```

然后按 <kbd>F5</kbd>（或菜单「运行 → 启动调试」），会开一个新的 VS Code 窗口，状态栏右侧就是价格。

**装到日常用的 VS Code 里**

```bash
cd vs-code-plugin
npx --yes @vscode/vsce package        # 产出 sol-price-status-bar-1.0.0.vsix
code --install-extension sol-price-status-bar-1.0.0.vsix
```

装完重启 VS Code 即可。（`vsce package` 会提醒缺 `icon` 和 `repository` 字段 —— 只在发到 Marketplace 时才需要补，本地装可以忽略。）

## 设置

命令面板搜 `SOL 价格`，或者在设置里搜 `solPrice`：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `solPrice.symbol` | `SOL` | 币种代号（对 USDT 计价），只填代号本身，不要带 `USDT` |
| `solPrice.refreshIntervalSeconds` | `30` | 刷新间隔（秒），低于 5 会被抬回 5，避免被交易所限流 |
| `solPrice.alignment` | `right` | 状态栏左侧还是右侧 |
| `solPrice.priority` | `1000` | 排序权重，**数值越大越靠左** |
| `solPrice.showChangePercent` | `true` | 状态栏里跟着显示 24h 涨跌幅 |
| `solPrice.colorize` | `true` | 按涨跌给文字上色 |
| `solPrice.invertColors` | `false` | 换成 A 股习惯的红涨绿跌 |
| `solPrice.icon` | `$(pulse)` | 价格前的图标，[codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) 语法，留空则不显示 |

改设置立即生效，不用重启：改 `alignment` / `priority` 会重建状态栏条目，改 `symbol` 会立刻重新拉一次，改颜色 / 图标之类的纯显示项直接用手上的数据重画（不会多打一次请求）。

## 和 Chrome 版的区别

| | Chrome 扩展 badge | VS Code 状态栏 |
| --- | --- | --- |
| 定时机制 | `chrome.alarms`（service worker 随时被回收，不能用 `setInterval`） | `setInterval`（扩展宿主是长驻进程） |
| 刷新下限 | 1 分钟（MV3 硬限制） | 5 秒（自己设的限流保护） |
| 显示宽度 | 约 4 个字符，得按价格量级砍小数位 | 宽松，可以直接放 `SOL $102.78 -2.16%` |
| 数据源 | Binance → CoinGecko | Binance → OKX → CoinGecko |

## 排查

- **状态栏一直显示 `SOL —`**：点它 → 「查看日志」，输出面板里有每个数据源的失败原因。常见是公司代理拦了交易所域名 —— 注意 Node 的全局 `fetch` **不走** VS Code 的 `http.proxy` 设置，需要在环境变量层面配代理。
- **换了币种显示不出来**：确认这个代号在 Binance 或 OKX 上有对 USDT 的交易对（比如填 `SOL` 而不是 `SOLANA`）。
- **看不见价格**：状态栏右侧被别的插件挤满了，把 `solPrice.priority` 调大（越大越靠左），或者改成 `alignment: left`。

## 源码

只有一个文件：[`src/extension.js`](src/extension.js)，纯 JavaScript，零运行时依赖，不需要编译。类型检查跑 `npm run typecheck`。

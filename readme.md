这是一个时间戳与日期双向转换的 Chrome 扩展，集成了几个日常开发常用的小功能。

Chrome 扩展商店地址：[时间戳转换](https://chrome.google.com/webstore/detail/%E6%97%B6%E9%97%B4%E6%88%B3%E8%BD%AC%E5%8C%96/ahkgjgnlldlkagonpndejcbhipkealgo)

#### 功能

- **时间戳 / 日期双向转换**：在扩展弹窗中输入时间或时间戳，动态实时转换
- **选中文字右键转换**：在网页上选中时间戳或日期文本，右键菜单即可快速转换
- **GitLab Pipeline 监控**：在 `gitlab.***.com` 上自动监听 pipeline 状态变化并发送桌面通知
- **Gmail 新邮件通知**：打开 `mail.google.com` 时监听 tab 标题里的未读计数，收到新邮件即发送桌面通知（含发件人 / 主题）
- **Raw HTML 预览**：访问 GitHub / GitLab 的 raw HTML 链接（默认显示源码）时，页面右上角出现「预览 HTML」按钮，一键把源码渲染成实际网页
- **SOL 实时价格徽章**：扩展图标上常驻显示 Solana 最新价，涨绿跌红，悬停看 24h 涨跌 / 高低点 / 更新时间。每分钟刷新一次（Chrome MV3 定时器下限），数据源 Binance，失败自动回落 CoinGecko；两个都拉不到时把上一次的价格灰掉继续显示。**需要把扩展图钉在工具栏上才看得见**
- **DevTools 请求复制**：DevTools 里多出一个「请求复制」面板，选中请求即可把「完整链接 + Query 参数 + 请求体 + 响应体」拼成 Markdown 或 JSON 一次性复制（支持 ⌘/Ctrl 多选、URL 过滤、仅看 XHR/Fetch；带上请求头时 Cookie / Authorization 等自动打码）

源码在 `src` 文件夹中，`img` 文件夹存放部分截图。


# dsh-balance-tide

[English](./README.md) | **简体中文**

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-DeepSeek%20Harness-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![version](https://img.shields.io/badge/version-0.5.2-4176E6)](package.json)

**DeepSeek Harness（DSH）插件：余额 + 峰谷时段提示。**

在输入框下方、默认状态行（轮 / 步 / tok · 缓存命中 · 上下文）的**下一行**显示：

```
[高峰] 至 18:00 结束 · 剩 3时45分  下个低峰 18:00–明天 09:00 | 余额 ¥28.78 | 本会话 ¥0.42 | ?
[低峰] 至 周一 09:00 结束 · 剩 2天14时  下个高峰 周一 09:00–12:00 | 余额 ¥28.78 | 本会话 ¥0.42 | ?
```

## 功能

- **当前时段**：`高峰` / `低峰` 彩色徽章，按北京时间实时判定（含周末与法定节假日）
- **何时结束**：当前时段的结束时刻 + 剩余时间（每秒刷新）；跨天时带「明天 / 周X / M月D日」
- **下个时段**：下一个时段的起止时间，例如「下个高峰 14:00–18:00」
- **余额**：官方 `/user/balance` 实时余额（赠送 / 充值拆分在悬停明细里）
- **本会话消耗**：按当前时段单价估算（复用 `sessionProjections` 折叠，同 turn/step 样本替换不重复计数）
- **悬停明细**：当前时段起止、今天是否周末/节假日、官方规则原文、当前与切换后两档的单价表
- **`?` 图标**：直达官方定价页 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>
- **零配置**：复用 DSH credentials 中的 `DEEPSEEK_API_KEY`，代码仓库中不含任何密钥
- **双语界面**：中文 / English 跟随界面语言

## 峰谷计价规则（北京时间）

依据官方定价页（最后核对于 2026-11-18）：

> 北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。

- 空闲（低峰）价 = 高峰价的一半
- 法定节假日数据：内置 2026、2027 年（来源 [NateScarlet/holiday-cn](https://github.com/NateScarlet/holiday-cn)），运行时每天经 jsDelivr 拉取一次最新数据合并；拉取失败时用内置表
- 调休上班的周末按官方原文仍算空闲时段

| 模型（每 1M token，元） | 低峰（命中/未命中/输出） | 高峰（命中/未命中/输出） |
|---|---|---|
| deepseek-flash（旧名 deepseek-v4-flash 同价） | 0.02 / 1 / 4 | 0.04 / 2 / 8 |
| deepseek-v4-pro | 0.15 / 4.5 / 13.5 | 0.30 / 9 / 27 |

## 安装

**方式一：npm（推荐）**

```sh
dsh plugin --profile web add dsh-balance-tide
# 桌面版 DeepSeek Harness.app 用 desktop profile:
dsh plugin --profile desktop add dsh-balance-tide
```

**方式二：Git 地址**

```sh
dsh plugin --profile web add https://github.com/huanyuLv/dsh-balance-tide
```

**方式三：本地目录**

```sh
dsh plugin --profile web add file:/path/to/dsh-balance-tide
```

安装后重启 `dsh web` 或桌面版 DeepSeek Harness 生效。

## 配置（写入 `$DSH_HOME/profiles/web/cordis.patch.yml`）

```yaml
- id: dsh-balance-tide
  config:
    refreshIntervalMs: 300000   # 服务器拉取余额频率
    clientPollIntervalMs: 30000 # 浏览器轮询频率
    currency: CNY
    allowedHosts: []            # 经域名反代访问时，在此登记该域名
```

官方调价或调整时段时，无需等插件发版，直接覆盖对应配置即可：

```yaml
- id: dsh-balance-tide
  config:
    tideCutoff: '2026-08-17T00:00:00+08:00'   # 峰谷定价生效时刻
    peakWindows:                              # 高峰时段（北京时间整点，左闭右开）
      - { start: 9, end: 12 }
      - { start: 14, end: 18 }
    tidePrices:                               # 各档位单价（每 1M token）
      peak:
        deepseek-flash: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
      offpeak:
        deepseek-flash: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
    holidaySource: ''                         # 留空 = 不联网, 只用内置节假日表
    extraHolidays: ['2026-12-24']             # 额外的全天空闲日
```

`peakWindows: []` 表示不存在高峰时段（官方日后取消峰谷定价时可这样配）。

## 安全

- **密钥**：优先走 DSH credentials 的 `DEEPSEEK_API_KEY`。配置项 `apiKey` 仅作应急，
  它会以明文落在配置文件里，**不建议填写**。`baseUrl` 必须是 https，明文 http 会被拒绝
  （否则密钥会暴露在链路上）。
- **余额端点**：`/query-tide` 会返回账户余额，因此对读取方做了校验——Host 必须是
  localhost、IP 字面量或 `allowedHosts` 中登记的域名（阻断 DNS rebinding）；带 Origin 的
  请求必须同源（阻断任意网页读取你的余额）。被拒时返回 403。
- **错误信息**：服务端只向浏览器下发有限的错误码，原始异常文本仅写入日志，避免自定义
  `baseUrl` 的完整地址回流到前端。

## 已知限制

- 花费为**估算值**：整段会话按「当前」时段单价折算（高峰时用掉的部分，切到低峰后会按低峰价重算），实际扣费以官方账单为准。
- 多币种账户的主行只显示第一种货币，其余在悬停明细中列出。
- `deepseek-chat` / `deepseek-reasoner` 已不在官方定价页公示，`prices` 中的静态价仅作回退。

## 开发

```sh
npm install
npm test
```

## 兼容性

- DeepSeek Harness `0.1.0-rc.6` ~ `0.2.x`（web / desktop profile；0.2.2-rc.3 桌面版已验证）
- Node.js 20 / 22 / 24（CI 覆盖）
- 跨平台：纯 JavaScript + 标准浏览器 CSS，无原生模块（macOS 已验证；Windows/Linux 设计兼容）
- 许可证：MIT

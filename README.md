# SOL RSI+量能 Monitor V6

Solana 新代币 RSI(7)+EMA99+量能 策略监控机器人。

**5分钟K线 · Birdeye OHLCV 实时刷新 · Helius 链上成交数据 · 空跑/实盘**

---

## 策略逻辑

### 买入条件

**触发条件 (AND 逻辑, 两者都要满足)**:

| # | 条件 | 说明 |
|---|------|------|
| A | RSI(7) < 30 | 当前处于深度超卖区间 |
| B | 24小时跌幅 ≥ 60% | 现价相对 24h 最高价跌幅 ≥ 60% |

**过滤条件 (全部必须满足)**:

| # | 条件 | 说明 |
|---|------|------|
| 1 | EMA99 价格过滤 | **默认关闭** (`EMA_PRICE_FILTER_ENABLED=false`)，开启后要求价格 < EMA(99) |
| 2 | K 线数 ≥ 21 | RSI Wilder 收敛门槛 |
| 3 | 过去 5 分钟内 buyVol ≥ 1.2 × sellVol | 链上资金净流入 |
| 4 | 过去 5 分钟内总成交量 ≥ 5 SOL | 流动性门槛 |
| 5 | EMA99 K 线不足 99 根 | 严格模式直接拒绝买入 (仅 `EMA_PRICE_FILTER_ENABLED=true` 时生效) |

> 触发条件 A 和 B 必须 **同时满足** (AND), 命中后再走过滤条件。

### 加仓条件 (Add Position)

已持仓状态下, 以下条件全部满足时自动加仓 **一次**:

| # | 条件 | 说明 |
|---|------|------|
| 1 | 当前已持仓 | inPosition = true |
| 2 | 现价相对 **首次买入价** 跌幅 ≥ 50% | 不是相对加权均价 |
| 3 | 加仓次数 < `ADD_POSITION_MAX_TIMES` (默认 1) | 单仓位最多加仓 1 次 |
| 4 | 满足上面"买入条件"的触发条件 + 过滤条件 | 完全复用买入流程 (AND 逻辑) |

加仓后 `entryPriceUsd` 更新为加权平均买入价, 后续的固定止盈/移动止损/PnL 全部基于此均价 → **覆盖全部仓位 (含加仓部分)**。卖出时 `trader.sell` 用 `position.amountToken` 一次卖光, 含加仓的全部 token 数量。

### 卖出条件 (优先级从高到低，命中即卖)

| 优先级 | 条件 | 行为 | 默认状态 |
|--------|------|------|----------|
| 1 | RSI(7) > 80 | 恐慌卖出 | ✅ 启用 |
| 2 | RSI(7) 下穿 70 | 全仓卖出 | ✅ 启用 |
| 3 | 涨幅 ≥ +100% (基于加权均价) | 固定止盈 | ✅ 启用 |
| 4 | 上涨 ≥ +30% 后回撤 -20% | 移动止损 | ✅ 启用 |
| 5 | 跌幅 ≤ -50% (基于加权均价) | 固定止损 | ❌ **默认关闭** |
| 6 | 量能萎缩(最近3根均量 < 前4根均量×0.3) | 量能出场 | ✅ 启用 |
| 7 | 持仓 ≥ 6 小时 | 超时卖出 (TIMEOUT_EXIT) | ✅ 启用 |
| 8 | EMA99 斜率 < -2% | 趋势恶化卖出 | ❌ **默认关闭** |

> **持仓中** 即使 FDV 跌破 $30K 或 LP 跌破 $10K，也**不强制卖出**，等正常出场条件触发。
> 仅在 **无持仓** 时，FDV/LP 跌破阈值会从监控列表中移除该代币。

### 仓位管理

- 监控期内可多次进出场
- 卖出后 30 分钟冷却期 (同币不再交易)
- 每笔买入 **TRADE_SIZE_SOL** (默认 1 SOL)
- 加仓金额 = TRADE_SIZE_SOL (与首次买入相同)
- 卖出后自动重置加仓计数, 下一轮可重新加仓

---

## 数据来源

| 数据 | 来源 | 用途 |
|------|------|------|
| K 线 OHLC | **Birdeye OHLCV API** (5分钟K线, 每5分钟刷新, 120根缓存) | RSI/EMA99 计算 |
| 实时价格 | Birdeye WebSocket (subscribe_price) | stepRSI 实时估算、止损监控 |
| 链上买卖量 | Helius Enhanced WebSocket (transactionSubscribe) | buyVolume / sellVolume 量能过滤 |
| FDV / LP / Symbol | Birdeye token_overview | 入场过滤、自动 symbol 匹配 |
| 24h 最高价 | Birdeye OHLCV (1小时K线 × 25根, 缓存10分钟) | 24h 跌幅触发判断 + dashboard 排序 |

---

## 快速开始

### 1. 配置 .env

```bash
cp .env.example .env
```

**必填**:
```
BIRDEYE_API_KEY=你的Key
HELIUS_WSS_URL=wss://atlas-mainnet.helius-rpc.com/?api-key=你的Key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=你的Key
```

> X (Twitter) Mentions 模块仍保留, 设置 `X_BEARER_TOKEN` 后会在后台拉取数据并写入磁盘, 但 dashboard 表格已不再显示该列 (已替换为 24H 跌幅)。

### 2. 空跑模式（推荐先跑一天）

```bash
# .env 中：
DRY_RUN=true
# WALLET_PRIVATE_KEY 可留空

npm install
npm start
```

### 3. 切换实盘

```bash
# .env 修改：
DRY_RUN=false
WALLET_PRIVATE_KEY=你的私钥
JUPITER_API_KEY=你的Jupiter Key

# 重启
npm start
```

### 4. Dashboard

```
http://YOUR_SERVER:3001
```

诊断接口（V5-20）:
```
http://YOUR_SERVER:3001/diag
```

---

## 环境变量（V5-20 默认值）

> ⚠️ 以下默认值已写在源码 `process.env.XXX || 'default'` 中。
> **.env 里不写这些行 = 用默认值**。要改才需要在 .env 里覆盖。

### 核心策略

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KLINE_INTERVAL_SEC` | `300` | K线宽度（秒，**5分钟**，不是 15s） |
| `RSI_PERIOD` | `7` | RSI 周期 |
| `EMA_PERIOD` | `99` | EMA 长期均线周期 |
| `EMA_INSUFFICIENT_MODE` | `strict` | K 线不足 99 根时严格不出信号 (仅 `EMA_PRICE_FILTER_ENABLED=true` 时生效) |
| `EMA_PRICE_FILTER_ENABLED` | `false` | **V6 默认关闭** EMA99 价格过滤, 买入不再要求价格 < EMA99 |
| `RSI_BUY_LEVEL` | `30` | 超卖买入阈值 (旧版 35) |
| `RSI_SELL_LEVEL` | `70` | RSI 下穿此值卖出 |
| `RSI_PANIC_LEVEL` | `80` | RSI 超过此值立即卖出 |
| `MIN_CANDLES_FOR_SIGNAL` | `21` | RSI 收敛所需最低 K 线数 |
| `SKIP_FIRST_CANDLES` | `3` | 跳过前 N 根 K 线（实际生效值取 max(此值, 21)） |

### 仓位与冷却

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TRADE_SIZE_SOL` | `2` | 每笔买入金额（SOL） |
| `SELL_COOLDOWN_SEC` | `1800` | 卖出后冷却（秒，**30分钟**） |
| `MAX_HOLD_SEC` | `21600` | 最大持仓时间（秒，**6小时**），超时强制卖出 reason=TIMEOUT_EXIT, 0=关闭 |

### 止盈止损

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TAKE_PROFIT_ENABLED` | `true` | 启用固定止盈 (加仓时按加权均价计算, 覆盖全部仓位) |
| `TAKE_PROFIT_PCT` | `100` | 止盈百分比 (**+100%**, 不是 +50%) |
| `STOP_LOSS_ENABLED` | `false` | **默认关闭**固定止损 (旧版 true) |
| `STOP_LOSS_PCT` | `-50` | 止损百分比 (仅在 STOP_LOSS_ENABLED=true 时生效) |
| `TRAILING_STOP_ENABLED` | `true` | 启用移动止损 |
| `TRAILING_STOP_ACTIVATE` | `30` | 上涨 30% 后激活移动止损 |
| `TRAILING_STOP_PCT` | `-20` | 从峰值回撤 20% 触发卖出 |

### EMA99 斜率过滤 (默认全部关闭)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EMA_SLOPE_ENABLED` | `false` | **默认关闭** 买入端 EMA99 斜率过滤 (旧版 true) |
| `EMA_SLOPE_SELL_ENABLED` | `false` | **默认关闭** 卖出端 EMA99 斜率过滤 (旧版 true) |
| `EMA_SLOPE_LOOKBACK` | `5` | 斜率回看 K 线根数 |
| `EMA_SLOPE_MIN_PCT` | `-1` | 买入斜率下限(%), 仅在 EMA_SLOPE_ENABLED=true 时生效 |
| `EMA_SLOPE_SELL_PCT` | `-2` | 卖出斜率门槛(%), 仅在 EMA_SLOPE_SELL_ENABLED=true 时生效 |

### 24h 跌幅触发买入 (AND 逻辑)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DROP_24H_BUY_ENABLED` | `true` | 启用 24h 跌幅买入触发 (与 RSI<30 同时满足才触发) |
| `DROP_24H_BUY_PCT` | `60` | 跌幅 ≥ 此值允许买入 (绝对值) |
| `HIGH24H_CACHE_MS` | `600000` | 24h 最高价缓存 TTL (毫秒, 默认 10 分钟) |

### 加仓 (Add Position)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADD_POSITION_ENABLED` | `true` | 启用加仓 |
| `ADD_POSITION_DROP_PCT` | `50` | 自首次买入价跌幅 ≥ 此值允许加仓 (绝对值) |
| `ADD_POSITION_MAX_TIMES` | `1` | 单仓位最多加仓次数 |

### 量能过滤

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VOL_ENABLED` | `true` | 启用量能买入过滤 |
| `VOL_BUY_MULT` | `1.2` | buyVol ≥ N × sellVol 才买入 |
| `VOL_MIN_TOTAL` | `5` | 最低总成交量(SOL) |
| `VOL_WINDOW_SEC` | `300` | 量能统计窗口（秒） |
| `VOL_DECAY_EXIT_ENABLED` | `true` | **V5-26 启用**量能萎缩出场 |
| `VOL_EXIT_CONSECUTIVE` | `3` | 最近 N 根 K 线连续低量则出场 |
| `VOL_EXIT_LOOKBACK` | `4` | 对比前 N 根的均量 |
| `VOL_EXIT_RATIO` | `0.3` | 最近均量 < 前 N 根均量 × 0.3 视为萎缩(严重才触发) |

### FDV / LP 过滤

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MIN_FDV_USD` | `15000` | 入场 FDV 过滤 |
| `MIN_LP_USD` | `5000` | 入场 LP 过滤 |
| `FDV_EXIT_USD` | `30000` | 监控中 FDV 退出阈值（**仅无持仓时退出**） |
| `LP_EXIT_USD` | `10000` | 监控中 LP 退出阈值（**仅无持仓时退出**） |

### 监控容量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_MONITOR_TOKENS` | `95` | 最大监控代币数 |

### Birdeye OHLCV 实时刷新（V5-16）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OHLCV_REALTIME_ENABLED` | `true` | 启用 OHLCV 实时刷新（替代不准的 ticks 聚合） |
| `OHLCV_REFRESH_SEC` | `300` | 每 N 秒拉一次最新 K 线（V5-25: 30→300, 大幅节省 Birdeye CU） |
| `OHLCV_REALTIME_BARS` | `120` | 实时刷新拉的 K 线根数 |

### prevRsi 时效保护（V5-15/V5-17）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WS_RSI_PREV_STALE_MS` | `3000` | WS 推送 prevRsi 超过 N 毫秒视为过期 |
| `SL_POLL_PREV_STALE_MS` | `3000` | 止损轮询 prevRsi 超过 N 毫秒视为过期 |

### X (Twitter) Mentions (V5-18/V5-19, V6 dashboard 已移除显示)

> 后台模块仍然保留 (有 `X_BEARER_TOKEN` 时仍会拉数据并写到磁盘), 但 V6 改动后, dashboard 表格已用 24H 跌幅列替换 X 提及列。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `X_BEARER_TOKEN` | - | X Developer API Bearer Token (留空则禁用模块) |
| `X_MENTIONS_INTERVAL_SEC` | `7200` | 刷新间隔 (秒, **2小时**) |
| `X_MENTIONS_REQUEST_GAP_SEC` | `15` | 串行请求间隔 (秒) |

### 运行模式

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DRY_RUN` | `true` | 空跑模式（不实际交易） |
| `DRY_RUN_DATA_DIR` | `./data` | 数据持久化目录 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `PORT` | `3001` | HTTP 端口 |

---

## 目录结构

```
sol-rsi/
├── src/
│   ├── index.js          # 主入口
│   ├── monitor.js        # 核心引擎
│   ├── rsi.js            # RSI/EMA/量能/信号评估
│   ├── birdeye.js        # Birdeye API 封装（OHLCV/价格/FDV/LP）
│   ├── heliusWs.js       # Helius Enhanced WS（链上交易订阅）
│   ├── trader.js         # Jupiter Ultra API 实盘交易
│   ├── xMentions.js      # X (Twitter) 提及计数
│   ├── dataStore.js      # 数据持久化
│   ├── reporter.js       # 每日 CSV 报告
│   ├── wsHub.js          # Dashboard WebSocket 广播
│   ├── logger.js         # 日志（winston）
│   └── routes/
│       ├── webhook.js    # POST /webhook/add-token
│       └── dashboard.js  # REST API + /diag 诊断接口
├── public/
│   └── index.html        # 实时 Dashboard 前端
├── data/                  # 持久化数据（自动创建）
│   ├── tokens.json
│   ├── trades.json
│   ├── signals.json
│   └── xMentions.json
├── .env.example
└── package.json
```

---

## 关键操作

### 添加代币

通过 Dashboard 前端，或 POST 接口：

```bash
# 不传 symbol（V5-16 自动从 Birdeye 拉取）
curl -X POST http://localhost:3001/tokens/add \
  -H 'Content-Type: application/json' \
  -d '{"address":"代币mint地址"}'
```

### 检查 OHLCV 实时刷新是否工作（V5-20）

```bash
curl http://localhost:3001/diag | jq .
```

健康指标:
- `env.OHLCV_REALTIME_ENABLED = "true"`
- `callStats.ohlcvSuccess / ohlcvBranch ≈ 100%`（OHLCV 调用成功率）
- `callStats.fallbackBranch < 5%`（fallback 比例低）
- `ohlcvCache.empty < 5`（空缓存极少）

如果 `fallbackBranch` 很高 → Birdeye OHLCV 频繁失败，检查 API key 和套餐。

### 重启不丢监控列表

`data/tokens.json` 自动持久化所有监控代币。重启程序会自动恢复。

---

## 版本历史关键改动

- **V5-9**: 关闭固定止损默认（避免假跌震出）；K 线收敛门槛 21
- **V5-10**: 启用固定止盈 +100%
- **V5-13**: Birdeye getPrice 失败抑制（400/404 静默 5 分钟）
- **V5-14**: 决策追踪 tooltip
- **V5-15**: WS tick prevRsi 时效保护（防虚假下穿）
- **V5-16**: ★ Birdeye OHLCV 实时刷新（K 线源换为官方 API，对齐 GMGN）
- **V5-16**: Symbol 自动匹配；持仓时不退出监控
- **V5-16**: 买入数额 0.2 → 1 SOL
- **V5-17**: OHLCV 最新 K 线 close 用实时价格覆盖（修 RSI 跟不上实时）
- **V5-17**: _slPollPrevRsi 时效保护
- **V5-17**: 删除前端 Age 列
- **V5-18**: X mentions 列
- **V5-19**: X mentions 改串行 + 15s 间隔
- **V5-20**: 加 /diag 诊断接口
- **V5-21**: dashboard 加回 Age 列(代币年龄); 加最大持仓 6h 超时卖出 (TIMEOUT_EXIT)
- **V5-22**: 修 monitor.js 启动日志 "移动止损=关闭 激活线=+undefined%" (rsi.js 顶层补导出 TRAILING_STOP_*)
- **V5-23**: 修前端 K线列被覆盖成 "0笔" bug (V5-21 索引偏移没改干净)
- **V5-24**: dashboard 表格创建 td 数量从 15 改 16, 修整张表空白; 加 birdeye.getCreationInfo 和持久化
- **V5-25**: ★ OHLCV 刷新从 30s 改 300s, 节省 90% Birdeye CU. 实时价由 Birdeye WS SUBSCRIBE_PRICE 提供, 业务行为不变
- **V5-26**: 重新启用固定止损 -20% 和量能萎缩出场; VOL_DECAY 参数 (3根<前4根均×0.3, 严重萎缩才触发)
- **V5-27**: 启动日志加 CU 关键参数行; /diag 加 cuEstimate 字段 + 月度预警
- **V5-28**: /diag 加 wsStream / getPriceStats 字段, 用于诊断 WS 推送命中率
- **V5-29**: ★ 修 Birdeye WS chartType '1s' → '1m' (Birdeye 已不支持 1s). getCachedPrice 过期阈值 10s → 90s 覆盖 1m 推送间隔
- **V5-30**: ★ 真正根因 — Birdeye WS 强制要求 `echo-protocol` subprotocol header, ws 库默认不发, 加 `new WebSocket(URL, 'echo-protocol')` 修复. chartType 回退 '1s' (V5-26 旧服务器一直在用), 缓存 90s 保留
- **V6**: ★ 策略大改
  - 关闭 EMA99 斜率买入和卖出 (`EMA_SLOPE_ENABLED=false` / `EMA_SLOPE_SELL_ENABLED=false`)
  - 关闭固定止损 (`STOP_LOSS_ENABLED=false`)
  - RSI 买入阈值 35 → 30 (深度超卖才买)
  - 新增 24h 跌幅触发买入 (`DROP_24H_BUY_PCT=60`, 跌 60% 以上允许买入, 与 RSI<30 同时满足 AND 逻辑)
  - 新增加仓 (`ADD_POSITION_*`): 自首次买入价跌 50% + 满足买入条件 → 加仓一次, `entryPriceUsd` 更新为加权均价, 后续止盈/移动止损/卖出全部覆盖加仓部分
  - Dashboard 移除 X 提及列, 改为 24H 跌幅列, 排序按跌幅从大到小

---

## ⚠️ 注意事项

- **不要凭记忆修改默认值**。所有默认值在代码里 `process.env.XXX || 'default'` 处定义
- **不要随便关闭 OHLCV_REALTIME_ENABLED**。关掉会回退到不准的 ticks 聚合，RSI 严重失真
- **持仓中不会因 FDV/LP 跌破自动卖出**。仅在 RSI > 80、下穿 70、达到 +100% 止盈、移动止损、量能萎缩、超时 6h 触发时才卖
- **加仓后所有止盈/止损/PnL 基于加权均价**, 卖出时一次卖光全部仓位 (含加仓部分)
- **README 中所有"默认值"必须以代码为准**。如果改了代码默认值，必须同步更新此文档

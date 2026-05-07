# SOL 量能突破 Monitor V7.1 (Volume Breakout + Anti-Trap)

Solana 新代币纯量能突破策略机器人。**V7.1 新增 5 层防陷阱过滤** — 抵御 memecoin 常见的单根插针 / 拉高出货 / 假突破诱多。

**1 分钟 K 线 · Birdeye OHLCV 实时刷新 · Helius 链上 buyVol/sellVol · 5 层防陷阱 · 空跑/实盘**

---

## 策略逻辑 (V7.1)

### 买入条件 (AND, 三者全部满足)

| # | 条件 | 默认值 | 说明 |
|---|------|--------|------|
| ① | 量能爆发 | ≥ 5× | 当根 1 分钟 K 线成交量 ≥ 过去 20 根均量 × `VOL_SPIKE_MULT` |
| ② | 买盘主导 | ≥ 65% | 同 1 分钟 `buyVol / (buyVol + sellVol)` ≥ `BUY_DOMINANCE_PCT` |
| ③ | 价格跟涨 | ≥ 5% | 同 1 分钟 `(close - open) / open` ≥ `PRICE_MOMENTUM_PCT` |
| - | 最低成交量 | ≥ 5 SOL | 同 1 分钟绝对总量 ≥ `VOL_MIN_TOTAL`，防止微量假突破 |

> 必须 **同时** 满足 ①②③ 才进入下一步，进入下一步还要过 5 层防陷阱过滤。

### ★ V7.1 5 层防陷阱过滤 (默认全开)

| 层 | 名称 | 默认 | 功能 |
|----|------|------|------|
| **L1** | 实体扎实 | `body / range ≥ 0.5` | 实体至少占整根 K 线 (含上下影) 一半。挡掉"高开高走收盘缩回"形态 |
| **L2** | 上影线检验 | `upperWick / body ≤ 1.0` | 上影不超过实体长度。挡掉"插针"K 线 (实体小, 上影巨长) |
| **L3** | 跟根确认 ⭐ | `开` | **最有效一层**。信号当根不立即买，等下一根 K 线收盘且 `close > 信号根 close` 且非红柱才买。挡掉单根诱多 |
| **L4** | 累涨封顶 | `≤ 30%` | 信号根 close vs 3 根前 close 累涨 ≤ 30%。防止追到"拉高出货"中后段 |
| **L5** | 紧止损 (闪跌保护) | `-5% in 90s` | 买入后 90 秒内跌破入场价 -5% 立即平仓。前 4 层兜底 |

> L1 默认 0.5 时已经隐含了 L2 的功能 — 因为如果上影 > 实体，则 range ≥ 2×body，body/range ≤ 0.5。
> 调低 L1 (如 0.3) 时，L2 才作为独立检查项起作用。两层互为兜底。

#### L3 跟根确认状态机

```
T0 (信号根)  三条件 + L1/L2/L4 全过 → 设置 _pendingBuy { candleTs, signalClose }
            本根不买, 等下根
            ↓
T1 (下一根)  close > 信号根 close 且 close ≥ open
            ✅ 通过 → 触发 BUY (reason: L3_CONFIRMED)
            ❌ 失败 → 清除 pending, 信号作废 (reason: L3_REJECTED)
            ⏰ 超时 (>120s 未确认) → 清除 pending
```

### 卖出条件 (任一触发即卖)

| 优先级 | 条件 | 默认值 | 说明 |
|--------|------|--------|------|
| 1 | **L5 紧止损** ⚡ | -5% in 90s | 买入后 90 秒内跌破入场价 -5% 立即平仓。防陷阱兜底 |
| 2 | 移动止损 | 峰值 -20% | 上涨 ≥ +30% (`TRAILING_STOP_ACTIVATE`) 后激活，从峰值回撤 ≥ 20% (`TRAILING_STOP_PCT`) 平仓 |
| 3 | 持仓超时 | 30 分钟 | 持仓时间 ≥ `HOLD_TIMEOUT_SEC` 强制清仓 |
| 4 | 卖压反转 | sellVol ≥ 60% | 同 1 分钟 sellVol 占比 ≥ `SELL_DOMINANCE_PCT` |
| 5 | 量能衰竭 | 连续 3 根 < SMA(10) | 连续 `VOL_FADE_CONSECUTIVE` 根 K 线成交量都低于 SMA(`VOL_FADE_LOOKBACK`) |

> 持仓中即使 FDV/LP 跌破阈值也 **不强制卖出**，等正常出场条件触发。
> 仅在 **无持仓** 时，FDV/LP 跌破阈值会从监控列表中移除该代币。

### 仓位管理

- 监控期内可多次进出场
- 卖出后 30 分钟冷却期 (`SELL_COOLDOWN_SEC`)，同币不再交易
- 每笔买入 `TRADE_SIZE_SOL` (默认 1 SOL)
- 单仓位制，不再支持加仓
- 卖出后 `_lastBuyCandle` 重置，下一轮可重新买入

### 已删除的功能 (相比 V6)

- ✗ 全部 RSI 相关 (`RSI_BUY` / `RSI_SELL` / `RSI_PANIC`, Wilder RSI 计算, RSI 下穿/恐慌卖出)
- ✗ EMA99 价格过滤 / 斜率过滤 (买入端 + 卖出端)
- ✗ 24h 跌幅触发买入 (`DROP_24H_BUY_*`)
- ✗ 加仓功能 (`ADD_POSITION_*`)
- ✗ 固定止盈 (`TAKE_PROFIT_*`)
- ✗ 固定止损 (`STOP_LOSS_*`)
- ✗ `MAX_HOLD_SEC` (由 `HOLD_TIMEOUT_SEC` 替代，默认 30 分钟而非 6 小时)
- ✗ 旧的量能萎缩出场 (`VOL_DECAY_EXIT_*`，由更直接的 `VOL_FADE` 替代)
- ✗ 回测 (`/api/backtest/*` 接口和 `backtest.js`，因策略已大改)

---

## 数据来源

| 数据 | 来源 | 用途 |
|------|------|------|
| K 线 OHLC | Birdeye OHLCV API (1 分钟 K 线，每 60s 刷新) | 量能基线 + 价格涨跌幅 |
| 实时价格 | Birdeye WebSocket (subscribe_price) | 移动止损监控 |
| 链上买卖量 | Helius Enhanced WebSocket (transactionSubscribe) | buyVolume / sellVolume 量能方向 |
| FDV / LP / Symbol | Birdeye token_overview | 入场过滤 |

---

## 快速开始

### 1. 配置 .env

```bash
cp .env.example .env
```

**必填**:
```
BIRDEYE_API_KEY=你的Key
HELIUS_WSS_URL=wss://mainnet.helius-rpc.com/?api-key=你的Key
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=你的Key
```

### 2. 空跑模式（推荐先跑一天看看效果）

```bash
DRY_RUN=true
# WALLET_PRIVATE_KEY 可留空

npm install
npm start
```

### 3. 切换实盘

```bash
DRY_RUN=false
WALLET_PRIVATE_KEY=你的私钥
JUPITER_API_KEY=你的Jupiter Key

npm start
```

### 4. Dashboard

```
http://YOUR_SERVER:3001
```

---

## 核心环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KLINE_INTERVAL_SEC` | `60` | K 线宽度 (秒)，**1 分钟** |
| `VOL_SPIKE_MULT` | `5` | ① 量能爆发倍数 |
| `VOL_SPIKE_LOOKBACK` | `20` | ① 对比过去 N 根 K 线均量 |
| `BUY_DOMINANCE_PCT` | `65` | ② 买盘占比阈值 (%) |
| `PRICE_MOMENTUM_PCT` | `5` | ③ 1 分钟最低涨幅 (%) |
| `VOL_MIN_TOTAL` | `5` | 最低绝对成交量 (SOL) |
| **V7.1 防陷阱** | | |
| `L1_BODY_FILTER_ENABLED` | `true` | L1 实体扎实开关 |
| `MIN_BODY_RATIO` | `0.5` | L1 实体占整根 K 线最小比例 |
| `L2_UPPER_WICK_FILTER_ENABLED` | `true` | L2 上影线检验开关 |
| `MAX_UPPER_WICK_RATIO` | `1.0` | L2 上影/实体最大比例 |
| `L3_FOLLOWUP_CONFIRM_ENABLED` | `true` | L3 跟根确认开关 ⭐ |
| `L3_FOLLOWUP_TIMEOUT_SEC` | `120` | L3 pending 超时清除 |
| `L4_RUNUP_FILTER_ENABLED` | `true` | L4 累涨封顶开关 |
| `RUNUP_LOOKBACK_BARS` | `3` | L4 看前 N 根 K 线 |
| `MAX_PRECEDING_RUNUP_PCT` | `30` | L4 最大累涨幅度 (%) |
| `L5_FAST_STOP_ENABLED` | `true` | L5 紧止损开关 |
| `FAST_STOP_WINDOW_SEC` | `90` | L5 生效时间窗口 (秒) |
| `FAST_STOP_PCT` | `-5` | L5 触发跌幅 (%) |
| **卖出 / 仓位** | | |
| `TRAILING_STOP_ACTIVATE` | `30` | 移动止损激活阈值 (%) |
| `TRAILING_STOP_PCT` | `-20` | 移动止损回撤幅度 (%) |
| `SELL_DOMINANCE_PCT` | `60` | 卖压反转阈值 (%) |
| `VOL_FADE_CONSECUTIVE` | `3` | 量能衰竭连续根数 |
| `VOL_FADE_LOOKBACK` | `10` | 量能衰竭对比 SMA |
| `HOLD_TIMEOUT_SEC` | `1800` | 持仓超时 (秒, 30 分钟) |
| `SELL_COOLDOWN_SEC` | `1800` | 卖出冷却 (秒, 30 分钟) |
| `TRADE_SIZE_SOL` | `1` | 每笔买入金额 |
| `FDV_EXIT_USD` | `30000` | FDV 低于此值退出监控 |
| `LP_EXIT_USD` | `10000` | LP 低于此值退出监控 |

完整变量见 `.env.example`。

---

## 调参建议

### 信号 / 频率

**信号太多 / 假突破多** → 调高:
- `VOL_SPIKE_MULT` (5 → 7 或 10)
- `BUY_DOMINANCE_PCT` (65 → 70)
- `PRICE_MOMENTUM_PCT` (5 → 8)
- `MIN_BODY_RATIO` (0.5 → 0.6 — L1 更严)
- `MAX_PRECEDING_RUNUP_PCT` (30 → 20 — L4 更严)

**信号太少 / 漏掉行情** → 调低:
- `VOL_SPIKE_MULT` (5 → 3)
- `BUY_DOMINANCE_PCT` (65 → 60)
- `PRICE_MOMENTUM_PCT` (5 → 3)
- 关闭 `L3_FOLLOWUP_CONFIRM_ENABLED` (慢一根 K 线进场太保守时)

### 防陷阱效果调试

观察 `_signalTrace.reason` 字段:
- `L1_THIN_BODY` 频繁 → 数据多带长上下影，要么 K 线本身波动大，要么调低 `MIN_BODY_RATIO`
- `L2_LONG_UPPER_WICK` 频繁 → 配合 `L1_BODY_FILTER_ENABLED=false` 单独验证 L2 触发率
- `L3_REJECTED` 多 → 跟根经常变红柱，说明市场上诱多多，**保持 L3 开启**
- `L3_PENDING_TIMEOUT` 多 → K 线流不连续，可能是 OHLCV 刷新有问题
- `L4_OVER_EXTENDED` 多 → 信号经常出现在已经涨过的中后段，**保持 L4 开启**
- `FAST_STOP` 多 → 前 4 层有漏，考虑收紧 L1/L4

### 持仓 / 出场

**持仓被甩太早** → 放宽卖出条件:
- `TRAILING_STOP_PCT` (-20 → -25 或 -30)
- `SELL_DOMINANCE_PCT` (60 → 70)
- `VOL_FADE_CONSECUTIVE` (3 → 5)
- `HOLD_TIMEOUT_SEC` (1800 → 3600)
- `FAST_STOP_PCT` (-5 → -8) 或 `FAST_STOP_WINDOW_SEC` (90 → 60)

**持仓握太久不出场** → 收紧卖出条件 (反向调整以上参数)。

---

## 版本历史

- **V7.1 (本版)** — 新增 5 层防陷阱过滤 (L1 实体扎实 / L2 上影检验 / L3 跟根确认 / L4 累涨封顶 / L5 紧止损)，针对 memecoin 单根插针、拉高出货等陷阱。
- **V7** — 纯量能突破策略，删除全部 RSI / EMA / 24h 跌幅 / 加仓 / 固定止盈止损相关逻辑。K 线从 5 分钟改到 1 分钟。
- **V6** — RSI<30 + 24h 跌幅 ≥ 60% (AND 逻辑), EMA99 价格过滤可关。
- **V5** — RSI(7) + 量能 + EMA99 + 移动止损 + 加仓。
- **V1-V4** — RSI 抄底策略迭代。

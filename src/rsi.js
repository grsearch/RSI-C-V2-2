'use strict';
// src/rsi.js — V7 纯量能突破策略 (Volume Breakout)
//
// 文件名沿用 rsi.js 是为了保持 monitor.js / index.js 的 require 路径不变,
// 但实际策略已彻底改成不含 RSI / EMA 的纯量能突破信号引擎.
//
// 策略核心:
//   K 线宽度 = 1 分钟
//   买入条件 (AND, 三个全部满足):
//     ① 量能爆发: 最近 1 分钟成交量 ≥ 过去 N 分钟均量 × VOL_SPIKE_MULT (默认 5×)
//     ② 买盘主导: 同 1 分钟 buyVol / (buyVol + sellVol) ≥ BUY_DOMINANCE_PCT (默认 65%)
//     ③ 价格跟涨: 同 1 分钟价格涨幅 ≥ PRICE_MOMENTUM_PCT (默认 5%)
//   卖出条件 (任一触发):
//     ① 移动止损: 上涨 ≥ TRAILING_STOP_ACTIVATE 后, 从峰值回撤 ≥ TRAILING_STOP_PCT
//     ② 卖压反转: 同 1 分钟 sellVol / (buyVol + sellVol) ≥ SELL_DOMINANCE_PCT (默认 60%)
//     ③ 量能衰竭: 连续 N 根 K 线成交量都低于均量
//     ④ 持仓超时: 持仓时间 ≥ HOLD_TIMEOUT_SEC (默认 30 分钟)
//
// 已删除的功能:
//   - 全部 RSI 相关 (RSI_BUY/RSI_SELL/RSI_PANIC, calcRSIWithState, stepRSI)
//   - EMA99 价格过滤、EMA99 斜率买入/卖出过滤
//   - 24h 跌幅触发、加仓 (ADD_POSITION)
//   - 固定止盈、固定止损

// ─── K 线参数 ──────────────────────────────────────────────────────
const KLINE_SEC = parseInt(process.env.KLINE_INTERVAL_SEC || '60', 10);  // ★ 1 分钟 K 线

// ─── 买入参数 ──────────────────────────────────────────────────────
// 量能爆发: 当根 K 线 volume vs 之前 VOL_SPIKE_LOOKBACK 根均量
const VOL_SPIKE_MULT     = parseFloat(process.env.VOL_SPIKE_MULT     || '5');   // 5×
const VOL_SPIKE_LOOKBACK = parseInt(process.env.VOL_SPIKE_LOOKBACK   || '20', 10); // 过去 20 根 K 线
// 买盘主导: buyVol 占比
const BUY_DOMINANCE_PCT  = parseFloat(process.env.BUY_DOMINANCE_PCT  || '65');  // 65%
// 价格跟涨: 1 分钟内涨幅
const PRICE_MOMENTUM_PCT = parseFloat(process.env.PRICE_MOMENTUM_PCT || '5');   // 5%
// 最低绝对成交量 (SOL) — 避免微量假突破
const VOL_MIN_TOTAL      = parseFloat(process.env.VOL_MIN_TOTAL      || '5');   // 5 SOL
// 启动后跳过前 N 根 K 线 (等量能基线收敛)
const SKIP_FIRST_CANDLES = parseInt(process.env.SKIP_FIRST_CANDLES   || '3', 10);

// ─── ★ V7.1 防陷阱过滤器 (5 层防御, 默认全开) ────────────────────
// L1 实体扎实: body / range >= MIN_BODY_RATIO
//   body  = |close - open|, range = high - low
//   即"实体占整根 K 线 (含上下影) 的比例". 防止"高开高走但收盘缩回"形态
//   默认 0.5 = 实体至少占 K 线一半, 影子不能太长
const L1_BODY_FILTER_ENABLED = (process.env.L1_BODY_FILTER_ENABLED || 'true') === 'true';
const MIN_BODY_RATIO         = parseFloat(process.env.MIN_BODY_RATIO || '0.5');

// L2 上影线检验: upperWick / |body| <= MAX_UPPER_WICK_RATIO
const L2_UPPER_WICK_FILTER_ENABLED = (process.env.L2_UPPER_WICK_FILTER_ENABLED || 'true') === 'true';
const MAX_UPPER_WICK_RATIO         = parseFloat(process.env.MAX_UPPER_WICK_RATIO || '1.0'); // 上影 ≤ 实体

// L3 跟根确认: 信号当根不立即买, 等下一根继续走强才买
//   下一根要求: close > 信号根 close 且 不是大红柱 (close > open)
//   代价: 慢一根 K 线进场, 但能挡掉 80% 单根诱多
const L3_FOLLOWUP_CONFIRM_ENABLED = (process.env.L3_FOLLOWUP_CONFIRM_ENABLED || 'true') === 'true';
// 跟根确认的最大等待时间 (秒). 超过此值则信号失效
const L3_FOLLOWUP_TIMEOUT_SEC     = parseInt(process.env.L3_FOLLOWUP_TIMEOUT_SEC || '120', 10);

// L4 累涨封顶: 信号根 close vs N 分钟前 close 涨幅过大则不买 (避免追到出货后段)
const L4_RUNUP_FILTER_ENABLED = (process.env.L4_RUNUP_FILTER_ENABLED || 'true') === 'true';
const RUNUP_LOOKBACK_BARS     = parseInt(process.env.RUNUP_LOOKBACK_BARS    || '3', 10); // 3 分钟前
const MAX_PRECEDING_RUNUP_PCT = parseFloat(process.env.MAX_PRECEDING_RUNUP_PCT || '30'); // 累涨 ≤ 30%

// L5 紧止损 (闪跌保护): 买入后 N 秒内跌破入场价 -P%, 立即平仓
//   兜底前 4 层都没挡住的陷阱; 真启动很少在第一分钟就 -5%, 误伤极少
const L5_FAST_STOP_ENABLED   = (process.env.L5_FAST_STOP_ENABLED   || 'true') === 'true';
const FAST_STOP_WINDOW_SEC   = parseInt(process.env.FAST_STOP_WINDOW_SEC   || '90', 10); // 买入后 90 秒
const FAST_STOP_PCT          = parseFloat(process.env.FAST_STOP_PCT       || '-5');     // 跌 5% 立卖

// ─── 卖出参数 ──────────────────────────────────────────────────────
// 移动止损 (用户保留)
const TRAILING_STOP_ENABLED  = (process.env.TRAILING_STOP_ENABLED  || 'true') === 'true';
const TRAILING_STOP_ACTIVATE = parseFloat(process.env.TRAILING_STOP_ACTIVATE || '30'); // 涨 30% 激活
const TRAILING_STOP_PCT      = parseFloat(process.env.TRAILING_STOP_PCT      || '-20'); // 峰值回撤 20% 平仓

// 卖压反转
const SELL_DOMINANCE_ENABLED = (process.env.SELL_DOMINANCE_ENABLED || 'true') === 'true';
const SELL_DOMINANCE_PCT     = parseFloat(process.env.SELL_DOMINANCE_PCT     || '60');  // sellVol 占比 ≥60% 触发

// 量能衰竭
const VOL_FADE_ENABLED       = (process.env.VOL_FADE_ENABLED       || 'true') === 'true';
const VOL_FADE_CONSECUTIVE   = parseInt(process.env.VOL_FADE_CONSECUTIVE   || '3', 10); // 连续 3 根
const VOL_FADE_LOOKBACK      = parseInt(process.env.VOL_FADE_LOOKBACK      || '10', 10); // 对比 SMA(10)

// 持仓超时
const HOLD_TIMEOUT_SEC       = parseInt(process.env.HOLD_TIMEOUT_SEC       || '1800', 10); // 1800s = 30 分钟

// ─── K 线聚合 (从 V3 沿用) ─────────────────────────────────────────
// tick 格式:
//   价格 tick (Birdeye): { price: USD, ts, source: 'price' }
//   链上 tick (Helius): { price: 忽略, ts, solAmount, isBuy, source: 'chain' }
function buildCandles(ticks, intervalSec = KLINE_SEC) {
  if (!ticks || ticks.length === 0) return { closed: [], current: null };
  const intervalMs = intervalSec * 1000;
  const candles = [];
  let current = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.ts / intervalMs) * intervalMs;
    const isChainTick = tick.source === 'chain';

    if (!current || current.openTime !== bucket) {
      if (current) candles.push(current);
      if (isChainTick) {
        current = {
          openTime: bucket, closeTime: bucket + intervalMs,
          open: null, high: null, low: null, close: null,
          volume: tick.solAmount || 0,
          buyVolume: tick.isBuy ? (tick.solAmount || 0) : 0,
          sellVolume: !tick.isBuy ? (tick.solAmount || 0) : 0,
          tickCount: 1, priceTickCount: 0,
        };
      } else {
        current = {
          openTime: bucket, closeTime: bucket + intervalMs,
          open: tick.price, high: tick.price, low: tick.price, close: tick.price,
          volume: 0, buyVolume: 0, sellVolume: 0,
          tickCount: 1, priceTickCount: 1,
        };
      }
    } else {
      if (isChainTick) {
        current.volume     += (tick.solAmount || 0);
        current.buyVolume  += tick.isBuy  ? (tick.solAmount || 0) : 0;
        current.sellVolume += !tick.isBuy ? (tick.solAmount || 0) : 0;
        current.tickCount++;
      } else {
        if (current.open === null) {
          current.open = tick.price; current.high = tick.price;
          current.low  = tick.price; current.close = tick.price;
        } else {
          if (tick.price > current.high) current.high = tick.price;
          if (tick.price < current.low)  current.low  = tick.price;
          current.close = tick.price;
        }
        current.tickCount++;
        current.priceTickCount++;
      }
    }
  }

  if (!current) return { closed: candles, current: null };
  const now = Date.now();
  if (now >= current.closeTime) {
    candles.push(current);
    return { closed: candles, current: null };
  }
  return { closed: candles, current };
}

function filterValidCandles(candles) {
  return candles.filter(c => c.open !== null && c.close !== null);
}

// ─── 移动止损 / 持仓超时 / L5 紧止损 (每 tick 检查) ───────────────
function checkStopLoss(currentPrice, tokenState) {
  if (!tokenState.inPosition || !tokenState.position?.entryPriceUsd) {
    return { shouldExit: false, reason: '' };
  }

  const entryPrice = tokenState.position.entryPriceUsd;
  const pnl = (currentPrice - entryPrice) / entryPrice * 100;

  // ★ V7.1 L5 紧止损: 买入后 N 秒内跌破入场价 -P%, 立即平仓
  //   兜底前 4 层防御没挡住的陷阱. 真启动很少在第一分钟就 -5%, 误伤极少.
  if (L5_FAST_STOP_ENABLED && tokenState.position?.buyTime) {
    const heldSec = (Date.now() - tokenState.position.buyTime) / 1000;
    if (heldSec <= FAST_STOP_WINDOW_SEC && pnl <= FAST_STOP_PCT) {
      return { shouldExit: true,
               reason: `FAST_STOP(${pnl.toFixed(1)}%≤${FAST_STOP_PCT}% in ${heldSec.toFixed(0)}s≤${FAST_STOP_WINDOW_SEC}s)` };
    }
  }

  // 移动止损
  if (TRAILING_STOP_ENABLED && tokenState.position) {
    if (!tokenState.position._peakPrice || currentPrice > tokenState.position._peakPrice) {
      tokenState.position._peakPrice = currentPrice;
    }
    const peakPrice = tokenState.position._peakPrice;
    const peakPnl = (peakPrice - entryPrice) / entryPrice * 100;
    if (peakPnl >= TRAILING_STOP_ACTIVATE) {
      const dropFromPeak = (currentPrice - peakPrice) / peakPrice * 100;
      if (dropFromPeak <= TRAILING_STOP_PCT) {
        return { shouldExit: true,
                 reason: `TRAILING_STOP(峰值+${peakPnl.toFixed(1)}%,回撤${dropFromPeak.toFixed(1)}%≤${TRAILING_STOP_PCT}%)` };
      }
    }
  }

  // 持仓超时
  if (HOLD_TIMEOUT_SEC > 0 && tokenState.position?.buyTime) {
    const heldSec = (Date.now() - tokenState.position.buyTime) / 1000;
    if (heldSec >= HOLD_TIMEOUT_SEC) {
      return { shouldExit: true,
               reason: `HOLD_TIMEOUT(${(heldSec/60).toFixed(1)}min≥${(HOLD_TIMEOUT_SEC/60).toFixed(0)}min)` };
    }
  }

  return { shouldExit: false, reason: '', pnl };
}

// ─── 量能衰竭检测 ──────────────────────────────────────────────────
function checkVolumeFade(closedCandles) {
  if (!VOL_FADE_ENABLED) return { fade: false, reason: 'VOL_FADE_DISABLED' };
  if (closedCandles.length < VOL_FADE_LOOKBACK + VOL_FADE_CONSECUTIVE) {
    return { fade: false, reason: 'INSUFFICIENT_DATA' };
  }
  const baseEnd = closedCandles.length - VOL_FADE_CONSECUTIVE;
  const baseStart = Math.max(0, baseEnd - VOL_FADE_LOOKBACK);
  const baseCandles = closedCandles.slice(baseStart, baseEnd);
  const baseAvg = baseCandles.reduce((s, c) => s + (c.volume || 0), 0) / baseCandles.length;
  if (baseAvg <= 0) return { fade: false, reason: 'BASE_AVG_ZERO' };

  const recent = closedCandles.slice(-VOL_FADE_CONSECUTIVE);
  const allFaded = recent.every(c => (c.volume || 0) < baseAvg);
  if (allFaded) {
    const recentVols = recent.map(c => (c.volume || 0).toFixed(1)).join(',');
    return { fade: true,
             reason: `VOL_FADE(recent=[${recentVols}]<SMA${VOL_FADE_LOOKBACK}=${baseAvg.toFixed(1)})` };
  }
  return { fade: false, reason: '' };
}

// ─── 主信号函数 ────────────────────────────────────────────────────
function evaluateSignal(closedCandles, realtimePrice, tokenState) {
  if (!closedCandles || closedCandles.length < SKIP_FIRST_CANDLES) {
    return { signal: null, reason: `WARMING_UP(${closedCandles?.length || 0}/${SKIP_FIRST_CANDLES})`, volume: {} };
  }
  // 量能爆发判断需要 lookback 根历史 + 1 根当根
  if (closedCandles.length < VOL_SPIKE_LOOKBACK + 1) {
    return { signal: null,
             reason: `INSUFFICIENT_CANDLES(${closedCandles.length}/${VOL_SPIKE_LOOKBACK + 1})`,
             volume: {} };
  }

  const len = closedCandles.length;
  const lastCandle = closedCandles[len - 1];
  const lastCandleTs = lastCandle.openTime;

  // 当前根 K 线量能信息 (供前端展示)
  const buyVol  = lastCandle.buyVolume  || 0;
  const sellVol = lastCandle.sellVolume || 0;
  const totalVol = buyVol + sellVol;
  const buyRatio = totalVol > 0 ? buyVol / totalVol : 0;
  const volumeInfo = {
    currentVol: lastCandle.volume || 0,
    buyVol, sellVol,
    buyRatio,
    windowSec: KLINE_SEC,
  };

  // ── 持仓中: 优先检查卖出条件 ──────────────────────────────────
  if (tokenState.inPosition) {
    // 1. 移动止损 / 持仓超时
    const sl = checkStopLoss(realtimePrice, tokenState);
    if (sl.shouldExit) {
      return { signal: 'SELL', reason: sl.reason, volume: volumeInfo };
    }

    // 2. 卖压反转 (同 1 分钟 sellVol 占比 ≥ 60%)
    //    本根 K 线只触发一次, 用 _lastSellPressureCandle 去重
    if (SELL_DOMINANCE_ENABLED && totalVol >= VOL_MIN_TOTAL) {
      const sellRatio = totalVol > 0 ? sellVol / totalVol : 0;
      if (sellRatio * 100 >= SELL_DOMINANCE_PCT) {
        if (tokenState._lastSellPressureCandle !== lastCandleTs) {
          tokenState._lastSellPressureCandle = lastCandleTs;
          return { signal: 'SELL',
                   reason: `SELL_PRESSURE(sellRatio=${(sellRatio*100).toFixed(0)}%≥${SELL_DOMINANCE_PCT}%,total=${totalVol.toFixed(1)}SOL)`,
                   volume: volumeInfo };
        }
      }
    }

    // 3. 量能衰竭
    const fade = checkVolumeFade(closedCandles);
    if (fade.fade) {
      return { signal: 'SELL', reason: fade.reason, volume: volumeInfo };
    }
  }

  // ── 未持仓: 检查买入条件 (AND, 三者全部满足) ─────────────────
  if (!tokenState.inPosition) {
    // ── 同一根 K 线只触发一次 (用 _lastBuyCandle 去重) ──
    const lastBuyCandle = tokenState._lastBuyCandle ?? -1;
    if (lastCandleTs === lastBuyCandle) {
      return { signal: null, reason: '', volume: volumeInfo };
    }

    // ═══════════════════════════════════════════════════════════
    // ★ V7.1 L3 跟根确认状态机
    //   流程:
    //     T0 (信号根) — 三条件 + L1/L2/L4 全过 → 设置 _pendingBuy = { candleTs, close }
    //                  本根不买, 等下根
    //     T1 (信号根的下一根) — 检查 close > T0.close 且 close > open → 触发 BUY
    //                          否则清除 pending, 信号作废
    //   超时: T0 之后 L3_FOLLOWUP_TIMEOUT_SEC 秒内未确认则清除
    // ═══════════════════════════════════════════════════════════
    if (L3_FOLLOWUP_CONFIRM_ENABLED && tokenState._pendingBuy) {
      const pending = tokenState._pendingBuy;
      const ageMs = Date.now() - pending.signalTs;

      // 超时清除
      if (ageMs > L3_FOLLOWUP_TIMEOUT_SEC * 1000) {
        tokenState._pendingBuy = null;
        return { signal: null,
                 reason: `L3_PENDING_TIMEOUT(age=${(ageMs/1000).toFixed(0)}s>${L3_FOLLOWUP_TIMEOUT_SEC}s)`,
                 volume: volumeInfo };
      }

      // 必须是 pending 之后的新 K 线 (信号根本身已收盘, 下一根又收盘了)
      if (lastCandleTs > pending.candleTs) {
        const followClose = lastCandle.close;
        const followOpen  = lastCandle.open;
        // 跟根确认: close > 信号根 close (维持涨势) 且 当根不是大红柱 (close >= open)
        const continued = followClose > pending.signalClose;
        const notBearish = followClose >= followOpen;

        if (continued && notBearish) {
          // 跟根确认通过 → 触发 BUY
          tokenState._lastBuyCandle = lastCandleTs;
          tokenState._pendingBuy = null;
          return {
            signal: 'BUY',
            reason: `L3_CONFIRMED+${pending.reason}+FOLLOW(close=${followClose.toFixed(8)}>signal=${pending.signalClose.toFixed(8)})`,
            volume: volumeInfo,
          };
        } else {
          // 跟根失败 → 清除 pending
          tokenState._pendingBuy = null;
          const failReasons = [];
          if (!continued)  failReasons.push(`close=${followClose.toFixed(8)}≤signal=${pending.signalClose.toFixed(8)}`);
          if (!notBearish) failReasons.push(`大红柱(close=${followClose.toFixed(8)}<open=${followOpen.toFixed(8)})`);
          return { signal: null,
                   reason: `L3_REJECTED(${failReasons.join(',')})`,
                   volume: volumeInfo };
        }
      }
      // 还在信号根本身, 继续等
      // (注意: lastCandleTs === pending.candleTs 意味着这次评估还在信号根, 但前面有 _lastBuyCandle 去重不会进到这里)
    }

    // ① 量能爆发: lastCandle.volume ≥ SMA(lookback) × VOL_SPIKE_MULT
    const baseStart = len - 1 - VOL_SPIKE_LOOKBACK;
    const baseCandles = closedCandles.slice(baseStart, len - 1);
    const baseAvgVol = baseCandles.reduce((s, c) => s + (c.volume || 0), 0) / baseCandles.length;
    const lastVol = lastCandle.volume || 0;

    // 总量门槛 — 优先于其他判断, 避免基线为 0 时 N/0 的判断歧义
    if (lastVol < VOL_MIN_TOTAL) {
      return { signal: null,
               reason: `VOL_TOO_LOW(${lastVol.toFixed(1)}<${VOL_MIN_TOTAL}SOL)`,
               volume: volumeInfo };
    }
    // 基线为 0 时, 任何成交量都算"爆发", 但容易误触发 — 要求 lastVol >= 2× VOL_MIN_TOTAL 才认为是真信号
    let spikeOk, spikeReasonStr, spikeFailStr;
    if (baseAvgVol <= 0) {
      spikeOk = lastVol >= VOL_MIN_TOTAL * 2;
      spikeReasonStr = `SPIKE(base=0,vol=${lastVol.toFixed(1)}SOL,need≥${(VOL_MIN_TOTAL*2).toFixed(1)})`;
      spikeFailStr   = `NO_SPIKE(base=0,vol=${lastVol.toFixed(1)}<${(VOL_MIN_TOTAL*2).toFixed(1)})`;
    } else {
      const spikeMult = lastVol / baseAvgVol;
      spikeOk = spikeMult >= VOL_SPIKE_MULT;
      spikeReasonStr = `SPIKE(${spikeMult.toFixed(1)}x≥${VOL_SPIKE_MULT}x,vol=${lastVol.toFixed(1)},base=${baseAvgVol.toFixed(1)})`;
      spikeFailStr   = `NO_SPIKE(${spikeMult.toFixed(1)}x<${VOL_SPIKE_MULT}x,vol=${lastVol.toFixed(1)},base=${baseAvgVol.toFixed(1)})`;
    }
    if (!spikeOk) {
      return { signal: null, reason: spikeFailStr, volume: volumeInfo };
    }

    // ② 买盘主导
    const buyDomOk = (buyRatio * 100) >= BUY_DOMINANCE_PCT;
    if (!buyDomOk) {
      return { signal: null,
               reason: `LOW_BUY_DOM(${(buyRatio*100).toFixed(0)}%<${BUY_DOMINANCE_PCT}%,${spikeReasonStr})`,
               volume: volumeInfo };
    }

    // ③ 价格跟涨 (本根 K 线 close vs open)
    const priceChangePct = lastCandle.open > 0
      ? (lastCandle.close - lastCandle.open) / lastCandle.open * 100
      : 0;
    const momentumOk = priceChangePct >= PRICE_MOMENTUM_PCT;
    if (!momentumOk) {
      return { signal: null,
               reason: `LOW_MOMENTUM(${priceChangePct.toFixed(1)}%<${PRICE_MOMENTUM_PCT}%,${spikeReasonStr})`,
               volume: volumeInfo };
    }

    // ═══════════════════════════════════════════════════════════
    // ★ V7.1 防陷阱过滤层 (L1 / L2 / L4) — 单根特征检验 + 累涨封顶
    // ═══════════════════════════════════════════════════════════

    // L1 实体扎实: body / range >= MIN_BODY_RATIO
    //   防止"高开高走收盘缩回"形态 — 即使涨幅满足 momentum, 但 K 线大部分是影子
    //   例: open=100 high=120 low=99 close=106 → momentum 6% 通过, 但 body=6 / range=21 = 0.29 (实体只占 29%)
    if (L1_BODY_FILTER_ENABLED) {
      const bodyAbs = Math.abs(lastCandle.close - lastCandle.open);
      const rangeAbs = lastCandle.high - lastCandle.low;
      // range 为 0 时 (一字 K 线) 视为通过
      if (rangeAbs > 0) {
        const bodyRatio = bodyAbs / rangeAbs;
        if (bodyRatio < MIN_BODY_RATIO) {
          return { signal: null,
                   reason: `L1_THIN_BODY(body/range=${bodyRatio.toFixed(2)}<${MIN_BODY_RATIO},${spikeReasonStr})`,
                   volume: volumeInfo };
        }
      }
    }

    // L2 上影线检验: upperWick / |body| <= MAX_UPPER_WICK_RATIO
    //   防止"插针"K 线 (实体小, 但上影线巨长) 触发买入
    if (L2_UPPER_WICK_FILTER_ENABLED) {
      const bodyTop = Math.max(lastCandle.open, lastCandle.close);
      const bodyAbs = Math.abs(lastCandle.close - lastCandle.open);
      const upperWick = lastCandle.high - bodyTop;
      // bodyAbs 为 0 已被 L1 拦掉, 这里只做兜底保护
      if (bodyAbs > 0) {
        const wickRatio = upperWick / bodyAbs;
        if (wickRatio > MAX_UPPER_WICK_RATIO) {
          return { signal: null,
                   reason: `L2_LONG_UPPER_WICK(wick/body=${wickRatio.toFixed(2)}>${MAX_UPPER_WICK_RATIO},${spikeReasonStr})`,
                   volume: volumeInfo };
        }
      }
    }

    // L4 累涨封顶: 信号根 close vs N 根前 close 涨幅 ≤ MAX_PRECEDING_RUNUP_PCT
    //   防止追到"拉高出货"的中后段 (前面已经涨爆了)
    if (L4_RUNUP_FILTER_ENABLED && len > RUNUP_LOOKBACK_BARS) {
      const refCandle = closedCandles[len - 1 - RUNUP_LOOKBACK_BARS];
      if (refCandle && refCandle.close > 0) {
        const runupPct = (lastCandle.close - refCandle.close) / refCandle.close * 100;
        if (runupPct > MAX_PRECEDING_RUNUP_PCT) {
          return { signal: null,
                   reason: `L4_OVER_EXTENDED(${RUNUP_LOOKBACK_BARS}bar前累涨${runupPct.toFixed(1)}%>${MAX_PRECEDING_RUNUP_PCT}%,${spikeReasonStr})`,
                   volume: volumeInfo };
        }
      }
    }

    // ─── 三条件 + L1/L2/L4 全部通过 ───
    const baseReason = `${spikeReasonStr}+BUY_DOM(${(buyRatio*100).toFixed(0)}%≥${BUY_DOMINANCE_PCT}%)+MOMENTUM(${priceChangePct.toFixed(1)}%≥${PRICE_MOMENTUM_PCT}%)`;

    if (L3_FOLLOWUP_CONFIRM_ENABLED) {
      // ★ L3 跟根确认: 设置 pending, 等下根 K 线确认
      tokenState._pendingBuy = {
        candleTs: lastCandleTs,
        signalClose: lastCandle.close,
        signalTs: Date.now(),
        reason: baseReason,
      };
      // 同时标记 lastBuyCandle, 避免本根 K 线再次进入此分支
      tokenState._lastBuyCandle = lastCandleTs;
      return { signal: null,
               reason: `L3_PENDING(等待下一根确认,signal_close=${lastCandle.close.toFixed(8)})`,
               volume: volumeInfo };
    }

    // L3 关闭时, 直接触发 BUY (V7 行为)
    tokenState._lastBuyCandle = lastCandleTs;
    return {
      signal: 'BUY',
      reason: baseReason,
      volume: volumeInfo,
    };
  }

  return { signal: null, reason: '', volume: volumeInfo };
}

module.exports = {
  evaluateSignal,
  buildCandles,
  filterValidCandles,
  checkStopLoss,
  checkVolumeFade,
  // 顶层导出, 供 monitor.js 启动日志读取
  TRAILING_STOP_ENABLED, TRAILING_STOP_ACTIVATE, TRAILING_STOP_PCT,
  CONFIG: {
    KLINE_SEC,
    VOL_SPIKE_MULT, VOL_SPIKE_LOOKBACK,
    BUY_DOMINANCE_PCT, PRICE_MOMENTUM_PCT, VOL_MIN_TOTAL,
    SKIP_FIRST_CANDLES,
    // V7.1 防陷阱过滤器
    L1_BODY_FILTER_ENABLED, MIN_BODY_RATIO,
    L2_UPPER_WICK_FILTER_ENABLED, MAX_UPPER_WICK_RATIO,
    L3_FOLLOWUP_CONFIRM_ENABLED, L3_FOLLOWUP_TIMEOUT_SEC,
    L4_RUNUP_FILTER_ENABLED, RUNUP_LOOKBACK_BARS, MAX_PRECEDING_RUNUP_PCT,
    L5_FAST_STOP_ENABLED, FAST_STOP_WINDOW_SEC, FAST_STOP_PCT,
    // 卖出
    TRAILING_STOP_ENABLED, TRAILING_STOP_ACTIVATE, TRAILING_STOP_PCT,
    SELL_DOMINANCE_ENABLED, SELL_DOMINANCE_PCT,
    VOL_FADE_ENABLED, VOL_FADE_CONSECUTIVE, VOL_FADE_LOOKBACK,
    HOLD_TIMEOUT_SEC,
  },
};

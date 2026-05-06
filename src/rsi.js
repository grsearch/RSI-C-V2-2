'use strict';
// src/rsi.js — RSI 计算 + 量能过滤 + BUY/SELL 信号逻辑 (V3)
//
// V3 修复：
//   1. buildCandles 区分「价格 tick」和「链上交易 tick」
//      - 价格 tick（来自 Birdeye WS/HTTP，USD 计价）→ 构成 OHLC
//      - 链上 tick（来自 Helius WS，SOL 计价） → 只贡献 volume/buyVolume/sellVolume
//      - 解决了 V2 中 SOL 价格和 USD 价格混入同一数组导致 RSI 错乱的致命 BUG
//
//   2. 止损检查独立于 K 线周期，每个 tick 都检查（快速止损）
//
// 策略：
//   BUY : RSI(7) < 35（超卖区）+ totalVol ≥ 15 SOL + buyVol ≥ 1.2×sellVol
//   SELL: RSI 下穿 70 / RSI > 80 / 止盈 / 止损 / 量能萎缩出场

const RSI_PERIOD   = parseInt(process.env.RSI_PERIOD       || '7',  10);
// ★ 改动: RSI 买入阈值从 35 改为 30 (更深超卖才买)
const RSI_BUY      = parseFloat(process.env.RSI_BUY_LEVEL  || '30');
const RSI_SELL     = parseFloat(process.env.RSI_SELL_LEVEL  || '70');
const RSI_PANIC    = parseFloat(process.env.RSI_PANIC_LEVEL || '80');
const KLINE_SEC    = parseInt(process.env.KLINE_INTERVAL_SEC || '300', 10);

// 量能参数
const VOL_ENABLED         = (process.env.VOL_ENABLED || 'true') === 'true';
const VOL_BUY_MULT        = parseFloat(process.env.VOL_BUY_MULT          || '1.2');
const VOL_SELL_MULT       = parseFloat(process.env.VOL_SELL_MULT         || '999'); // sellVol >= N × buyVol 触发卖出（默认999=禁用）
const VOL_MIN_TOTAL       = parseFloat(process.env.VOL_MIN_TOTAL         || '5');  // 最低总成交量(SOL) // buyVol >= N × sellVol 才买入
const VOL_WINDOW_SEC      = parseInt(process.env.VOL_WINDOW_SEC       || '300', 10);
const VOL_EXIT_CONSECUTIVE = parseInt(process.env.VOL_EXIT_CONSECUTIVE || '3', 10);
const VOL_EXIT_RATIO      = parseFloat(process.env.VOL_EXIT_RATIO     || '0.3');
const VOL_EXIT_LOOKBACK   = parseInt(process.env.VOL_EXIT_LOOKBACK    || '4', 10);
// ★ 量能萎缩出场总开关（默认 false，彻底关闭此出场逻辑）
const VOL_DECAY_EXIT_ENABLED = (process.env.VOL_DECAY_EXIT_ENABLED || 'false') === 'true';
const SKIP_FIRST_CANDLES  = parseInt(process.env.SKIP_FIRST_CANDLES   || '3', 10);

// 止盈止损
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '100');
// ★ 固定止盈总开关（默认 true，+100% 时止盈卖出）
const TAKE_PROFIT_ENABLED = (process.env.TAKE_PROFIT_ENABLED || 'true') === 'true';
const STOP_LOSS_PCT   = parseFloat(process.env.STOP_LOSS_PCT   || '-50');
// ★ 改动: 固定止损默认关闭 (用户要求关闭固定止损)
const STOP_LOSS_ENABLED = (process.env.STOP_LOSS_ENABLED || 'false') === 'true';

// 移动止损（Trailing Stop）
const TRAILING_STOP_ENABLED  = (process.env.TRAILING_STOP_ENABLED  || 'true') === 'true';
const TRAILING_STOP_ACTIVATE = parseFloat(process.env.TRAILING_STOP_ACTIVATE || '30'); // 上涨 30% 后激活
const TRAILING_STOP_PCT      = parseFloat(process.env.TRAILING_STOP_PCT      || '-20'); // 峰值回撤 20% 清仓

// ★ 改动: 24h 跌幅买入触发条件
//   原理: 现价 vs 24h 最高价, 跌幅 >= DROP_24H_BUY_PCT (默认 60%) 时允许买入
//   独立于 RSI < 30 触发, 是另一个买入入口 (二选一)
//   注意: drop 用绝对值, 60 表示"跌了 60%"
const DROP_24H_BUY_ENABLED = (process.env.DROP_24H_BUY_ENABLED || 'true') === 'true';
const DROP_24H_BUY_PCT     = parseFloat(process.env.DROP_24H_BUY_PCT || '60');

// ★ 改动: 加仓配置
//   条件: 已持仓 + 现价比买入价低 ADD_POSITION_DROP_PCT (默认 50%) + 还满足买入条件
//   每个仓位最多加仓 ADD_POSITION_MAX_TIMES (默认 1) 次
const ADD_POSITION_ENABLED   = (process.env.ADD_POSITION_ENABLED || 'true') === 'true';
const ADD_POSITION_DROP_PCT  = parseFloat(process.env.ADD_POSITION_DROP_PCT || '50'); // 跌幅, 绝对值
const ADD_POSITION_MAX_TIMES = parseInt(process.env.ADD_POSITION_MAX_TIMES || '1', 10);

// EMA99 买入过滤：价格必须在 EMA99 下方才允许买入
const EMA_PERIOD = parseInt(process.env.EMA_PERIOD || '99', 10);
// ★ EMA99 不足时的行为：strict=拒绝买入(推荐), lenient=跳过该过滤(旧行为,有漏洞)
const EMA_INSUFFICIENT_MODE = (process.env.EMA_INSUFFICIENT_MODE || 'strict').toLowerCase();

// ★ V6: EMA99 斜率过滤 —— 拒绝在 EMA99 下行趋势中买入（"接飞刀"防护）
//   原理：RSI 超卖在上升趋势中是健康回调 → 适合买入
//         RSI 超卖在下降趋势中只是趋势延续 → 容易继续跌（BELIEF 案例）
//   计算：slope = (EMA99_now - EMA99_N根前) / EMA99_N根前
//         slope < EMA_SLOPE_MIN_PCT → 拒绝买入
//   默认 LOOKBACK=5 (5根×5分钟K线=25分钟窗口), MIN_PCT=-1 (斜率 > -1% 才允许买入)
// ★ 改动: 默认关闭 EMA99 斜率过滤 (买入端)
const EMA_SLOPE_ENABLED  = (process.env.EMA_SLOPE_ENABLED || 'false') === 'true';
const EMA_SLOPE_LOOKBACK = parseInt(process.env.EMA_SLOPE_LOOKBACK || '5', 10);
const EMA_SLOPE_MIN_PCT  = parseFloat(process.env.EMA_SLOPE_MIN_PCT || '-1'); // -1 = 仅允许轻微下行（防接飞刀）

// ★ 产生买卖信号所需的最小已收盘K线数（低于此数量完全不产生信号，避免 RSI 不收敛误判）
//   默认 max(SKIP_FIRST_CANDLES, RSI_PERIOD × 3) ≈ 21，这是 Wilder RSI 收敛所需
const MIN_CANDLES_FOR_SIGNAL = parseInt(
  process.env.MIN_CANDLES_FOR_SIGNAL ||
  String(Math.max(parseInt(process.env.SKIP_FIRST_CANDLES || '3', 10), RSI_PERIOD * 3)),
  10
);

function calcEMA(closes, period) {
  if (closes.length < period) return NaN;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * 计算 EMA 斜率：返回当前 EMA 和 lookback 根前的 EMA
 * @returns {{ emaNow: number, emaPrev: number, slopePct: number }} 或 null（数据不足）
 */
function calcEMASlope(closes, period, lookback) {
  // 需要 period + lookback 根 close 才能有两个 EMA 点
  if (closes.length < period + lookback) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  // 记录倒数第 lookback 个位置的 EMA
  const targetIdx = closes.length - lookback; // emaPrev 的位置
  let emaPrev = NaN;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    if (i === targetIdx - 1) emaPrev = ema;
  }
  if (!Number.isFinite(emaPrev) || emaPrev <= 0) return null;
  const slopePct = (ema - emaPrev) / emaPrev * 100;
  return { emaNow: ema, emaPrev, slopePct };
}

// ── Wilder RSI 计算 ────────────────────────────────────────────────

function calcRSIWithState(closes, period = RSI_PERIOD) {
  const rsiArray = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return { rsiArray, avgGain: NaN, avgLoss: NaN };

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsiArray[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsiArray[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return { rsiArray, avgGain, avgLoss };
}

function stepRSI(avgGain, avgLoss, lastClose, newPrice, period = RSI_PERIOD) {
  if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return NaN;
  const diff = newPrice - lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? Math.abs(diff) : 0;
  const ag = (avgGain * (period - 1) + gain) / period;
  const al = (avgLoss * (period - 1) + loss) / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

// ── 量能检测 ─────────────────────────────────────────────────────

function checkBuyVolume(closedCandles, currentCandle) {
  if (!VOL_ENABLED) return { pass: true, reason: 'VOL_DISABLED', buyVol: 0, sellVol: 0, ratio: 0 };

  const windowBars = Math.max(1, Math.ceil(VOL_WINDOW_SEC / KLINE_SEC));

  const allCandles = [...closedCandles];
  if (currentCandle) allCandles.push(currentCandle);

  if (allCandles.length < windowBars) {
    return { pass: false, reason: 'VOL_INSUFFICIENT_DATA', buyVol: 0, sellVol: 0, ratio: 0 };
  }

  const windowCandles = allCandles.slice(-windowBars);

  let totalBuy  = 0;
  let totalSell = 0;
  for (const c of windowCandles) {
    totalBuy  += (c.buyVolume  || 0);
    totalSell += (c.sellVolume || 0);
  }

  const total = totalBuy + totalSell;
  const ratio = total > 0 ? totalBuy / total : 0;

  // 没有链上方向数据 → 拒绝买入
  if (total === 0) {
    return { pass: false, reason: 'VOL_NO_DIRECTION_DATA', buyVol: 0, sellVol: 0, ratio: 0 };
  }

  // ★ 最低总成交量门槛
  if (total < VOL_MIN_TOTAL) {
    const mult = totalSell > 0 ? (totalBuy / totalSell).toFixed(1) : '∞';
    return {
      pass: false,
      reason: `VOL_TOO_LOW(${total.toFixed(1)}<${VOL_MIN_TOTAL}SOL,${mult}x,${VOL_WINDOW_SEC}s)`,
      buyVol: totalBuy, sellVol: totalSell, ratio,
    };
  }

  // 核心条件：buyVol >= VOL_BUY_MULT × sellVol
  if (totalBuy >= totalSell * VOL_BUY_MULT) {
    const mult = totalSell > 0 ? (totalBuy / totalSell).toFixed(1) : '∞';
    return {
      pass: true,
      reason: `BUY≥${VOL_BUY_MULT}xSELL(${totalBuy.toFixed(2)}>=${(totalSell*VOL_BUY_MULT).toFixed(2)},${mult}x,${(ratio*100).toFixed(0)}%,${VOL_WINDOW_SEC}s)`,
      buyVol: totalBuy, sellVol: totalSell, ratio,
    };
  }

  const mult = totalSell > 0 ? (totalBuy / totalSell).toFixed(1) : '0';
  return {
    pass: false,
    reason: `BUY<${VOL_BUY_MULT}xSELL(buy=${totalBuy.toFixed(2)},sell=${totalSell.toFixed(2)},${mult}x,${VOL_WINDOW_SEC}s)`,
    buyVol: totalBuy, sellVol: totalSell, ratio,
  };
}

function checkVolumeDecay(closedCandles, tokenState) {
  // ★ 总开关：VOL_DECAY_EXIT_ENABLED=false 时彻底禁用量能萎缩出场
  if (!VOL_DECAY_EXIT_ENABLED) return { shouldExit: false, reason: 'VOL_DECAY_EXIT_DISABLED' };
  if (!VOL_ENABLED) return { shouldExit: false, reason: '' };
  if (closedCandles.length < VOL_EXIT_LOOKBACK + VOL_EXIT_CONSECUTIVE) {
    return { shouldExit: false, reason: 'INSUFFICIENT_DATA' };
  }

  const avgEnd = closedCandles.length - VOL_EXIT_CONSECUTIVE;
  const avgStart = Math.max(0, avgEnd - VOL_EXIT_LOOKBACK);
  const avgCandles = closedCandles.slice(avgStart, avgEnd);
  const avgVol = avgCandles.reduce((s, c) => s + (c.volume || 0), 0) / avgCandles.length;

  if (avgVol <= 0) return { shouldExit: false, reason: 'AVG_VOL_ZERO' };

  const recentCandles = closedCandles.slice(-VOL_EXIT_CONSECUTIVE);
  const allDecayed = recentCandles.every(c => (c.volume || 0) < avgVol * VOL_EXIT_RATIO);

  if (allDecayed) {
    const recentVols = recentCandles.map(c => (c.volume || 0).toFixed(0)).join(',');
    return {
      shouldExit: true,
      reason: `VOL_DECAY(recent=[${recentVols}]<avg=${avgVol.toFixed(0)}×${VOL_EXIT_RATIO})`,
    };
  }

  return { shouldExit: false, reason: '' };
}

// ── 快速止损检查（独立于 K 线，每个 tick 调用） ──────────────────

/**
 * 快速止损/止盈检查，不依赖 RSI，直接看价格偏离
 * @returns {{ shouldExit: boolean, reason: string }}
 */
function checkStopLoss(currentPrice, tokenState) {
  if (!tokenState.inPosition || !tokenState.position?.entryPriceUsd) {
    return { shouldExit: false, reason: '' };
  }

  const entryPrice = tokenState.position.entryPriceUsd;
  const pnl = (currentPrice - entryPrice) / entryPrice * 100;

  // ── 移动止损（Trailing Stop）────────────────────────────────────
  if (TRAILING_STOP_ENABLED && tokenState.position) {
    // 每个 tick 更新峰值价格
    if (!tokenState.position._peakPrice || currentPrice > tokenState.position._peakPrice) {
      tokenState.position._peakPrice = currentPrice;
    }
    const peakPrice = tokenState.position._peakPrice;
    const peakPnl   = (peakPrice - entryPrice) / entryPrice * 100;

    // 上涨达到激活线后，从峰值回撤超过阈值则清仓
    if (peakPnl >= TRAILING_STOP_ACTIVATE) {
      const dropFromPeak = (currentPrice - peakPrice) / peakPrice * 100;
      if (dropFromPeak <= TRAILING_STOP_PCT) {
        return {
          shouldExit: true,
          reason: `TRAILING_STOP(峰值+${peakPnl.toFixed(1)}%,回撤${dropFromPeak.toFixed(1)}%≤${TRAILING_STOP_PCT}%)`
        };
      }
    }
  }

  // ── 固定止盈 / 固定止损 ───────────────────────────────────────
  // ★ 固定止盈已默认禁用（TAKE_PROFIT_ENABLED=false），只走移动止损/RSI 出场
  if (TAKE_PROFIT_ENABLED && pnl >= TAKE_PROFIT_PCT) {
    return { shouldExit: true, reason: `TAKE_PROFIT(+${pnl.toFixed(1)}%≥${TAKE_PROFIT_PCT}%)` };
  }
  // ★ 固定止损已默认禁用（STOP_LOSS_ENABLED=false）
  if (STOP_LOSS_ENABLED && pnl <= STOP_LOSS_PCT) {
    return { shouldExit: true, reason: `STOP_LOSS(${pnl.toFixed(1)}%≤${STOP_LOSS_PCT}%)` };
  }

  return { shouldExit: false, reason: '', pnl };
}

// ── 主信号函数 ─────────────────────────────────────────────────────

function evaluateSignal(closedCandles, realtimePrice, tokenState) {
  const MIN_CANDLES = RSI_PERIOD + 2;
  if (!closedCandles || closedCandles.length < MIN_CANDLES) {
    return { rsi: NaN, prevRsi: NaN, signal: null, reason: 'warming_up', volume: {} };
  }

  if (closedCandles.length < SKIP_FIRST_CANDLES) {
    return { rsi: NaN, prevRsi: NaN, signal: null, reason: `skip_first(${closedCandles.length}/${SKIP_FIRST_CANDLES})`, volume: {} };
  }

  // ★ RSI 收敛门槛：低于 MIN_CANDLES_FOR_SIGNAL 时不产生买卖信号
  //   但依然返回 rsi 供前端展示（只是不用这个 rsi 做交易决策）
  const belowConvergence = closedCandles.length < MIN_CANDLES_FOR_SIGNAL;

  const closes = closedCandles.map(c => c.close);
  const len    = closes.length;

  const { rsiArray, avgGain, avgLoss } = calcRSIWithState(closes, RSI_PERIOD);
  const lastClosedRsi = rsiArray[len - 1];
  const lastClose     = closes[len - 1];

  // ★ 缓存到 tokenState，供 WS tick 快速下穿检测使用（避免重复计算）
  const lastCandleTs = closedCandles[len - 1].openTime;
  if (lastCandleTs !== tokenState._rsiLastCandleTs) {
    tokenState._rsiAvgGain      = avgGain;
    tokenState._rsiAvgLoss      = avgLoss;
    tokenState._rsiLastClose    = lastClose;
    tokenState._rsiLastCandleTs = lastCandleTs;
  }

  const rsiRealtime = stepRSI(avgGain, avgLoss, lastClose, realtimePrice, RSI_PERIOD);

  if (!Number.isFinite(lastClosedRsi) || !Number.isFinite(rsiRealtime)) {
    return { rsi: NaN, prevRsi: NaN, signal: null, reason: 'rsi_nan', volume: {},
             avgGain: NaN, avgLoss: NaN, lastClose: NaN };
  }

  const nowMs          = Date.now();
  // lastCandleTs 已在上方 RSI 缓存块里声明，直接复用
  const lastBuyCandle  = tokenState._lastBuyCandle  ?? -1;
  const lastSellCandle = tokenState._lastSellCandle ?? -1;

  const prevRsiRaw = tokenState._prevRsiRealtime;
  const prevTs     = tokenState._prevRsiTs ?? 0;
  // ★ V5-15: 时效窗口从 10s 收紧到 3s；失效时不 fallback 到 lastClosedRsi
  //   旧逻辑用"几分钟前的已收盘K线RSI"和"当前实时RSI"比较会产生虚假下穿，
  //   例如 lastClosedRsi=71.3、rsiRealtime=32.6 → 日志"71.3→32.6"其实不是真下穿
  const STALE_MS   = 3000;
  const isStale    = !Number.isFinite(prevRsiRaw) || (nowMs - prevTs) > STALE_MS;
  // stale 时 prevRsi = null，下面的下穿判断会跳过（不会误触发）
  const prevRsi    = isStale ? NaN : prevRsiRaw;

  const updateState = () => {
    tokenState._prevRsiRealtime = rsiRealtime;
    tokenState._prevRsiTs       = nowMs;
  };

  // 量能信息
  const latestCandle = closedCandles[len - 1];
  const windowBars = Math.max(1, Math.ceil(VOL_WINDOW_SEC / KLINE_SEC));
  const windowCandles = closedCandles.slice(-windowBars);
  let winBuy = 0, winSell = 0;
  for (const c of windowCandles) {
    winBuy  += (c.buyVolume  || 0);
    winSell += (c.sellVolume || 0);
  }
  const winTotal = winBuy + winSell;
  const volumeInfo = {
    currentVol: latestCandle.volume || 0,
    buyVol:  winBuy,
    sellVol: winSell,
    buyRatio: winTotal > 0 ? winBuy / winTotal : 0,
    windowSec: VOL_WINDOW_SEC,
  };

  // ── SELL 优先（持仓中） ────────────────────────────────────────
  if (tokenState.inPosition) {

    // 1. RSI > 80 恐慌卖
    //    ★ V5: 只信任已收盘K线RSI（lastClosedRsi），不用 stepRSI 实时估算
    //    stepRSI 在K线内波动剧烈时容易算出虚假高值（如95.7），
    //    导致在RSI实际只有40-60的时候误触恐慌卖出
    //    ★ V5-9: K线数不足 MIN_CANDLES_FOR_SIGNAL 时不触发 RSI 卖出（RSI 未收敛会乱跳）
    if (!belowConvergence && lastClosedRsi > RSI_PANIC) {
      const lastPanicTs = tokenState._lastPanicSellTs ?? 0;
      if (nowMs - lastPanicTs >= 2000) {
        tokenState._lastPanicSellTs = nowMs;
        updateState();
        return { rsi: lastClosedRsi, prevRsi, signal: 'SELL',
                 reason: `RSI_PANIC(${lastClosedRsi.toFixed(1)}>${RSI_PANIC})`, volume: volumeInfo };
      }
    }

    // 2. RSI 下穿 70
    //    ★ V5-9: K线数不足 MIN_CANDLES_FOR_SIGNAL 时不触发（RSI 未收敛容易虚假下穿）
    if (!belowConvergence && prevRsi >= RSI_SELL && rsiRealtime < RSI_SELL && lastCandleTs !== lastSellCandle) {
      tokenState._lastSellCandle = lastCandleTs;
      updateState();
      return { rsi: rsiRealtime, prevRsi, signal: 'SELL',
               reason: `RSI_CROSS_DOWN_70(${prevRsi.toFixed(1)}→${rsiRealtime.toFixed(1)})`, volume: volumeInfo };
    }

    // 3. 止盈 / 止损（也在 evaluateSignal 中保留，双重保险）
    const sl = checkStopLoss(realtimePrice, tokenState);
    if (sl.shouldExit) {
      updateState();
      return { rsi: rsiRealtime, prevRsi, signal: 'SELL',
               reason: sl.reason, volume: volumeInfo };
    }

    // 4. 卖压卖出 — 已彻底禁用
    // if (VOL_ENABLED && winTotal > 0 && winSell >= winBuy * VOL_SELL_MULT ...) { ... }

    // 5. 量能萎缩出场（★ 默认已禁用，由 VOL_DECAY_EXIT_ENABLED 控制，函数内部短路返回）
    const volDecay = checkVolumeDecay(closedCandles, tokenState);
    if (volDecay.shouldExit) {
      updateState();
      return { rsi: rsiRealtime, prevRsi, signal: 'SELL',
               reason: volDecay.reason, volume: volumeInfo };
    }
  }

  // ── BUY / ADD_POSITION ─────────────────────────────────────────
  // ★ 改动:
  //   触发条件 (满足任一即可): RSI < 30 (超卖)  或  24h 跌幅 >= 60%
  //   过滤条件: 价格在 EMA99 下方 + 量能确认 (buyVol >= 1.2 × sellVol)
  //   - 未持仓 → 普通买入 (signal='BUY')
  //   - 已持仓 + 现价比买入价低 50% + 还没加过仓 → 加仓 (signal='ADD_POSITION')
  {
    // ★ V5-9: K线数不足 MIN_CANDLES_FOR_SIGNAL 时不买入（RSI/EMA 都未收敛）
    if (belowConvergence) {
      updateState();
      return { rsi: rsiRealtime, prevRsi, signal: null,
               reason: tokenState.inPosition ? '' : `INSUFFICIENT_CANDLES(${closedCandles.length}/${MIN_CANDLES_FOR_SIGNAL})`,
               volume: volumeInfo };
    }

    // ── 1. 计算 24h 跌幅 ────────────────────────────
    //   tokenState._high24h 由 monitor 维护 (Birdeye OHLCV 1h × 24 + 实时 tick 创新高更新)
    let drop24hPct = null;  // 跌幅(正数), null=数据不足
    const high24h = tokenState._high24h;
    if (Number.isFinite(high24h) && high24h > 0 && Number.isFinite(realtimePrice) && realtimePrice > 0) {
      drop24hPct = (high24h - realtimePrice) / high24h * 100;
    }

    // ── 2. 触发条件 (RSI 超卖  或  24h 跌幅大) ────────
    const rsiTriggered = rsiRealtime < RSI_BUY;
    const dropTriggered = DROP_24H_BUY_ENABLED && drop24hPct !== null && drop24hPct >= DROP_24H_BUY_PCT;
    if (!rsiTriggered && !dropTriggered) {
      // 没有触发条件, 进入默认 HOLD 流程
    } else {
      // ── 3. 区分: 是普通买入还是加仓 ────────────────
      let buyMode = null; // 'NEW' | 'ADD'
      if (!tokenState.inPosition) {
        buyMode = 'NEW';
      } else if (
        ADD_POSITION_ENABLED &&
        tokenState.position?.entryPriceUsd > 0 &&
        (tokenState._addPositionsCount || 0) < ADD_POSITION_MAX_TIMES
      ) {
        // 已持仓: 检查是否跌穿加仓门槛 (基础是首次买入价, 不是均价, 避免加仓后阈值失效)
        const baseEntry = tokenState.position.firstEntryPriceUsd ?? tokenState.position.entryPriceUsd;
        const dropFromEntry = (baseEntry - realtimePrice) / baseEntry * 100;
        if (dropFromEntry >= ADD_POSITION_DROP_PCT) {
          buyMode = 'ADD';
        }
      }

      if (buyMode) {
        // ── 4. 同一根K线只触发一次 (用 lastBuyCandle 去重) ──
        if (lastCandleTs === lastBuyCandle) {
          // 已在本根K线触发过, 跳过
        } else {
          // ── 5. EMA99 过滤: 价格必须在 EMA99 下方 ──
          const ema99 = calcEMA(closes, EMA_PERIOD);
          if (!Number.isFinite(ema99)) {
            if (EMA_INSUFFICIENT_MODE === 'strict') {
              updateState();
              return { rsi: rsiRealtime, prevRsi, signal: null,
                       reason: `EMA99_INSUFFICIENT_DATA(${closes.length}/${EMA_PERIOD})`, volume: volumeInfo };
            }
          } else if (realtimePrice >= ema99) {
            updateState();
            return { rsi: rsiRealtime, prevRsi, signal: null,
                     reason: `PRICE_ABOVE_EMA99(price=${realtimePrice.toFixed(8)},ema99=${ema99.toFixed(8)})`, volume: volumeInfo };
          }

          // ── 6. EMA99 斜率过滤 (默认已关闭) ──
          let slopeResult = null;
          if (EMA_SLOPE_ENABLED && Number.isFinite(ema99)) {
            slopeResult = calcEMASlope(closes, EMA_PERIOD, EMA_SLOPE_LOOKBACK);
            if (slopeResult && slopeResult.slopePct < EMA_SLOPE_MIN_PCT) {
              updateState();
              return { rsi: rsiRealtime, prevRsi, signal: null,
                       reason: `EMA99_SLOPE_DOWN(slope=${slopeResult.slopePct.toFixed(3)}%<${EMA_SLOPE_MIN_PCT}%,lb=${EMA_SLOPE_LOOKBACK})`,
                       volume: volumeInfo };
            }
          }

          // ── 7. 量能确认: buyVol >= 1.2 × sellVol ──
          const volCheck = checkBuyVolume(closedCandles, null);
          volumeInfo.buyVol   = volCheck.buyVol;
          volumeInfo.sellVol  = volCheck.sellVol;
          volumeInfo.buyRatio = volCheck.ratio;

          if (volCheck.pass) {
            tokenState._lastBuyCandle = lastCandleTs;
            updateState();
            // 构造原因字符串
            const triggers = [];
            if (rsiTriggered) triggers.push(`RSI_OVERSOLD(${rsiRealtime.toFixed(1)}<${RSI_BUY})`);
            if (dropTriggered) triggers.push(`DROP24H(${drop24hPct.toFixed(1)}%>=${DROP_24H_BUY_PCT}%)`);
            const triggerStr = triggers.join('|');
            const slopeStr = slopeResult
              ? `EMA99_SLOPE=${slopeResult.slopePct.toFixed(3)}%`
              : `EMA99_SLOPE=N/A`;
            if (buyMode === 'NEW') {
              return { rsi: rsiRealtime, prevRsi, signal: 'BUY',
                       reason: `${triggerStr}+EMA99OK+${slopeStr}+${volCheck.reason}`,
                       volume: volumeInfo };
            } else {
              // 加仓
              return { rsi: rsiRealtime, prevRsi, signal: 'ADD_POSITION',
                       reason: `ADD_POS+${triggerStr}+EMA99OK+${slopeStr}+${volCheck.reason}`,
                       volume: volumeInfo };
            }
          }
          // 量能不达标，不标记 lastBuyCandle，下根K线继续检查
        }
      }
    }
  }

  updateState();
  return { rsi: rsiRealtime, prevRsi, signal: null, reason: isStale ? 'rsi_rebase' : '', volume: volumeInfo };
}

// ── K线聚合（V3：分离价格 tick 和链上交易 tick） ─────────────────
//
// tick 格式（两种来源共存于同一数组，用 source 字段区分）：
//
//   价格 tick（Birdeye WS/HTTP）:
//     { price: USD价格, ts, source: 'price' }
//     → 构成 OHLC
//
//   链上交易 tick（Helius WS）:
//     { price: 忽略(SOL计价), ts, solAmount, isBuy, source: 'chain' }
//     → 只贡献 volume / buyVolume / sellVolume
//     → 不参与 OHLC（单位不同！）
//

function buildCandles(ticks, intervalSec = KLINE_SEC) {
  if (!ticks || ticks.length === 0) return { closed: [], current: null };

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.ts / intervalMs) * intervalMs;

    const isChainTick = tick.source === 'chain';

    if (!current || current.openTime !== bucket) {
      // 新 K 线
      if (current) candles.push(current);

      if (isChainTick) {
        // 链上 tick 开始一根新K线，但没有价格数据
        // 创建空价格K线，等下一个价格 tick 填入
        current = {
          openTime:   bucket,
          closeTime:  bucket + intervalMs,
          open:       null,    // 等待价格 tick 填入
          high:       null,
          low:        null,
          close:      null,
          volume:     tick.solAmount || 0,
          buyVolume:  tick.isBuy  ? (tick.solAmount || 0) : 0,
          sellVolume: !tick.isBuy ? (tick.solAmount || 0) : 0,
          tickCount:  1,
          priceTickCount: 0,
        };
      } else {
        // 价格 tick 开始新K线
        current = {
          openTime:   bucket,
          closeTime:  bucket + intervalMs,
          open:       tick.price,
          high:       tick.price,
          low:        tick.price,
          close:      tick.price,
          volume:     0,          // volume 只来自链上交易
          buyVolume:  0,
          sellVolume: 0,
          tickCount:  1,
          priceTickCount: 1,
        };
      }
    } else {
      // 同一根 K 线内追加
      if (isChainTick) {
        // 链上 tick：只更新 volume
        current.volume     += (tick.solAmount || 0);
        current.buyVolume  += tick.isBuy  ? (tick.solAmount || 0) : 0;
        current.sellVolume += !tick.isBuy ? (tick.solAmount || 0) : 0;
        current.tickCount++;
      } else {
        // 价格 tick：更新 OHLC
        if (current.open === null) {
          // 这根K线之前只有链上 tick，现在才拿到价格
          current.open  = tick.price;
          current.high  = tick.price;
          current.low   = tick.price;
          current.close = tick.price;
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

/**
 * 过滤掉 open 为 null 的 K 线（只有链上 tick，没有价格数据的 K 线）
 * RSI 计算前调用
 */
function filterValidCandles(candles) {
  return candles.filter(c => c.open !== null && c.close !== null);
}

module.exports = {
  evaluateSignal,
  buildCandles,
  filterValidCandles,
  calcRSIWithState,
  stepRSI,
  checkBuyVolume,
  checkVolumeDecay,
  checkStopLoss,
  // ★ 导出 EMA 计算函数，供 monitor.js 在卖出轮询中检查斜率
  calcEMA,
  calcEMASlope,
  // ★ V5-22: 顶层导出 TRAILING_STOP_*, 修复 monitor.js 解构得到 undefined 的 bug
  //   原本只在 CONFIG 里, 导致启动日志显示 "激活线=+undefined% 移动止损=关闭"
  //   实际业务逻辑用 rsi.js 内部常量, 行为不受影响; 但日志会误导排查
  TRAILING_STOP_ENABLED, TRAILING_STOP_ACTIVATE, TRAILING_STOP_PCT,
  CONFIG: {
    RSI_PERIOD, RSI_BUY, RSI_SELL, RSI_PANIC,
    VOL_ENABLED, VOL_BUY_MULT, VOL_SELL_MULT, VOL_MIN_TOTAL, VOL_WINDOW_SEC,
    VOL_EXIT_CONSECUTIVE, VOL_EXIT_RATIO, VOL_EXIT_LOOKBACK,
    SKIP_FIRST_CANDLES,
    TAKE_PROFIT_PCT, STOP_LOSS_PCT, KLINE_SEC,
    TRAILING_STOP_ENABLED, TRAILING_STOP_ACTIVATE, TRAILING_STOP_PCT,
    EMA_PERIOD, MIN_CANDLES_FOR_SIGNAL,
    EMA_SLOPE_ENABLED, EMA_SLOPE_LOOKBACK, EMA_SLOPE_MIN_PCT,
    // ★ 改动: 24h 跌幅 + 加仓配置
    DROP_24H_BUY_ENABLED, DROP_24H_BUY_PCT,
    ADD_POSITION_ENABLED, ADD_POSITION_DROP_PCT, ADD_POSITION_MAX_TIMES,
  },
};

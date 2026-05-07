'use strict';
require('dotenv').config();

const http    = require('http');
const express = require('express');
const path    = require('path');

const logger    = require('./logger');
const monitor   = require('./monitor');
const reporter  = require('./reporter');
const wsHub     = require('./wsHub');
const dataStore = require('./dataStore');
const heliusWs  = require('./heliusWs');
const birdeye   = require('./birdeye');

const webhookRouter   = require('./routes/webhook');
const dashboardRouter = require('./routes/dashboard');

const PORT    = parseInt(process.env.PORT || '3001', 10);
const DRY_RUN = (process.env.DRY_RUN || 'false') === 'true';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── 路由 ──────────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);
app.use('/api',     dashboardRouter);

app.get('/api/reports', (_req, res) => res.json(reporter.listReports()));

app.get('/api/backtest/data', (_req, res) => {
  const files = dataStore.listTickFiles();
  const trades = dataStore.loadTrades();
  const signals = dataStore.loadSignals();
  res.json({
    tickFiles: files.map(f => ({ address: f.address, size: f.size })),
    tradeCount: trades.length,
    signalCount: signals.length,
  });
});

// Helius WS 状态 API
app.get('/api/helius-stats', (_req, res) => {
  res.json(heliusWs.getStats());
});

// Birdeye WS 状态 API
app.get('/api/birdeye-status', (_req, res) => {
  res.json({
    wsConnected: birdeye.priceStream.isConnected(),
  });
});

// ── 服务器 ────────────────────────────────────────────────────────
const server = http.createServer(app);
wsHub.init(server);

server.listen(PORT, () => {
  logger.info('🚀 SOL 量能突破 Monitor V7.1 (防陷阱) 启动，端口 %d', PORT);
  logger.info('   模式: %s', DRY_RUN ? '🔵 空跑(DRY_RUN)' : '🔴 实盘(LIVE)');
  logger.info('   K线=%ss  轮询=%ss  止损轮询=%ss',
    process.env.KLINE_INTERVAL_SEC || 60,
    process.env.PRICE_POLL_SEC     || 1,
    process.env.SL_POLL_SEC        || 30);
  logger.info('   买入条件 (AND): 量能爆发 ≥%sx | 买盘占比 ≥%s%% | 1min涨幅 ≥%s%% | 最低成交量 ≥%s SOL',
    process.env.VOL_SPIKE_MULT      || 5,
    process.env.BUY_DOMINANCE_PCT   || 65,
    process.env.PRICE_MOMENTUM_PCT  || 5,
    process.env.VOL_MIN_TOTAL       || 5);
  logger.info('   防陷阱过滤: L1实体/全长≥%s | L2上影/实体≤%s | L3跟根=%s | L4累涨≤%s%% | L5紧止损=%s%%/%ss',
    process.env.MIN_BODY_RATIO           || 0.5,
    process.env.MAX_UPPER_WICK_RATIO     || 1.0,
    (process.env.L3_FOLLOWUP_CONFIRM_ENABLED || 'true') === 'true' ? '开' : '关',
    process.env.MAX_PRECEDING_RUNUP_PCT  || 30,
    process.env.FAST_STOP_PCT            || -5,
    process.env.FAST_STOP_WINDOW_SEC     || 90);
  logger.info('   卖出条件: 移动止损 峰值-%s%% | 卖压反转 ≥%s%% | 量能衰竭 连续%s根 | 持仓超时 %ss',
    -1 * parseFloat(process.env.TRAILING_STOP_PCT || '-20'),
    process.env.SELL_DOMINANCE_PCT  || 60,
    process.env.VOL_FADE_CONSECUTIVE || 3,
    process.env.HOLD_TIMEOUT_SEC    || 1800);
  logger.info('   卖出冷却=%ss',
    process.env.SELL_COOLDOWN_SEC || '1800');

  // 连接信息
  const birdeyeKey = process.env.BIRDEYE_API_KEY || '';
  logger.info('   Birdeye: %s (B-05 WS 实时价格)',
    birdeyeKey ? '✅ API Key 已配置' : '⚠️ 未配置');

  const heliusLaser = process.env.HELIUS_LASERSTREAM_URL || '';
  const heliusGK    = process.env.HELIUS_GATEKEEPER_URL || '';
  const heliusWss   = process.env.HELIUS_WSS_URL || '';
  const heliusKey   = process.env.HELIUS_API_KEY || '';
  const heliusRpc   = process.env.HELIUS_RPC_URL || '';

  if (heliusGK) {
    logger.info('   Helius WS: ✅ Gatekeeper Beta WSS（最低延迟 WebSocket）');
  } else if (heliusWss) {
    logger.info('   Helius WS: ✅ Enhanced WebSocket');
  } else if (heliusKey || heliusRpc.includes('api-key=')) {
    logger.info('   Helius WS: ✅ 统一端点 WebSocket');
  } else {
    logger.info('   Helius WS: ⚠️ 未配置，量能数据不可用');
  }
  const subMode = process.env.HELIUS_SUB_MODE || 'token';
  logger.info('   Helius 订阅: %s', subMode === 'pump'
    ? '🟡 Pump AMM 单订阅（本地过滤）'
    : '🟢 按 Token 精准订阅（最省 credits）');

  if (heliusLaser) {
    logger.info('   Helius RPC: ✅ LaserStream gRPC（仅用于 sendTransaction 加速）');
  }
  if (heliusGK) {
    logger.info('   Helius RPC: ✅ Gatekeeper Beta（最低延迟发单）');
  } else if (heliusRpc) {
    logger.info('   Helius RPC: ✅ 标准 RPC');
  }

  if (!DRY_RUN) {
    logger.info('   Jupiter: Ultra API  %s  Key=%s',
      process.env.JUPITER_API_URL || 'https://api.jup.ag',
      process.env.JUPITER_API_KEY ? '已配置' : '⚠️ 未配置');
  } else {
    logger.info('   📁 数据目录: %s', process.env.DRY_RUN_DATA_DIR || './data');
  }

  logger.info('');
  logger.info('   ⚡ 止损路径:  BirdeyeWS(1s价格) → 本地判断 → 立即卖出 (目标<500ms)');
  logger.info('   📊 信号路径:  Birdeye OHLCV → 1分钟K线 → 量能突破信号引擎');
  logger.info('   📈 量能路径:  HeliusWS(链上交易) → buyVol/sellVol → 买卖方向判断');
  logger.info('');

  monitor.start();
  reporter.scheduleDaily(() => monitor.getAllTradeRecords());
});

// 优雅退出
process.on('SIGTERM', graceful);
process.on('SIGINT',  graceful);

async function graceful() {
  logger.info('[Main] 收到退出信号，清理...');

  // ★ V5: 先持久化当前状态（保留代币列表和RSI状态）
  // 如果有持仓，强制卖出但不移除代币
  const tokens = monitor.getTokens();
  for (const t of tokens) {
    if (t.inPosition) {
      logger.info('[Main] %s 持仓中，执行强制卖出...', t.symbol);
      try {
        await monitor.removeToken(t.address, 'SHUTDOWN');
      } catch (err) {
        logger.error('[Main] 强制卖出失败 %s: %s', t.symbol, err.message);
      }
    }
  }

  monitor.stop();  // 内部会调用 _persistTokens() 保存剩余代币
  process.exit(0);
}

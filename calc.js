/* ============================================================
 * calc.js — 基金买卖计算引擎（纯函数，无 DOM 依赖，可单测）
 * 公式定稿（用户确认版）：
 *   档位 X = ⌈|月度波动| ÷ 5⌉（无上限；正好5%→1X，10%→2X）
 *   比例 = 25% ÷ X
 *   可调波动 >0 → 卖出（乘可用份额）；<0 → 买入（乘可用金额）
 *   每次 1% 调整：调整量 = 比例 × 当前余量
 *   小数部分 ≥0.5 补一次 0.5% 调整：调整量 = (比例÷2) × 当前余量
 *   小数部分 <0.5 留给明天
 *   今日最终累计 = 昨日累计 + 今日实际波动 − 已执行调整消耗波动
 * ============================================================ */

'use strict';

// 保留 2 位小数（金额/份额/波动统一）
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// 档位 X：|月度波动| ÷ 5 向上取整，最小 1，无上限
function xFactor(monthlyVol) {
  if (monthlyVol === null || monthlyVol === undefined || isNaN(monthlyVol)) return 1;
  return Math.max(1, Math.ceil(Math.abs(monthlyVol) / 5));
}

// 比例（百分数数值）：1X→25, 2X→12.5, 3X→8.33…
function ratioPct(x) {
  return 25 / x;
}

// 按可调波动 D（百分数，可负）拆解调整计划
// 返回 { dir: 'buy'|'sell', adjustments: [{vol:1}, {vol:1}, {vol:0.5}] }
function planAdjustments(D) {
  const dir = D >= 0 ? 'sell' : 'buy';
  const absD = Math.abs(D);
  const n1 = Math.floor(absD);           // 整数个 1%
  const frac = round2(absD - n1);        // 小数部分
  const adjustments = [];
  for (let i = 0; i < n1; i++) adjustments.push({ vol: 1 });
  if (frac >= 0.5) adjustments.push({ vol: 0.5 });   // ≥0.5 补一次，比例减半
  return { dir, adjustments };
}

// 单次调整量：vol=1 → ratio% × 余量；vol=0.5 → (ratio/2)% × 余量
function adjustAmount(remainder, x, vol) {
  const pct = (vol === 0.5) ? ratioPct(x) / 2 : ratioPct(x);
  return round2(remainder * pct / 100);
}

// 执行计划：从初始余量开始逐次调整，余量递减
// 返回 { steps:[{idx, vol, dir, amount, remainderAfter}], remainderAfter, consumedVol }
function executePlan(remainder, x, plan) {
  const steps = [];
  let rem = remainder;
  let consumedVol = 0;
  plan.adjustments.forEach(function (a, i) {
    const amount = adjustAmount(rem, x, a.vol);
    rem = round2(rem - amount);
    consumedVol = round2(consumedVol + a.vol);
    steps.push({
      idx: i + 1,
      vol: a.vol,
      dir: plan.dir,
      amount: amount,
      remainderAfter: rem
    });
  });
  return { steps: steps, remainderAfter: rem, consumedVol: consumedVol };
}

// 今日最终累计 = 昨日累计 + 实际波动 − 已执行消耗波动
function finalCumulative(prevCumulative, actualVol, consumedVol) {
  return round2(prevCumulative + actualVol - consumedVol);
}

// 预估可调波动 = 昨日累计 + 当日预估波动
function estAdjustable(prevCumulative, estVol) {
  return round2(prevCumulative + estVol);
}

/* 导出（浏览器 + Node 双环境） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { round2, xFactor, ratioPct, planAdjustments, adjustAmount, executePlan, finalCumulative, estAdjustable };
}

/**
 * calc.js — 基金买卖计算引擎（纯函数，严格按用户确认公式实现）
 *
 * 公式定稿（2026-08-07 用户确认）：
 * 1. 档位 X = ceil(|月度波动| / 5)，无上限；正常比例 = 25 / X（百分数）
 *    - |波动|<=5% → 1X(25%)；<=10% → 2X(12.5%)；<=15% → 3X(8.33%)…
 * 2. 可调波动 = 昨日最终累计 + 当日预估波动；>0 卖出，<0 买入
 * 3. 调整拆分：整数部分 N → N 次 1% 调整（比例 25/X）；
 *    小数 >=0.5 → 补 1 次 0.5% 调整（比例减半 = 25/X/2）；<0.5 → 留明天
 * 4. 每次调整：量 = 波动量 × (比例/100) × 当前余量（卖出乘当前份额，买入乘当前金额）
 *    每次调整后余量更新，下一次基于新余量
 * 5. 每次调整消耗 |波动|=vol 的累计波动（向 0 收敛）
 * 6. 今日最终累计 = 昨日最终累计 + 今日实际波动 − 已执行调整消耗的波动
 * 7. 买入只减金额池，份额留空待用户后补；卖出按份额余量递减
 */

"use strict";

const CALC = (function () {

  // 保留 2 位小数（金额/份额用）
  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  // 档位 X：|月度波动| / 5 向上取整，最小 1
  function xFactor(monthlyVol) {
    const m = Math.abs(monthlyVol || 0);
    return Math.max(1, Math.ceil(m / 5));
  }

  // 正常调整比例（百分数值，如 25 / 12.5 / 8.33...）
  function baseRatio(monthlyVol) {
    return 25 / xFactor(monthlyVol);
  }

  /**
   * 把可调波动拆成调整序列
   * @param {number} adjVol 可调波动（带方向，正=卖出）
   * @param {number} monthlyVol 当日月度波动
   * @returns {{steps: Array<{vol:number, ratio:number}>, leftover: number}}
   *   steps: [{vol:1|0.5, ratio:25|12.5}...]，leftover: 未调整剩余波动（留明天）
   */
  function splitAdjustments(adjVol, monthlyVol) {
    const D = Math.abs(adjVol);
    const N = Math.floor(D);
    const frac = D - N;
    const steps = [];
    const br = baseRatio(monthlyVol);
    for (let i = 0; i < N; i++) {
      steps.push({ vol: 1, ratio: br });
    }
    let leftover = 0;
    if (frac >= 0.5) {
      steps.push({ vol: 0.5, ratio: br / 2 }); // 半次调整，比例减半
      leftover = frac - 0.5;
    } else {
      leftover = frac;
    }
    return { steps, leftover };
  }

  /**
   * 计算一整天的完整结果（预估阶段）
   * @param {object} p
   * @param {number} p.prevCumulative 昨日最终累计
   * @param {number} p.estVol 当日预估波动
   * @param {number} p.monthlyVol 当日月度波动
   * @param {number} p.cash 当日调前可用金额
   * @param {number} p.shares 当日调前可用份额
   * @returns {object} 完整计算结果
   */
  function computeDay(p) {
    const prevCumulative = Number(p.prevCumulative) || 0;
    const estVol = Number(p.estVol) || 0;
    const monthlyVol = Number(p.monthlyVol) || 0;
    const adjVol = round2(prevCumulative + estVol); // 可调波动
    const dir = adjVol > 0 ? 'sell' : (adjVol < 0 ? 'buy' : 'none');
    const { steps, leftover } = splitAdjustments(adjVol, monthlyVol);

    let cash = Number(p.cash) || 0;
    let shares = Number(p.shares) || 0;

    const adjustments = steps.map(function (s, i) {
      const base = (dir === 'sell') ? shares : cash;
      const qty = s.vol * (s.ratio / 100) * base;
      const amount = round2(qty);
      if (dir === 'sell') {
        shares = round2(shares - amount);
      } else if (dir === 'buy') {
        cash = round2(cash - amount);
      }
      // 消耗波动：卖出从正累计减，买入从负累计向 0 加
      const consumedSoFar = consumed(steps, i + 1);
      const cumAfter = (adjVol > 0) ? round2(adjVol - consumedSoFar) : round2(adjVol + consumedSoFar);
      return {
        idx: i + 1,
        vol: s.vol,
        ratio: round2(s.ratio),
        dir: dir,
        amount: amount,
        cashAfter: cash,
        sharesAfter: shares,
        cumAfter: cumAfter
      };
    });

    // 已执行调整消耗的波动（预估阶段 = 全部建议调整；实际执行后由用户确认）
    const consumedExec = consumed(steps, steps.length);

    return {
      x: xFactor(monthlyVol),
      baseRatio: round2(baseRatio(monthlyVol)),
      adjVol: adjVol,          // 可调波动（预估）
      dir: dir,
      adjustments: adjustments,
      leftover: round2(leftover), // 未调整剩余（留明天）
      cashAfter: cash,
      sharesAfter: shares,
      consumed: consumedExec,  // 预估消耗波动
      finalCumulative: round2(prevCumulative + estVol - consumedExec), // 若实际=预估
      xDetail: xFactor(monthlyVol) + 'X'
    };
  }

  function consumed(steps, n) {
    let t = 0;
    for (let i = 0; i < Math.min(n, steps.length); i++) t += steps[i].vol;
    return t;
  }

  /**
   * 交易后：根据实际执行计算今日最终累计
   * @param {number} prevCumulative 昨日最终累计
   * @param {number} actualVol 今日实际波动
   * @param {number} executedVol 今日实际执行的调整消耗波动（用户确认）
   * @returns {number} 今日最终累计（留到明天）
   */
  function finalCumulative(prevCumulative, actualVol, executedVol) {
    return round2((Number(prevCumulative) || 0) + (Number(actualVol) || 0) - (Number(executedVol) || 0));
  }

  return {
    round2: round2,
    xFactor: xFactor,
    baseRatio: baseRatio,
    splitAdjustments: splitAdjustments,
    computeDay: computeDay,
    finalCumulative: finalCumulative
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CALC;
}

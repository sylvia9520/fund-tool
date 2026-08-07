/**
 * test-integration.js — 联动重算集成测试
 * 模拟 app.js 的 recomputeChain 核心逻辑（无浏览器依赖）：
 * 基线 → 记录1 → 记录2 → 修改记录1 → 全链更新
 */
"use strict";
const CALC = require('./calc.js');

function round2(x) { return Math.round(x * 100) / 100; }
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 0.005;
  if (ok) { pass++; console.log('  ✓ ' + name + ' = ' + actual); }
  else { fail++; console.log('  ✗ ' + name + ' = ' + actual + ' (期望 ' + expected + ')'); }
}

// 复刻 app.js 的 recomputeChain
function recomputeChain(fund, records) {
  const recs = records.slice().sort(function (a, b) { return (a.date + '|' + (a.createdAt || '')) < (b.date + '|' + (b.createdAt || '')) ? -1 : 1; });
  let cash = fund.startCash, shares = fund.startShares, cum = fund.startCumulative;
  recs.forEach(function (r) {
    const monthlyVol = (r.monthlyVol === undefined || r.monthlyVol === '') ? fund.monthlyVol : Number(r.monthlyVol);
    const calc = CALC.computeDay({ prevCumulative: cum, estVol: Number(r.estVol), monthlyVol: monthlyVol, cash: cash, shares: shares });
    r.x = calc.x; r.dir = calc.dir;
    let c2 = cash, s2 = shares;
    (r.adjustments || []).forEach(function (a, i) {
      const sug = calc.adjustments[i] || { dir: calc.dir, amount: 0 };
      a.dir = sug.dir; a.vol = a.vol; a.ratio = a.ratio;
      // manual=true（用户手动改过）→ 用存值；否则跟随公式建议（前链变动时自动更新）
      const amt = (a.manual === true)
        ? ((a.amount === undefined || a.amount === null || a.amount === '') ? 0 : Number(a.amount))
        : sug.amount;
      a.amount = round2(amt);
      if (a.dir === 'sell') { s2 = round2(s2 - a.amount); a.sharesAfter = s2; a.cashAfter = c2; }
      else if (a.dir === 'buy') { c2 = round2(c2 - a.amount); a.cashAfter = c2; a.sharesAfter = s2; }
      else { a.cashAfter = c2; a.sharesAfter = s2; }
    });
    r.executedVol = (r.executedVol === undefined || r.executedVol === '') ? calc.consumed : Number(r.executedVol);
    const vol = (r.actualVol === undefined || r.actualVol === null || r.actualVol === '') ? Number(r.estVol) : Number(r.actualVol);
    r.finalCumulative = CALC.finalCumulative(cum, vol, r.executedVol);
    // 份额补录：覆盖递推份额，作为后续卖出基础
    if (r.sharesActual !== undefined && r.sharesActual !== null && String(r.sharesActual) !== '') {
      s2 = round2(Number(r.sharesActual));
      if (r.adjustments && r.adjustments.length) {
        r.adjustments[r.adjustments.length - 1].sharesAfter = s2;
      }
    }
    r.cashAfterAll = c2; r.sharesAfterAll = s2;
    cash = c2; shares = s2; cum = r.finalCumulative;
  });
  fund.cash = round2(cash); fund.shares = round2(shares); fund.lastCumulative = round2(cum);
}

console.log('== 联动测试: 基线→记录1→记录2==');
const fund = { id: 'f1', name: '沪深300', startCash: 10000, startShares: 0, startCumulative: 0, monthlyVol: 3, cash: 0, shares: 0, lastCumulative: 0 };
const records = [
  { id: 'r1', date: '2026-08-01', fundId: 'f1', estVol: -2.6, actualVol: null, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25, dir: '', amount: undefined }, { idx: 2, vol: 1, ratio: 25, dir: '', amount: undefined }, { idx: 3, vol: 0.5, ratio: 12.5, dir: '', amount: undefined }],
    executedVol: undefined, createdAt: '2026-08-01T09:00:00' },
  { id: 'r2', date: '2026-08-02', fundId: 'f1', estVol: -1, actualVol: null, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25, dir: '', amount: undefined }],
    executedVol: undefined, createdAt: '2026-08-02T09:00:00' }
];
recomputeChain(fund, records);
check('记录1 调整1 金额(2500)', records[0].adjustments[0].amount, 2500);
check('记录1 后剩余(5273.44)', records[0].cashAfterAll, 5273.44);
check('记录1 最终累计(0+(-2.6)-2.5=-5.1, 消耗2.5含半次0.5)', records[0].finalCumulative, -5.1);
check('记录2 调整1 金额(1%*25%*5273.44=1318.36)', records[1].adjustments[0].amount, 1318.36);
check('记录2 后剩余(3955.08)', records[1].cashAfterAll, 3955.08);
check('基金当前金额(3955.08)', fund.cash, 3955.08);
// 记录2: 昨日累计-5.1 + 预估-1 = 可调-6.1 → 6次调整 → 消耗6 → 最终 = -5.1+(-1)-6 = -12.1
check('基金当前累计(可调-6.1→6次→-12.1)', fund.lastCumulative, -12.1);

console.log('== 修改记录1 调整2 金额 1875→1500 (手动) → 全链联动 ==');
records[0].adjustments[1].amount = 1500;
records[0].adjustments[1].manual = true;
recomputeChain(fund, records);
check('记录1 调整3 金额不变(351.56)', records[0].adjustments[2].amount, 351.56);
check('记录1 后剩余(10000-2500-1500-351.56=5648.44)', records[0].cashAfterAll, 5648.44);
check('记录2 金额自动变(1%*25%*5648.44=1412.11)', records[1].adjustments[0].amount, 1412.11);
check('记录2 后剩余(4236.33)', records[1].cashAfterAll, 4236.33);
check('基金当前金额联动(4236.33)', fund.cash, 4236.33);

console.log('== 修改月度波动 → 档位变 → 金额联动 ==');
records[1].monthlyVol = 8; // 2X, 比例12.5
recomputeChain(fund, records);
check('记录2 档位2X', records[1].x, 2);
check('记录2 金额(1%*12.5%*5648.44=706.06)', records[1].adjustments[0].amount, 706.06);
check('记录2 后剩余(4942.38)', records[1].cashAfterAll, 4942.38);

console.log('== 录入实际波动 → 最终累计更新 ==');
records[0].actualVol = -2; // 实际只跌2%但执行了2.5消耗
recomputeChain(fund, records);
check('记录1 最终累计(0+(-2)-2.5=-4.5)', records[0].finalCumulative, -4.5);
check('记录2 从-4.5递推: 可调=-5.5', CALC.computeDay({ prevCumulative: -4.5, estVol: -1, monthlyVol: 8, cash: records[0].cashAfterAll, shares: 0 }).adjVol, -5.5);

console.log('== 份额补录: 买入行补实际份额 → 后续卖出按新份额算 ==');
const fund3 = { id: 'f3', name: '债基', startCash: 10000, startShares: 0, startCumulative: 0, monthlyVol: 3, cash: 0, shares: 0, lastCumulative: 0 };
const records3 = [
  { id: 's1', date: '2026-08-01', fundId: 'f3', estVol: -2.6, actualVol: 3, monthlyVol: 3, // 实际涨3%，消耗2.5 → 累计0.5
    adjustments: [{ idx: 1, vol: 1, ratio: 25 }, { idx: 2, vol: 1, ratio: 25 }, { idx: 3, vol: 0.5, ratio: 12.5 }],
    executedVol: 2.5, sharesActual: 800, createdAt: '2026-08-01T09:00:00' }, // 买入后补录实际份额 800
  { id: 's2', date: '2026-08-02', fundId: 'f3', estVol: 1, actualVol: null, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25 }, { idx: 2, vol: 0.5, ratio: 12.5 }],
    executedVol: undefined, createdAt: '2026-08-02T09:00:00' }
];
recomputeChain(fund3, records3);
check('记录1 份额补录生效(800)', records3[0].sharesAfterAll, 800);
check('记录1 累计(0+3-2.5=0.5)', records3[0].finalCumulative, 0.5);
check('记录2 可调(0.5+1=1.5)', CALC.computeDay({ prevCumulative: 0.5, estVol: 1, monthlyVol: 3, cash: 5273.44, shares: 800 }).adjVol, 1.5);
check('记录2 卖1(1%*25%*800=200)', records3[1].adjustments[0].amount, 200);
check('记录2 卖1 后份额(600)', records3[1].adjustments[0].sharesAfter, 600);
check('记录2 补调(0.5%*12.5%*600=37.5)', records3[1].adjustments[1].amount, 37.5);
check('记录2 后份额(562.5)', records3[1].sharesAfterAll, 562.5);
check('基金3 当前份额(562.5)', fund3.shares, 562.5);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail > 0) process.exit(1);

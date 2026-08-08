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
function checkStr(name, actual, expected) {
  if (String(actual) === String(expected)) { pass++; console.log('  ✓ ' + name + ' = ' + actual); }
  else { fail++; console.log('  ✗ ' + name + ' = ' + actual + ' (期望 ' + expected + ')'); }
}

// 复刻 app.js 的 recomputeChain
function recomputeChain(fund, records) {
  const recs = records.slice().sort(function (a, b) { return (a.date + '|' + (a.createdAt || '')) < (b.date + '|' + (b.createdAt || '')) ? -1 : 1; });
  let cash = fund.startCash, shares = fund.startShares, cum = fund.startCumulative;
  let sumBuy = 0, sumSell = 0;
  recs.forEach(function (r) {
    const monthlyVol = (r.monthlyVol === undefined || r.monthlyVol === '') ? fund.monthlyVol : Number(r.monthlyVol);
    const calc = CALC.computeDay({ prevCumulative: cum, estVol: Number(r.estVol), monthlyVol: monthlyVol, cash: cash, shares: shares });
    r.x = calc.x; r.dir = calc.dir;
    let c2 = cash, s2 = shares;
    // 同步调整序列数量（随预估实时增减）
    const sugAdj = calc.adjustments || [];
    if (!Array.isArray(r.adjustments)) r.adjustments = [];
    const existing = r.adjustments.slice();
    r.adjustments = [];
    for (let i = 0; i < sugAdj.length; i++) {
      const old = existing.find(function (a) { return a.idx === i + 1; });
      if (old) { old.dir = sugAdj[i].dir; old.vol = sugAdj[i].vol; old.ratio = sugAdj[i].ratio; r.adjustments.push(old); }
      else { r.adjustments.push({ idx: i + 1, vol: sugAdj[i].vol, ratio: sugAdj[i].ratio, dir: sugAdj[i].dir, amount: undefined }); }
    }
    (r.adjustments || []).forEach(function (a, i) {
      const sug = calc.adjustments[i] || { dir: calc.dir, amount: 0 };
      a.dir = sug.dir; a.vol = a.vol; a.ratio = a.ratio;
      // manual=true（用户手动改过）→ 用存值；否则跟随公式建议（前链变动时自动更新）
      const amt = (a.manual === true)
        ? ((a.amount === undefined || a.amount === null || a.amount === '') ? 0 : Number(a.amount))
        : sug.amount;
      a.amount = round2(amt);
      // 份额递推：调整后份额 = 调整前份额 + 买入份额 − 卖出份额
      if (a.dir === 'sell') { s2 = round2(s2 - a.amount); }
      else if (a.dir === 'buy') { c2 = round2(c2 - a.amount); }
      if (a.sharesActual !== undefined && a.sharesActual !== null && String(a.sharesActual) !== '') {
        if (a.dir === 'buy') s2 = round2(s2 + Number(a.sharesActual)); // 买入份额累加
      }
      a.sharesAfter = s2;
      a.cashAfter = c2;
    });
    r.executedVol = (r.executedVol === undefined || r.executedVol === '') ? calc.consumed : Number(r.executedVol);
    const vol = (r.actualVol === undefined || r.actualVol === null || r.actualVol === '') ? Number(r.estVol) : Number(r.actualVol);
    r.finalCumulative = CALC.finalCumulative(cum, vol, r.executedVol, r.dir);
    // 派生列
    const buySum = (r.adjustments || []).filter(function (a) { return a.dir === 'buy'; }).reduce(function (s, a) { return s + a.amount; }, 0);
    const sellSum = (r.adjustments || []).filter(function (a) { return a.dir === 'sell'; }).reduce(function (s, a) { return s + a.amount; }, 0);
    sumBuy += buySum; sumSell += sellSum;
    r.inPositionMoney = round2(sumBuy - sumSell);
    const pool = Number(fund.poolSize) || 0;
    r.inPositionRatio = pool ? round2((r.inPositionMoney / pool) * 100) : 0;
    r.health = round2(0.5 - (monthlyVol + Number(r.estVol)) * 10 / r.x);
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
check('记录1 最终累计(买入B: 0+(-2.6)+2.5=-0.1)', records[0].finalCumulative, -0.1);
check('记录2 调整1 金额(1%*25%*5273.44=1318.36)', records[1].adjustments[0].amount, 1318.36);
check('记录2 后剩余(3955.08)', records[1].cashAfterAll, 3955.08);
check('基金当前金额(3955.08)', fund.cash, 3955.08);
// 记录2: 昨日累计-0.1 + 预估-1 = 可调-1.1 → 1次调整(剩0.1) → 消耗1 → 最终 = -0.1+(-1)+1 = -0.1
check('基金当前累计(-0.1)', fund.lastCumulative, -0.1);

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
check('记录1 最终累计(买入B: 0+(-2)+2.5=0.5)', records[0].finalCumulative, 0.5);
check('记录2 从0.5递推: 可调=-0.5', CALC.computeDay({ prevCumulative: 0.5, estVol: -1, monthlyVol: 8, cash: records[0].cashAfterAll, shares: 0 }).adjVol, -0.5);

console.log('== 份额补录(调整级): 买入行补实际份额 → 后续卖出按新份额算 ==');
const fund3 = { id: 'f3', name: '债基', poolSize: 10000, startCash: 10000, startShares: 0, startCumulative: 0, monthlyVol: 3, cash: 0, shares: 0, lastCumulative: 0 };
const records3 = [
  { id: 's1', date: '2026-08-01', fundId: 'f3', estVol: -2.6, actualVol: -2, monthlyVol: 3, // 实际跌2%，消耗2.5 → 累计+0.5
    adjustments: [{ idx: 1, vol: 1, ratio: 25 }, { idx: 2, vol: 1, ratio: 25 }, { idx: 3, vol: 0.5, ratio: 12.5, sharesActual: 800 }],
    executedVol: 2.5, createdAt: '2026-08-01T09:00:00' }, // 调整3后补录实际份额 800
  { id: 's2', date: '2026-08-02', fundId: 'f3', estVol: 1, actualVol: null, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25 }, { idx: 2, vol: 0.5, ratio: 12.5 }],
    executedVol: undefined, createdAt: '2026-08-02T09:00:00' }
];
recomputeChain(fund3, records3);
check('记录1 调整3 份额补录生效(800)', records3[0].adjustments[2].sharesAfter, 800);
check('记录1 累计(买入B: 0+(-2)+2.5=0.5)', records3[0].finalCumulative, 0.5);
check('记录1 在仓钱款(2500+1875+351.56=4726.56)', records3[0].inPositionMoney, 4726.56);
check('记录1 在仓比例(4726.56/10000=47.27%)', records3[0].inPositionRatio, 47.27);
check('记录1 健康度(0.5-(3+(-2.6))*10/1=0.5-4=-3.5)', records3[0].health, -3.5);
check('记录2 可调(0.5+1=1.5)', CALC.computeDay({ prevCumulative: 0.5, estVol: 1, monthlyVol: 3, cash: 5273.44, shares: 800 }).adjVol, 1.5);
check('记录2 卖1(1%*25%*800=200)', records3[1].adjustments[0].amount, 200);
check('记录2 卖1 后份额(600)', records3[1].adjustments[0].sharesAfter, 600);
check('记录2 补调(0.5%*12.5%*600=37.5)', records3[1].adjustments[1].amount, 37.5);
check('记录2 后份额(562.5)', records3[1].sharesAfterAll, 562.5);
check('基金3 当前份额(562.5)', fund3.shares, 562.5);
check('记录2 在仓钱款(4726.56-200-37.5=4489.06)', records3[1].inPositionMoney, 4489.06);
check('记录2 在仓比例(44.89%)', records3[1].inPositionRatio, 44.89);
check('记录2 剩余资金(卖出不减现金=5273.44)', records3[1].cashAfterAll, 5273.44);
check('记录2 在仓份额(=调后份额562.5)', records3[1].sharesAfterAll, 562.5);

console.log('== 调整数量随预估实时增减 ==');
const fund4 = { id: 'f4', name: '弹性测试', poolSize: 10000, startCash: 10000, startShares: 0, startCumulative: 0, monthlyVol: 3, cash: 0, shares: 0, lastCumulative: 0 };
const records4 = [
  { id: 't1', date: '2026-08-01', fundId: 'f4', estVol: -1, actualVol: null, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25, dir: 'buy', amount: 2500 }],
    executedVol: 1, createdAt: '2026-08-01T09:00:00' }
];
recomputeChain(fund4, records4);
check('初始预估-1 → 1次调整', records4[0].adjustments.length, 1);
records4[0].estVol = -2.6; // 调大预估 → 调整数应增到 3
recomputeChain(fund4, records4);
check('预估-2.6 → 调整数增至3', records4[0].adjustments.length, 3);
check('新增调整3 金额(0.5%*12.5%*余量)', records4[0].adjustments[2].amount, 351.56);
records4[0].estVol = -0.4; // 调小 → 调整数减到 0
recomputeChain(fund4, records4);
check('预估-0.4 → 调整数减至0', records4[0].adjustments.length, 0);
records4[0].estVol = 2.6; // 反向卖出 → 3次卖出
recomputeChain(fund4, records4);
check('预估+2.6 → 3次且方向卖出', records4[0].adjustments.length, 3);
checkStr('方向=sell', records4[0].adjustments[0].dir, 'sell');

console.log('== 份额累加语义: 调整后份额 = 前份额 + 买入份额 − 卖出份额 ==');
const fund5 = { id: 'f5', name: '累加测试', poolSize: 10000, startCash: 10000, startShares: 100, startCumulative: 0, monthlyVol: 3, cash: 0, shares: 0, lastCumulative: 0 };
const records5 = [
  { id: 'u1', date: '2026-08-01', fundId: 'f5', estVol: -2.6, actualVol: -2, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25 }, { idx: 2, vol: 1, ratio: 25 }, { idx: 3, vol: 0.5, ratio: 12.5, sharesActual: 800 }],
    executedVol: 2.5, createdAt: '2026-08-01T09:00:00' }, // 调整3补录买入份额800
  { id: 'u2', date: '2026-08-02', fundId: 'f5', estVol: 1, actualVol: null, monthlyVol: 3,
    adjustments: [{ idx: 1, vol: 1, ratio: 25 }, { idx: 2, vol: 0.5, ratio: 12.5 }],
    executedVol: undefined, createdAt: '2026-08-02T09:00:00' }
];
recomputeChain(fund5, records5);
check('基线份额100 → 调整1/2 份额不变(100)', records5[0].adjustments[0].sharesAfter, 100);
check('调整3 份额 = 前100 + 买入800 = 900', records5[0].adjustments[2].sharesAfter, 900);
check('记录1 在仓份额(900)', records5[0].sharesAfterAll, 900);
// 记录2 卖出：可调 = 0.5 + 1 = 1.5 → 卖1 = 1%*25%*900 = 225；补调 = 0.5%*12.5%*675 = 42.19
check('卖1 份额(1%*25%*900=225)', records5[1].adjustments[0].amount, 225);
check('卖1 后份额(675)', records5[1].adjustments[0].sharesAfter, 675);
check('补调(0.5%*12.5%*675=42.19)', records5[1].adjustments[1].amount, 42.19);
check('记录2 在仓份额(632.81)', records5[1].sharesAfterAll, 632.81);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail > 0) process.exit(1);

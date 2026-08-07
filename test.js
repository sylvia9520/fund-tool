/**
 * test.js — 公式引擎单元测试（node 运行）
 * 用用户确认过的例子对账，全绿才算公式正确。
 */
"use strict";
const CALC = require('./calc.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 0.005; // 允许 0.005 舍入差
  if (ok) { pass++; console.log('  ✓ ' + name + ' = ' + actual); }
  else { fail++; console.log('  ✗ ' + name + ' = ' + actual + ' (期望 ' + expected + ')'); }
}
function checkStr(name, actual, expected) {
  if (String(actual) === String(expected)) { pass++; console.log('  ✓ ' + name + ' = ' + actual); }
  else { fail++; console.log('  ✗ ' + name + ' = ' + actual + ' (期望 ' + expected + ')'); }
}

console.log('== 测试1: 用户示例 X=1, 可调-2.6%(买入), 资金池10000 ==');
let r = CALC.computeDay({ prevCumulative: 0, estVol: -2.6, monthlyVol: 3, cash: 10000, shares: 0 });
checkStr('档位X', r.x, 1);
checkStr('方向(买入)', r.dir, 'buy');
check('调整次数', r.adjustments.length, 3);
check('调整1 金额(买2500)', r.adjustments[0].amount, 2500);
check('调整1 后剩余资金(7500)', r.adjustments[0].cashAfter, 7500);
check('调整2 金额(买1875)', r.adjustments[1].amount, 1875);
check('调整2 后剩余资金(5625)', r.adjustments[1].cashAfter, 5625);
check('调整3 金额(买351.56)', r.adjustments[2].amount, 351.56);
check('调整3 后剩余资金(5273.44)', r.adjustments[2].cashAfter, 5273.44);
check('调整3 比例减半(12.5)', r.adjustments[2].ratio, 12.5);
check('剩余未调波动(0.1留明天)', r.leftover, 0.1);

console.log('== 测试2: 用户例子 0%+2%预估, 实际+3% → 最终累计1% ==');
r = CALC.computeDay({ prevCumulative: 0, estVol: 2, monthlyVol: 3, cash: 10000, shares: 5000 });
checkStr('方向(卖出)', r.dir, 'sell');
check('卖出调整次数(2次)', r.adjustments.length, 2);
check('消耗波动(2)', r.consumed, 2);
// 交易后：昨日0 + 实际3 - 执行2 = 1（卖出）
check('今日最终累计(1留明天)', CALC.finalCumulative(0, 3, 2, 'sell'), 1);

console.log('== 测试3: 档位边界 ==');
checkStr('5%→1X', CALC.xFactor(5), 1);
checkStr('10%→2X', CALC.xFactor(10), 2);
checkStr('10.1%→3X', CALC.xFactor(10.1), 3);
checkStr('15%→3X', CALC.xFactor(15), 3);
checkStr('30%→6X', CALC.xFactor(30), 6);
checkStr('-6%→2X(负值取绝对值)', CALC.xFactor(-6), 2);
check('1X比例25', CALC.baseRatio(3), 25);
check('2X比例12.5', CALC.baseRatio(8), 12.5);
check('3X比例8.33', CALC.baseRatio(12), 25/3);

console.log('== 测试4: 0.5% 补调规则 ==');
r = CALC.computeDay({ prevCumulative: 0, estVol: 0.4, monthlyVol: 3, cash: 10000, shares: 0 });
check('0.4% 不补调整(0次)', r.adjustments.length, 0);
check('0.4% 留明天(0.4)', r.leftover, 0.4);
r = CALC.computeDay({ prevCumulative: 0, estVol: -0.5, monthlyVol: 3, cash: 10000, shares: 0 });
check('0.5% 补1次调整', r.adjustments.length, 1);
check('0.5% 调整量(0.5*12.5%*10000=625)', r.adjustments[0].amount, 625);
check('0.5% 比例减半(12.5)', r.adjustments[0].ratio, 12.5);
check('0.5% 剩余(0留明天)', r.leftover, 0);
r = CALC.computeDay({ prevCumulative: 0, estVol: -0.9, monthlyVol: 3, cash: 10000, shares: 0 });
check('0.9% 只补1次', r.adjustments.length, 1);
check('0.9% 剩余(0.4留明天)', r.leftover, 0.4);

console.log('== 测试5: 卖出按份额递减 ==');
r = CALC.computeDay({ prevCumulative: 0, estVol: 2.6, monthlyVol: 3, cash: 10000, shares: 10000 });
checkStr('方向(卖出)', r.dir, 'sell');
check('卖1 金额(1*25%*10000份=2500份)', r.adjustments[0].amount, 2500);
check('卖1 后份额(7500)', r.adjustments[0].sharesAfter, 7500);
check('卖2 金额(1875)', r.adjustments[1].amount, 1875);
check('卖3 金额(351.56)', r.adjustments[2].amount, 351.56);
check('卖3 后份额(5273.44)', r.adjustments[2].sharesAfter, 5273.44);
// 买入只耗金额，份额留空（买入测试里 shares=0 不变）
const rBuy = CALC.computeDay({ prevCumulative: 0, estVol: -2.6, monthlyVol: 3, cash: 10000, shares: 0 });
check('买入不改份额(仍为0)', rBuy.adjustments[2].sharesAfter, 0);

console.log('== 测试6: 买入累计消耗方向 ==');
r = CALC.computeDay({ prevCumulative: 0, estVol: -2, monthlyVol: 3, cash: 10000, shares: 0 });
checkStr('方向(买入)', r.dir, 'buy');
check('买入2次', r.adjustments.length, 2);
check('消耗波动(2)', r.consumed, 2);
// 方案B(用户确认): 买入 → 昨 + 实际 + 执行消耗（向0收敛）
check('买入案例最终累计(0 + -2 + 2 = 0)', CALC.finalCumulative(0, -2, 2, 'buy'), 0);
// 昨日累计 -1，实际 -2，执行3 → -1 + (-2) + 3 = 0
check('负累计案例(买入, 归0)', CALC.finalCumulative(-1, -2, 3, 'buy'), 0);

console.log('== 测试7: 累计波动的闭环（用户例子扩展） ==');
// 例: 昨日最终累计1%，今天预估+1%（做1次卖出），实际+0.5% → 今日最终 = 1 + 0.5 - 1 = 0.5
check('昨日1 实际0.5 执行1 → 0.5(卖出)', CALC.finalCumulative(1, 0.5, 1, 'sell'), 0.5);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail > 0) { process.exit(1); }

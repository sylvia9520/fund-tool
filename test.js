/* test.js — 公式引擎单元测试（Node 直接跑：node test.js） */
'use strict';
const calc = require('./calc.js');
const { round2, xFactor, ratioPct, planAdjustments, adjustAmount, executePlan, finalCumulative, estAdjustable } = calc;

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + '\n      got      ' + JSON.stringify(actual) + '\n      expected ' + JSON.stringify(expected)); }
}

console.log('== 档位 X ==');
eq('5% → 1X', xFactor(5), 1);
eq('9.9% → 2X', xFactor(9.9), 2);
eq('10% → 2X', xFactor(10), 2);
eq('10.1% → 3X', xFactor(10.1), 3);
eq('30% → 6X', xFactor(30), 6);
eq('负数 -4% → 1X', xFactor(-4), 1);
eq('-10% → 2X', xFactor(-10), 2);

console.log('== 比例 ==');
eq('1X → 25', ratioPct(1), 25);
eq('2X → 12.5', ratioPct(2), 12.5);
eq('3X → 25/3', round2(ratioPct(3)), 8.33);

console.log('== 调整计划拆分 ==');
eq('2 → [1,1]', planAdjustments(2).adjustments, [{vol:1},{vol:1}]);
eq('2.6 → [1,1,0.5]', planAdjustments(2.6).adjustments, [{vol:1},{vol:1},{vol:0.5}]);
eq('2.4 → [1,1] 小数<0.5 不补', planAdjustments(2.4).adjustments, [{vol:1},{vol:1}]);
eq('0.4 → []', planAdjustments(0.4).adjustments, []);
eq('0.5 → [0.5]', planAdjustments(0.5).adjustments, [{vol:0.5}]);
eq('3.0 → [1,1,1]', planAdjustments(3).adjustments, [{vol:1},{vol:1},{vol:1}]);
eq('正→卖出', planAdjustments(2).dir, 'sell');
eq('负→买入', planAdjustments(-2.6).dir, 'buy');

console.log('== 用户确认算法 A：X=1 资金池10000 可调2.6% 买入 ==');
{
  const plan = planAdjustments(-2.6);
  const r = executePlan(10000, 1, plan);
  eq('调整1 = 2500', r.steps[0].amount, 2500);
  eq('调整1后余 7500', r.steps[0].remainderAfter, 7500);
  eq('调整2 = 1875', r.steps[1].amount, 1875);
  eq('调整2后余 5625', r.steps[1].remainderAfter, 5625);
  eq('调整3(0.5%,比例减半) = 703.13', r.steps[2].amount, 703.13);
  eq('调整3后余 4921.87（按2位小数记账递减）', r.steps[2].remainderAfter, 4921.87);
  eq('消耗波动 2.5', r.consumedVol, 2.5);
}

console.log('== 卖出按份额：X=1 份额10000 可调+2.6% ==');
{
  const r = executePlan(10000, 1, planAdjustments(2.6));
  eq('调整1卖 2500 份', r.steps[0].amount, 2500);
  eq('调整3卖 703.13 份', r.steps[2].amount, 703.13);
  eq('剩余份额 4921.87（按2位小数记账递减）', r.remainderAfter, 4921.87);
}

console.log('== 2X 档位：12.5% × 余量 ==');
{
  const r = executePlan(10000, 2, planAdjustments(-1));
  eq('调整1 = 1250', r.steps[0].amount, 1250);
  eq('调整1后余 8750', r.steps[0].remainderAfter, 8750);
}

console.log('== 用户例子：昨日累计0%，预估+2%→做2次；实际+3% → 最终累计1% 留明天 ==');
{
  const est = estAdjustable(0, 2);      // 0 + 2 = 2
  eq('预估可调 2%', est, 2);
  const plan = planAdjustments(est);    // 2 次卖出
  eq('计划 2 次调整', plan.adjustments.length, 2);
  const r = executePlan(10000, 1, plan);
  const final = finalCumulative(0, 3, r.consumedVol);   // 0 + 3 − 2
  eq('实际+3%，消耗2% → 最终累计 1%', final, 1);
}

console.log('== 预估 vs 实际偏差的例子（前例延伸：预估2.6做2次+1次0.5，实际3%）==');
{
  const r = executePlan(10000, 1, planAdjustments(2.6));
  const final = finalCumulative(0, 3, r.consumedVol);   // 0 + 3 − 2.5
  eq('消耗2.5，实际3% → 最终累计 0.5%', final, 0.5);
}

console.log('== 四舍五入 ==');
eq('round2(703.125) = 703.13', round2(703.125), 703.13);
eq('round2(4921.875) = 4921.88', round2(4921.875), 4921.88);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail > 0 ? 1 : 0);

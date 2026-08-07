/**
 * app.js — 主逻辑
 * 三页：今日操作 / 历史总表（可编辑+公式联动）/ 基金设置
 * 联动规则：所有派生值（剩余资金/份额/累计）不落库，渲染时按公式链实时计算；
 * 编辑任何输入字段（预估/实际/月度波动、金额、执行消耗）→ 全链重算 + 留痕。
 */
"use strict";

const App = (function () {
  let funds = [];
  let records = [];
  let audits = [];
  let curFundId = null;
  let curTab = 'today';

  // ---------- 工具 ----------
  function round2(x) { return Math.round(x * 100) / 100; }
  function todayStr() {
    const d = new Date();
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d)) return s;
    const p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function getFund(id) { return funds.find(function (f) { return f.id === id; }); }
  function sortRecords(arr) {
    return arr.slice().sort(function (a, b) {
      const ka = a.date + '|' + (a.createdAt || '');
      const kb = b.date + '|' + (b.createdAt || '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  // ---------- 联动重算（核心） ----------
  // 对单个基金：从基线开始，逐条记录递推，得到每行派生值与基金当前值
  function recomputeChain(fundId) {
    const fund = getFund(fundId);
    if (!fund) return;
    const recs = sortRecords(records.filter(function (r) { return r.fundId === fundId; }));
    let cash = Number(fund.startCash) || 0;
    let shares = Number(fund.startShares) || 0;
    let cum = Number(fund.startCumulative) || 0;
    recs.forEach(function (r) {
      const estVol = Number(r.estVol) || 0;
      const monthlyVol = r.monthlyVol === undefined || r.monthlyVol === null || r.monthlyVol === '' ? (Number(fund.monthlyVol) || 0) : Number(r.monthlyVol);
      const calc = CALC.computeDay({ prevCumulative: cum, estVol: estVol, monthlyVol: monthlyVol, cash: cash, shares: shares });
      r.x = calc.x;
      r.dir = calc.dir;
      let c2 = cash, s2 = shares;
      if (r.adjustments && r.adjustments.length) {
        r.adjustments.forEach(function (a, i) {
          const sug = calc.adjustments[i] || { dir: calc.dir, amount: 0, vol: a.vol, ratio: a.ratio };
          a.dir = sug.dir;
          a.vol = a.vol !== undefined ? Number(a.vol) : (sug.vol || 1);
          a.ratio = a.ratio !== undefined ? Number(a.ratio) : (sug.ratio || 25);
          // manual=true（用户手动改过）→ 用存值；否则跟随公式建议（前链变动时自动更新）
          const amt = (a.manual === true)
            ? ((a.amount === undefined || a.amount === null || a.amount === '') ? 0 : Number(a.amount))
            : sug.amount;
          a.amount = round2(amt);
          if (a.dir === 'sell') { s2 = round2(s2 - a.amount); a.sharesAfter = s2; a.cashAfter = c2; }
          else if (a.dir === 'buy') { c2 = round2(c2 - a.amount); a.cashAfter = c2; a.sharesAfter = s2; }
          else { a.cashAfter = c2; a.sharesAfter = s2; }
        });
      } else {
        // 无调整（0次）也记录派生
        r.adjustments = [];
      }
      r.executedVol = (r.executedVol === undefined || r.executedVol === null || r.executedVol === '') ? calc.consumed : Number(r.executedVol);
      const vol = (r.actualVol === undefined || r.actualVol === null || r.actualVol === '') ? estVol : Number(r.actualVol);
      r.finalCumulative = CALC.finalCumulative(cum, vol, r.executedVol);
      r.cashAfterAll = c2;
      r.sharesAfterAll = s2;
      r.calcInfo = calc; // 供展示（leftover 等）
      cash = c2; shares = s2; cum = r.finalCumulative;
    });
    fund.cash = round2(cash);
    fund.shares = round2(shares);
    fund.lastCumulative = round2(cum);
  }

  function recomputeAll() {
    funds.forEach(function (f) { recomputeChain(f.id); });
  }

  // ---------- 持久化 + 留痕 ----------
  function persistFund(fund) { return DB.put('funds', fund); }
  function persistRecord(rec) { return DB.put('records', rec); }

  function addAudit(fundId, recordId, field, oldVal, newVal, desc) {
    return DB.audit(fundId, recordId, field, oldVal, newVal, desc);
  }

  // 修改记录字段：更新 + 留痕 + 重算 + 保存（统一入口）
  function updateRecordField(rec, field, value, desc) {
    const oldVal = rec[field];
    const same = String(oldVal) === String(value);
    rec[field] = value;
    rec.updatedAt = new Date().toISOString();
    return persistRecord(rec).then(function () {
      if (!same) { return addAudit(rec.fundId, rec.id, field, oldVal, value, desc || ''); }
    }).then(function () {
      recomputeChain(rec.fundId);
      return persistFund(getFund(rec.fundId));
    });
  }

  // ---------- 渲染：导航 ----------
  function switchTab(tab) {
    curTab = tab;
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.querySelectorAll('.page').forEach(function (p) { p.style.display = 'none'; });
    document.getElementById('page-' + tab).style.display = 'block';
    renderCurrent();
  }

  function renderCurrent() {
    if (curTab === 'today') renderToday();
    else if (curTab === 'history') renderHistory();
    else renderSettings();
  }

  function renderFundSelect() {
    const sel = document.getElementById('fundSelect');
    sel.innerHTML = funds.map(function (f) {
      return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>';
    }).join('');
    if (funds.length) {
      if (!curFundId || !getFund(curFundId)) curFundId = funds[0].id;
      sel.value = curFundId;
    }
  }

  // ---------- 今日操作页 ----------
  function renderToday() {
    renderFundSelect();
    const box = document.getElementById('todayBox');
    if (!funds.length) {
      box.innerHTML = '<p style="color:#888">还没有基金，请先到「基金设置」添加。</p>';
      document.getElementById('todayResult').innerHTML = '';
      return;
    }
    const fund = getFund(curFundId);
    const recs = sortRecords(records.filter(function (r) { return r.fundId === curFundId; }));
    const last = recs[recs.length - 1];
    box.innerHTML =
      '<div class="card">' +
      '  <div class="last-op">上次操作：' +
      (last ? ('<b>' + fmtDate(last.date) + '</b> 后 — 剩余资金 <b>' + round2(last.cashAfterAll) + '</b>，剩余份额 <b>' + round2(last.sharesAfterAll) + '</b>，最终累计 <b>' + last.finalCumulative + '%</b>') : '（暂无历史，从基线开始）') +
      '</div>' +
      '  <div class="row"><label>今日预估波动 %</label><input id="inEst" type="number" step="0.1" placeholder="如 2.5 或 -1.2"></div>' +
      '  <div class="row"><label>月度波动 %</label><input id="inMonthly" type="number" step="0.1" value="' + esc(fund.monthlyVol) + '"></div>' +
      '  <div class="row"><label>调前可用金额</label><span id="lblCash">' + round2(fund.cash) + '</span></div>' +
      '  <div class="row"><label>调前可用份额</label><span id="lblShares">' + round2(fund.shares) + '</span></div>' +
      '  <div class="row"><label>当前累计波动</label><span id="lblCum">' + fund.lastCumulative + '%</span></div>' +
      '  <button class="btn primary" onclick="App.calcToday()">计算</button>' +
      '</div>';
    document.getElementById('todayResult').innerHTML = '';
    // 基金切换时重渲染
  }

  // 计算建议（不落库，展示 + 可编辑金额）
  function calcToday() {
    const fund = getFund(curFundId);
    if (!fund) return;
    const estVol = parseFloat(document.getElementById('inEst').value);
    const monthlyVol = parseFloat(document.getElementById('inMonthly').value);
    if (isNaN(estVol)) { alert('请填写预估波动'); return; }
    const calc = CALC.computeDay({
      prevCumulative: Number(fund.lastCumulative) || 0,
      estVol: estVol,
      monthlyVol: isNaN(monthlyVol) ? 0 : monthlyVol,
      cash: Number(fund.cash) || 0,
      shares: Number(fund.shares) || 0
    });
    const dirName = calc.dir === 'sell' ? '卖出' : (calc.dir === 'buy' ? '买入' : '不动');
    let html =
      '<div class="card">' +
      '  <div class="result-head">预估波动 ' + estVol + '% + 累计 ' + fund.lastCumulative + '% → <b>可调波动 ' + calc.adjVol + '%</b>（' + dirName + '，档位 ' + calc.x + 'X，比例 ' + calc.baseRatio + '%）</div>';
    if (!calc.adjustments.length) {
      html += '<div class="no-adj">无需调整（剩余 ' + calc.leftover + '% 留明天）</div>';
    } else {
      html += '<table class="mini"><tr><th>调整</th><th>调波%</th><th>比例%</th><th>金额/份</th><th>剩余资金</th><th>剩余份额</th></tr>';
      calc.adjustments.forEach(function (a) {
        const cashAfter = a.dir === 'sell' ? round2(Number(fund.cash) - a.amount) : a.cashAfter;
        html += '<tr><td>调整' + a.idx + '</td><td>' + a.vol + '</td><td>' + a.ratio + '</td>' +
          '<td><input class="amt-in" data-idx="' + a.idx + '" type="number" step="0.01" value="' + a.amount + '"></td>' +
          '<td>' + a.cashAfter + '</td><td>' + a.sharesAfter + '</td></tr>';
      });
      html += '</table>';
      html += '<div class="hint">剩 ' + calc.leftover + '% 未调（留明天）。金额可直接修改，确认后按修改值执行。</div>';
    }
    html += '<button class="btn primary" onclick="App.confirmToday(' + estVol + ', ' + (isNaN(monthlyVol) ? 'null' : monthlyVol) + ')">确认并留档</button>';
    html += '</div>';
    document.getElementById('todayResult').innerHTML = html;
  }

  // 确认今日操作 → 建记录 + 重算 + 留痕
  function confirmToday(estVol, monthlyVol) {
    const fund = getFund(curFundId);
    if (!fund) return;
    const inputs = document.querySelectorAll('.amt-in');
    const adjustments = [];
    inputs.forEach(function (inp) {
      const idx = parseInt(inp.dataset.idx, 10);
      adjustments.push({ idx: idx, vol: 1, ratio: 25, dir: '', amount: parseFloat(inp.value) || 0 });
    });
    const calc = CALC.computeDay({
      prevCumulative: Number(fund.lastCumulative) || 0,
      estVol: estVol,
      monthlyVol: monthlyVol === null ? 0 : monthlyVol,
      cash: Number(fund.cash) || 0,
      shares: Number(fund.shares) || 0
    });
    // 用建议的结构，但金额用用户改后的
    const finalAdj = (calc.adjustments || []).map(function (a, i) {
      const edited = adjustments[i];
      return {
        idx: i + 1,
        vol: a.vol,
        ratio: a.ratio,
        dir: a.dir,
        amount: edited ? edited.amount : a.amount
      };
    });
    const rec = {
      id: DB.genId(),
      date: todayStr(),
      fundId: fund.id,
      estVol: estVol,
      monthlyVol: monthlyVol === null ? (Number(fund.monthlyVol) || 0) : monthlyVol,
      actualVol: null,
      x: calc.x,
      dir: calc.dir,
      adjustments: finalAdj,
      executedVol: calc.consumed,
      finalCumulative: null,
      note: '',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    DB.put('records', rec).then(function () {
      return addAudit(fund.id, rec.id, '新建记录', '', estVol + '%', '预估' + estVol + '% / 月度' + rec.monthlyVol + '%');
    }).then(function () {
      recomputeChain(fund.id);
      return persistFund(fund);
    }).then(function () {
      renderToday();
      document.getElementById('todayResult').innerHTML =
        '<div class="card ok">已留档。' +
        '<div class="row"><label>今日实际波动 %</label><input id="inActual" type="number" step="0.1" placeholder="交易后填写"></div>' +
        '<button class="btn" onclick="App.setActual(\'' + rec.id + '\')">记录实际波动 → 算最终累计</button>' +
        '<button class="btn" onclick="App.renderToday()">稍后再说</button></div>';
    });
  }

  // 交易后录入实际波动
  function setActual(recId) {
    const rec = records.find(function (r) { return r.id === recId; });
    if (!rec) return;
    const v = document.getElementById('inActual');
    const actual = parseFloat(v.value);
    if (isNaN(actual)) { alert('请填写实际波动'); return; }
    updateRecordField(rec, 'actualVol', actual, '录入实际波动').then(function () {
      renderToday();
      const fund = getFund(rec.fundId);
      document.getElementById('todayResult').innerHTML =
        '<div class="card ok">实际波动 ' + actual + '% 已记录 → 今日最终累计 <b>' + rec.finalCumulative + '%</b>（留到明天）' +
        '<br><span style="color:#888">（若当天少做/多做了调整，请到「历史总表」修改该行的执行消耗）</span></div>';
    });
  }

  // ---------- 历史总表页 ----------
  function renderHistory() {
    const cont = document.getElementById('historyBox');
    if (!records.length) {
      cont.innerHTML = '<p style="color:#888">暂无记录。先在「今日操作」里算一笔。</p>';
      document.getElementById('auditBox').innerHTML = '';
      return;
    }
    recomputeAll();
    const fundFilter = document.getElementById('histFundFilter');
    const kw = (fundFilter.value || '').trim().toLowerCase();

    const recs = sortRecords(records.filter(function (r) {
      if (!kw) return true;
      const f = getFund(r.fundId);
      return (f && f.name.toLowerCase().indexOf(kw) !== -1);
    }));

    let html = '<table class="grid"><thead><tr>' +
      '<th>日期</th><th>基金</th><th>预估%</th><th>实际%</th><th>月度%</th><th>档位</th><th>方向</th>' +
      '<th>调整明细</th><th>执行消耗%</th><th>最终累计%</th><th>操作</th></tr></thead><tbody>';
    recs.forEach(function (r) {
      const f = getFund(r.fundId);
      const dirName = r.dir === 'sell' ? '卖' : (r.dir === 'buy' ? '买' : '—');
      const adjHtml = (r.adjustments || []).map(function (a) {
        return '<div class="adj-row"><b>调整' + a.idx + '</b> ' + (a.dir === 'sell' ? '卖' : (a.dir === 'buy' ? '买' : '')) +
          ' ' + a.vol + '%×' + a.ratio + '% = <input class="cell-amt" data-rec="' + esc(r.id) + '" data-idx="' + a.idx + '" type="number" step="0.01" value="' + a.amount + '">' +
          '<span class="after">剩资' + (a.cashAfter === undefined ? '' : a.cashAfter) + ' / 份' + (a.sharesAfter === undefined ? '' : a.sharesAfter) + '</span></div>';
      }).join('') || '<span style="color:#999">无调整</span>';
      html += '<tr>' +
        '<td>' + fmtDate(r.date) + '</td>' +
        '<td>' + esc(f ? f.name : r.fundId) + '</td>' +
        '<td><input class="cell-est" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + esc(r.estVol) + '"></td>' +
        '<td><input class="cell-actual" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + (r.actualVol === null || r.actualVol === undefined ? '' : r.actualVol) + '" placeholder="未录"></td>' +
        '<td><input class="cell-monthly" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + esc(r.monthlyVol) + '"></td>' +
        '<td>' + (r.x || '') + 'X</td>' +
        '<td>' + dirName + '</td>' +
        '<td>' + adjHtml + '</td>' +
        '<td><input class="cell-exec" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + esc(r.executedVol) + '"></td>' +
        '<td><b>' + r.finalCumulative + '%</b></td>' +
        '<td><button class="btn small danger" onclick="App.delRecord(\'' + esc(r.id) + '\')">删</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    cont.innerHTML = html;

    // 留痕区
    renderAudit();
  }

  function renderAudit() {
    const box = document.getElementById('auditBox');
    const sorted = audits.slice().sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 60);
    box.innerHTML = '<h3>留痕记录（最近 60 条）</h3>' +
      (sorted.length ? '<table class="grid small-grid"><tr><th>时间</th><th>基金</th><th>字段</th><th>改前</th><th>改后</th><th>说明</th></tr>' +
        sorted.map(function (a) {
          const f = getFund(a.fundId);
          return '<tr><td>' + esc(fmtDate(a.time) + ' ' + (a.time || '').slice(11, 16)) + '</td><td>' + esc(f ? f.name : '') + '</td><td>' + esc(a.field) + '</td><td>' + esc(a.oldVal) + '</td><td>' + esc(a.newVal) + '</td><td>' + esc(a.desc) + '</td></tr>';
        }).join('') + '</table>' : '<p style="color:#888">暂无留痕</p>');
  }

  // 编辑联动：表格输入变化
  function bindHistoryEvents() {
    document.getElementById('historyBox').addEventListener('change', function (e) {
      const t = e.target;
      const recId = t.dataset.rec;
      if (!recId) return;
      const rec = records.find(function (r) { return r.id === recId; });
      if (!rec) return;
      const v = t.value === '' ? '' : parseFloat(t.value);
      if (t.classList.contains('cell-est')) {
        updateRecordField(rec, 'estVol', v, '修改预估波动').then(renderHistory);
      } else if (t.classList.contains('cell-actual')) {
        updateRecordField(rec, 'actualVol', v, '修改实际波动').then(renderHistory);
      } else if (t.classList.contains('cell-monthly')) {
        updateRecordField(rec, 'monthlyVol', v, '修改月度波动').then(renderHistory);
      } else if (t.classList.contains('cell-exec')) {
        updateRecordField(rec, 'executedVol', v, '修改执行消耗').then(renderHistory);
      } else if (t.classList.contains('cell-amt')) {
        const idx = parseInt(t.dataset.idx, 10);
        const adj = rec.adjustments.find(function (a) { return a.idx === idx; });
        if (adj) {
          const oldAmt = adj.amount;
          adj.amount = v === '' ? 0 : v;
          adj.manual = true; // 手动改过 → 后续重算保留此值
          updateRecordField(rec, 'adjustments', rec.adjustments, '调整' + idx + ' 金额 ' + oldAmt + '→' + adj.amount).then(renderHistory);
        }
      }
    });
  }

  function delRecord(recId) {
    const rec = records.find(function (r) { return r.id === recId; });
    if (!rec) return;
    if (!confirm('确定删除 ' + fmtDate(rec.date) + ' 这条记录？')) return;
    DB.remove('records', recId).then(function () {
      return addAudit(rec.fundId, recId, '删除记录', '', '', '删除 ' + fmtDate(rec.date) + ' 记录');
    }).then(function () {
      records = records.filter(function (r) { return r.id !== recId; });
      recomputeChain(rec.fundId);
      return persistFund(getFund(rec.fundId));
    }).then(renderHistory);
  }

  // ---------- 基金设置页 ----------
  function renderSettings() {
    const box = document.getElementById('settingsBox');
    box.innerHTML = '<div class="card">' +
      '<h3>新增基金</h3>' +
      '<div class="row"><label>名称</label><input id="newName" placeholder="如 沪深300"></div>' +
      '<div class="row"><label>基线金额（初始资金池）</label><input id="newCash" type="number" step="0.01" placeholder="10000"></div>' +
      '<div class="row"><label>基线份额</label><input id="newShares" type="number" step="0.01" value="0"></div>' +
      '<div class="row"><label>基线累计波动 %</label><input id="newCum" type="number" step="0.1" value="0"></div>' +
      '<div class="row"><label>默认月度波动 %</label><input id="newMonthly" type="number" step="0.1" value="3"></div>' +
      '<button class="btn primary" onclick="App.addFund()">添加</button></div>';

    if (funds.length) {
      box.innerHTML += '<h3>基金列表（基线 = 历史递推起点；当前值 = 自动计算）</h3><table class="grid">' +
        '<tr><th>名称</th><th>基线金额</th><th>基线份额</th><th>基线累计%</th><th>月度%</th><th>当前金额</th><th>当前份额</th><th>当前累计%</th><th>操作</th></tr>' +
        funds.map(function (f) {
          return '<tr>' +
            '<td>' + esc(f.name) + '</td>' +
            '<td><input class="sf-startcash" data-fid="' + esc(f.id) + '" type="number" step="0.01" value="' + esc(f.startCash) + '"></td>' +
            '<td><input class="sf-startshares" data-fid="' + esc(f.id) + '" type="number" step="0.01" value="' + esc(f.startShares) + '"></td>' +
            '<td><input class="sf-startcum" data-fid="' + esc(f.id) + '" type="number" step="0.1" value="' + esc(f.startCumulative) + '"></td>' +
            '<td><input class="sf-monthly" data-fid="' + esc(f.id) + '" type="number" step="0.1" value="' + esc(f.monthlyVol) + '"></td>' +
            '<td>' + round2(f.cash) + '</td><td>' + round2(f.shares) + '</td><td>' + f.lastCumulative + '%</td>' +
            '<td><button class="btn small" onclick="App.goToday(\'' + esc(f.id) + '\')">去操作</button> <button class="btn small danger" onclick="App.delFund(\'' + esc(f.id) + '\')">删</button></td></tr>';
        }).join('') + '</table>';
    } else {
      box.innerHTML += '<p style="color:#888">暂无基金</p>';
    }
  }

  function bindSettingsEvents() {
    document.getElementById('settingsBox').addEventListener('change', function (e) {
      const t = e.target;
      const fid = t.dataset.fid;
      if (!fid) return;
      const fund = getFund(fid);
      if (!fund) return;
      const v = t.value === '' ? '' : parseFloat(t.value);
      const fieldMap = { 'sf-startcash': 'startCash', 'sf-startshares': 'startShares', 'sf-startcum': 'startCumulative', 'sf-monthly': 'monthlyVol' };
      const field = fieldMap[t.className.split(' ').find(function (c) { return fieldMap[c]; })];
      if (!field) return;
      const oldVal = fund[field];
      fund[field] = v;
      persistFund(fund).then(function () {
        return addAudit(fund.id, '', field, oldVal, v, '基金设置修改');
      }).then(function () {
        recomputeChain(fund.id);
        return persistFund(fund);
      }).then(renderSettings);
    });
  }

  function addFund() {
    const name = document.getElementById('newName').value.trim();
    if (!name) { alert('请填名称'); return; }
    const fund = {
      id: DB.genId(),
      name: name,
      startCash: parseFloat(document.getElementById('newCash').value) || 0,
      startShares: parseFloat(document.getElementById('newShares').value) || 0,
      startCumulative: parseFloat(document.getElementById('newCum').value) || 0,
      monthlyVol: parseFloat(document.getElementById('newMonthly').value) || 3,
      cash: 0, shares: 0, lastCumulative: 0
    };
    fund.cash = fund.startCash; fund.shares = fund.startShares; fund.lastCumulative = fund.startCumulative;
    DB.put('funds', fund).then(function () {
      return addAudit(fund.id, '', '新建基金', '', name, '添加基金 ' + name);
    }).then(function () {
      funds.push(fund);
      curFundId = fund.id;
      renderSettings();
    }).catch(function (err) {
      alert('添加失败：' + err.message);
    });
  }

  function delFund(fid) {
    const fund = getFund(fid);
    if (!fund) return;
    if (!confirm('删除基金「' + fund.name + '」？其全部历史记录也会被删除。')) return;
    const recs = records.filter(function (r) { return r.fundId === fid; });
    Promise.all(recs.map(function (r) { return DB.remove('records', r.id); })).then(function () {
      return DB.remove('funds', fid);
    }).then(function () {
      return addAudit(fid, '', '删除基金', '', '', '删除基金 ' + fund.name + '（含 ' + recs.length + ' 条记录）');
    }).then(function () {
      funds = funds.filter(function (f) { return f.id !== fid; });
      records = records.filter(function (r) { return r.fundId !== fid; });
      if (curFundId === fid) curFundId = funds.length ? funds[0].id : null;
      renderSettings();
    });
  }

  function goToday(fid) { curFundId = fid; switchTab('today'); }

  // ---------- 导出 / 导入 ----------
  function doExportExcel() {
    recomputeAll();
    const fn = EXPORT.exportExcel(funds, records, audits);
    alert('已导出 ' + fn + '，可存到 OneDrive。');
  }
  function doExportBackup() {
    recomputeAll();
    EXPORT.exportBackup(funds, records, audits);
  }
  function doImportFile(file) {
    if (!file) return;
    EXPORT.parseBackup(file).then(function (data) {
      if (data.funds && data.funds.length) {
        // JSON 全量备份
        return DB.clear('funds').then(function () { return DB.clear('records'); }).then(function () { return DB.clear('audit'); }).then(function () {
          return Promise.all(data.funds.map(function (f) { return DB.put('funds', f); }))
            .then(function () { return Promise.all((data.records || []).map(function (r) { return DB.put('records', r); })); })
            .then(function () { return Promise.all((data.audits || []).map(function (a) { return DB.put('audit', a); })); });
        }).then(function () {
          alert('导入成功：基金 ' + data.funds.length + '，记录 ' + (data.records || []).length + '。页面将刷新。');
          location.reload();
        });
      } else {
        alert('Excel 明细导入仅支持 JSON 全量备份的完整恢复；Excel 请用于查看/对账。');
      }
    }).catch(function (err) { alert('导入失败：' + err.message); });
  }

  // ---------- 初始化 ----------
  function init() {
    DB.open().then(function () {
      return DB.getAll('funds');
    }).then(function (fs) {
      funds = fs || [];
      return DB.getAll('records');
    }).then(function (rs) {
      records = rs || [];
      return DB.getAll('audit');
    }).then(function (as) {
      audits = as || [];
      recomputeAll();
      // 持久化递推后的当前值（保持数据一致）
      return Promise.all(funds.map(function (f) { return persistFund(f); }));
    }).then(function () {
      bindHistoryEvents();
      bindSettingsEvents();
      document.getElementById('fundSelect').addEventListener('change', function (e) {
        curFundId = e.target.value;
        renderToday();
      });
      document.getElementById('histFundFilter').addEventListener('input', renderHistory);
      document.getElementById('fileImport').addEventListener('change', function (e) {
        doImportFile(e.target.files[0]);
        e.target.value = '';
      });
      switchTab('today');
    }).catch(function (err) {
      alert('初始化失败：' + err.message);
    });
  }

  return {
    init: init, switchTab: switchTab, renderToday: renderToday, calcToday: calcToday,
    confirmToday: confirmToday, setActual: setActual, renderHistory: renderHistory,
    delRecord: delRecord, renderSettings: renderSettings, addFund: addFund, delFund: delFund,
    goToday: goToday, doExportExcel: doExportExcel, doExportBackup: doExportBackup
  };
})();

window.App = App;

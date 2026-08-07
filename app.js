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
  // OneDrive 文件名：理财基金v3版{YYYYMMDD}{当日序号}，同日序号递增，跨天重置 01
  function genBackupNameCore(ymd, seq) {
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return '理财基金v3版' + ymd + p(seq) + '.xlsx';
  }
  function genBackupName() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    var ymd = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
    var st = { key: '', n: 0 };
    try { st = JSON.parse(localStorage.getItem('fundToolSaveSeq') || '{"key":"","n":0}'); } catch (e) {}
    var seq = (st.key === ymd) ? (st.n + 1) : 1;
    localStorage.setItem('fundToolSaveSeq', JSON.stringify({ key: ymd, n: seq }));
    return genBackupNameCore(ymd, seq);
  }
  // 记住 OneDrive 目录句柄（IndexedDB 可存 FileSystemHandle）
  let odDirHandle = null;
  function loadDirHandle() {
    return DB.getAll('meta').then(function (list) {
      const m = list.find(function (x) { return x.id === 'odDir'; });
      odDirHandle = m ? m.handle : null;
    }).catch(function () { odDirHandle = null; });
  }
  function saveDirHandle(handle) {
    return DB.put('meta', { id: 'odDir', handle: handle, savedAt: new Date().toISOString() });
  }
  // 一键上传 OneDrive：首次选目录（记住），之后自动写文件
  function saveToOneDrive() {
    recomputeAll();
    const fn = genBackupName();
    const wb = buildWorkbook();
    const data = XLSX_OBJ.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const pickDir = function () {
      return window.showDirectoryPicker().then(function (h) {
        odDirHandle = h;
        return saveDirHandle(h);
      });
    };
    const writeToHandle = function (h) {
      return h.getFileHandle(fn, { create: true }).then(function (fh) {
        return fh.createWritable().then(function (w) {
          return w.write(blob).then(function () { return w.close(); });
        });
      }).then(function () { return 'written'; });
    };
    const tryHandle = function () {
      if (!odDirHandle) return Promise.resolve(null);
      return odDirHandle.queryPermission ? odDirHandle.queryPermission({ mode: 'readwrite' }).then(function (st) {
        if (st === 'granted') return writeToHandle(odDirHandle).then(function () { return true; });
        if (odDirHandle.requestPermission) {
          return odDirHandle.requestPermission({ mode: 'readwrite' }).then(function (st2) {
            if (st2 === 'granted') return writeToHandle(odDirHandle).then(function () { return true; });
            return null;
          });
        }
        return null;
      }) : null;
    };
    // 浏览器支持目录选择器 → 自动写；否则降级为下载
    if (window.showDirectoryPicker) {
      tryHandle().then(function (ok) {
        if (ok) { showToast('已上传 OneDrive：' + fn + ' ✓'); return; }
        return pickDir().then(function () { return writeToHandle(odDirHandle); }).then(function () {
          showToast('已上传 OneDrive：' + fn + ' ✓');
        }).catch(function (e) {
          // 用户取消或失败 → 降级下载
          fallbackDownload(fn, blob);
        });
      }).catch(function () { fallbackDownload(fn, blob); });
    } else {
      fallbackDownload(fn, blob);
    }
  }
  function fallbackDownload(fn, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fn;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('已生成 ' + fn + '（浏览器不支持直传，请保存到 OneDrive）');
  }
  function buildWorkbook() {
    const detail = EXPORT.buildDetailRows(funds, records);
    const auditRows = audits.slice().sort(function (a, b) { return a.time < b.time ? 1 : -1; }).map(function (a) {
      const f = getFund(a.fundId);
      return { '时间': a.time, '基金': f ? f.name : '', '记录': a.recordId || '', '字段': a.field, '改前值': a.oldVal, '改后值': a.newVal, '说明': a.desc };
    });
    const fundRows = funds.map(function (f) {
      return { '名称': f.name, '基金池': f.poolSize === undefined ? '' : f.poolSize, '基线金额': f.startCash, '基线份额': f.startShares, '基线累计波动%': f.startCumulative, '月度波动%': f.monthlyVol, '当前金额': f.cash, '当前份额': f.shares, '当前累计%': f.lastCumulative };
    });
    const wb = XLSX_OBJ.utils.book_new();
    XLSX_OBJ.utils.book_append_sheet(wb, XLSX_OBJ.utils.json_to_sheet(detail), '每日计算明细');
    XLSX_OBJ.utils.book_append_sheet(wb, XLSX_OBJ.utils.json_to_sheet(auditRows), '留痕记录');
    XLSX_OBJ.utils.book_append_sheet(wb, XLSX_OBJ.utils.json_to_sheet(fundRows), '基金设置');
    return wb;
  }
  // 右上角 toast（5 秒自动消失）
  let toastTimer = null;
  function showToast(msg) {
    let t = document.getElementById('toastBox');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toastBox';
      t.style.cssText = 'position:fixed;top:12px;right:12px;z-index:999;background:#2c6fbb;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:0;transition:opacity .3s;max-width:80vw;';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 5000);
  }
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
  // 派生列：在仓钱款=累计买入−累计卖出；在仓比例=在仓钱款/基金池；
  //        健康度=0.5−(月度波动+预估波动)×10/X
  function recomputeChain(fundId) {
    const fund = getFund(fundId);
    if (!fund) return;
    const recs = sortRecords(records.filter(function (r) { return r.fundId === fundId; }));
    let cash = Number(fund.startCash) || 0;
    let shares = Number(fund.startShares) || 0;
    let cum = Number(fund.startCumulative) || 0;
    let sumBuy = 0, sumSell = 0;
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
          if (a.dir === 'sell') { s2 = round2(s2 - a.amount); }
          else if (a.dir === 'buy') { c2 = round2(c2 - a.amount); }
          // 调整级份额补录：该调整后用户填的实际份额（买入后确认），覆盖递推值
          if (a.sharesActual !== undefined && a.sharesActual !== null && String(a.sharesActual) !== '') {
            s2 = round2(Number(a.sharesActual));
          }
          a.sharesAfter = s2;
          a.cashAfter = c2;
        });
      } else {
        r.adjustments = [];
      }
      // 在仓钱款 = 累计买入 − 累计卖出
      const buySum = r.adjustments.filter(function (a) { return a.dir === 'buy'; }).reduce(function (s, a) { return s + a.amount; }, 0);
      const sellSum = r.adjustments.filter(function (a) { return a.dir === 'sell'; }).reduce(function (s, a) { return s + a.amount; }, 0);
      sumBuy += buySum;
      sumSell += sellSum;
      r.inPositionMoney = round2(sumBuy - sumSell);
      const pool = Number(fund.poolSize) || 0;
      r.inPositionRatio = pool ? round2((r.inPositionMoney / pool) * 100) : 0; // 百分比
      r.health = round2(0.5 - (monthlyVol + estVol) * 10 / r.x);
      r.executedVol = (r.executedVol === undefined || r.executedVol === null || r.executedVol === '') ? calc.consumed : Number(r.executedVol);
      const vol = (r.actualVol === undefined || r.actualVol === null || r.actualVol === '') ? estVol : Number(r.actualVol);
      r.finalCumulative = CALC.finalCumulative(cum, vol, r.executedVol, r.dir);
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
  // 修改后弹右上角提示（5秒）
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
    }).then(function () {
      showToast('已自动计算 ✓');
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
      '  <div class="row"><label>日期（可补录历史）</label><input id="inDate" type="date" value="' + esc(todayStr()) + '"></div>' +
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

  // 确认今日操作 → 建记录 + 重算 + 留痕（单日单记录）
  function confirmToday(estVol, monthlyVol) {
    const fund = getFund(curFundId);
    if (!fund) return;
    const dateInput = document.getElementById('inDate');
    const recDate = dateInput && dateInput.value ? dateInput.value : todayStr();
    // 单日单记录检查：同基金同日期已有记录则拒绝
    const dup = records.find(function (r) { return r.fundId === fund.id && r.date === recDate; });
    if (dup) {
      alert('该基金在 ' + recDate + ' 已有记录（' + fmtDate(dup.date) + '），请到历史总表直接修改，或删除旧记录后再新增。');
      return;
    }
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
      date: recDate,
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
      records.push(rec); // 同步内存数组（否则历史页读不到）
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
      renderAudit();
      return;
    }
    recomputeAll();
    // 下拉筛选：选项只在基金数量变化时重建（避免 change 时重置导致下拉关闭）
    const sel = document.getElementById('histFundFilter');
    if (sel.options.length !== funds.length + 1) {
      sel.innerHTML = '<option value="">全部基金</option>' + funds.map(function (f) {
        return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>';
      }).join('');
    }
    const fid = sel.value;
    const recs = sortRecords(records.filter(function (r) {
      return !fid || r.fundId === fid;
    }));

    let html = '<div id="historyScroll"><table class="grid"><thead><tr>' +
      '<th>日期</th><th>基金</th><th>预估%</th><th>实际%</th><th>月度%</th><th>档位</th><th>方向</th>' +
      '<th>调整明细</th><th>执行消耗%</th><th>最终累计%</th><th>基金池</th><th>在仓钱款</th><th>在仓比例</th><th>健康度</th><th>操作</th></tr></thead><tbody>';
    const initShown = {};
    recs.forEach(function (r) {
      const f = getFund(r.fundId);
      // 每只基金第一条记录前插入"初始（基线）"行
      if (f && !initShown[r.fundId]) {
        initShown[r.fundId] = true;
        html += '<tr class="init-row"><td>初始</td><td>' + esc(f.name) + '</td><td></td><td></td><td></td><td></td><td></td>' +
          '<td>基线：金额 <b>' + round2(f.startCash) + '</b> / 份额 <b>' + round2(f.startShares) + '</b> / 累计 <b>' + f.startCumulative + '%</b></td>' +
          '<td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>';
      }
      const dirName = r.dir === 'sell' ? '卖' : (r.dir === 'buy' ? '买' : '—');
      const adjHtml = (r.adjustments || []).map(function (a) {
        return '<div class="adj-row"><b>调整' + a.idx + '</b> ' + (a.dir === 'sell' ? '卖' : (a.dir === 'buy' ? '买' : '')) +
          ' ' + a.vol + '%×' + a.ratio + '% = <input class="cell-amt" data-rec="' + esc(r.id) + '" data-idx="' + a.idx + '" type="number" step="0.01" value="' + a.amount + '">' +
          ' <span class="sh-lbl">份额</span><input class="cell-adj-shares" data-rec="' + esc(r.id) + '" data-idx="' + a.idx + '" type="number" step="0.01" value="' + esc(a.sharesActual === undefined || a.sharesActual === null ? '' : a.sharesActual) + '" placeholder="' + (a.dir === 'buy' ? '待补' : round2(a.sharesAfter)) + '" style="width:70px">' +
          '<span class="after">剩资' + (a.cashAfter === undefined ? '' : a.cashAfter) + ' / 份' + (a.sharesAfter === undefined ? '' : a.sharesAfter) + '</span></div>';
      }).join('') || '<span style="color:#999">无调整</span>';
      html += '<tr>' +
        '<td><input class="cell-date" data-rec="' + esc(r.id) + '" type="date" value="' + esc(r.date) + '"></td>' +
        '<td>' + esc(f ? f.name : r.fundId) + '</td>' +
        '<td><input class="cell-est" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + esc(r.estVol) + '"></td>' +
        '<td><input class="cell-actual" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + (r.actualVol === null || r.actualVol === undefined ? '' : r.actualVol) + '" placeholder="未录"></td>' +
        '<td><input class="cell-monthly" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + esc(r.monthlyVol) + '"></td>' +
        '<td>' + (r.x || '') + 'X</td>' +
        '<td>' + dirName + '</td>' +
        '<td>' + adjHtml + '</td>' +
        '<td><input class="cell-exec" data-rec="' + esc(r.id) + '" type="number" step="0.1" value="' + esc(r.executedVol) + '"></td>' +
        '<td><b>' + r.finalCumulative + '%</b></td>' +
        '<td>' + (f ? (round2(f.poolSize) || '—') : '') + '</td>' +
        '<td><b>' + r.inPositionMoney + '</b></td>' +
        '<td>' + r.inPositionRatio + '%</td>' +
        '<td>' + r.health + '</td>' +
        '<td><button class="btn small danger" onclick="App.delRecord(\'' + esc(r.id) + '\')">删</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    cont.innerHTML = html;
    // 默认滚动到底部（显示最新记录），上滑查看更早
    const sc = document.getElementById('historyScroll');
    if (sc) sc.scrollTop = sc.scrollHeight;
    // 留痕区
    renderAudit();
  }

  function renderAudit() {
    const box = document.getElementById('auditBox');
    const sorted = audits.slice().sort(function (a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 60);
    const bodyHtml = sorted.length
      ? '<div id="auditBody" class="audit-collapsed"><table class="grid small-grid"><tr><th>时间</th><th>基金</th><th>字段</th><th>改前</th><th>改后</th><th>说明</th></tr>' +
        sorted.map(function (a) {
          const f = getFund(a.fundId);
          return '<tr><td>' + esc(fmtDate(a.time) + ' ' + (a.time || '').slice(11, 16)) + '</td><td>' + esc(f ? f.name : '') + '</td><td>' + esc(a.field) + '</td><td>' + esc(a.oldVal) + '</td><td>' + esc(a.newVal) + '</td><td>' + esc(a.desc) + '</td></tr>';
        }).join('') + '</table></div>'
      : '<p style="color:#888">暂无留痕</p>';
    box.innerHTML = '<h3 class="audit-toggle" onclick="App.toggleAudit()">📋 留痕记录（' + audits.length + ' 条）<span id="auditArrow">▶</span></h3>' + bodyHtml;
    const body = document.getElementById('auditBody');
    if (body) body.classList.add('audit-collapsed');
  }

  function toggleAudit() {
    const body = document.getElementById('auditBody');
    const arrow = document.getElementById('auditArrow');
    if (!body) return;
    const collapsed = body.classList.toggle('audit-collapsed');
    if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
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
      if (t.classList.contains('cell-date')) {
        // 日期手动写入（保持单日单记录）
        const dup = records.find(function (x) { return x.id !== rec.id && x.fundId === rec.fundId && x.date === t.value; });
        if (dup) { alert('该基金在 ' + t.value + ' 已有记录，不能重复。'); renderHistory(); return; }
        if (!t.value) { alert('日期不能为空'); renderHistory(); return; }
        updateRecordField(rec, 'date', t.value, '修改日期 ' + rec.date + '→' + t.value).then(renderHistory);
      } else if (t.classList.contains('cell-est')) {
        updateRecordField(rec, 'estVol', v, '修改预估波动').then(renderHistory);
      } else if (t.classList.contains('cell-actual')) {
        updateRecordField(rec, 'actualVol', v, '修改实际波动').then(renderHistory);
      } else if (t.classList.contains('cell-monthly')) {
        updateRecordField(rec, 'monthlyVol', v, '修改月度波动').then(renderHistory);
      } else if (t.classList.contains('cell-shares')) {
        const oldVal = rec.sharesActual === undefined || rec.sharesActual === null ? '' : rec.sharesActual;
        rec.sharesActual = (v === '' || isNaN(v)) ? null : v;
        updateRecordField(rec, 'sharesActual', rec.sharesActual, '份额补录 ' + (oldVal === '' ? '' : oldVal) + '→' + rec.sharesActual).then(renderHistory);
      } else if (t.classList.contains('cell-adj-shares')) {
        // 调整级份额补录（每个调整后各一个份额框）
        const idx = parseInt(t.dataset.idx, 10);
        const adj = rec.adjustments.find(function (a) { return a.idx === idx; });
        if (adj) {
          const oldVal = adj.sharesActual === undefined || adj.sharesActual === null ? '' : adj.sharesActual;
          adj.sharesActual = (v === '' || isNaN(v)) ? null : v;
          updateRecordField(rec, 'adjustments', rec.adjustments, '调整' + idx + ' 份额 ' + (oldVal === '' ? '' : oldVal) + '→' + (adj.sharesActual === null ? '' : adj.sharesActual)).then(renderHistory);
        }
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
      '<div class="row"><label>基金池（计划总规模）</label><input id="newPool" type="number" step="0.01" placeholder="100000"></div>' +
      '<div class="row"><label>基线金额（初始资金池）</label><input id="newCash" type="number" step="0.01" placeholder="10000"></div>' +
      '<div class="row"><label>基线份额</label><input id="newShares" type="number" step="0.01" value="0"></div>' +
      '<div class="row"><label>基线累计波动 %</label><input id="newCum" type="number" step="0.1" value="0"></div>' +
      '<div class="row"><label>默认月度波动 %</label><input id="newMonthly" type="number" step="0.1" value="3"></div>' +
      '<button class="btn primary" onclick="App.addFund()">添加</button></div>';

    if (funds.length) {
      box.innerHTML += '<h3>基金列表（基线 = 历史递推起点；当前值 = 自动计算）</h3><table class="grid">' +
        '<tr><th>名称</th><th>基金池</th><th>基线金额</th><th>基线份额</th><th>基线累计%</th><th>月度%</th><th>当前金额</th><th>当前份额</th><th>当前累计%</th><th>操作</th></tr>' +
        funds.map(function (f) {
          return '<tr>' +
            '<td>' + esc(f.name) + '</td>' +
            '<td><input class="sf-pool" data-fid="' + esc(f.id) + '" type="number" step="0.01" value="' + esc(f.poolSize) + '"></td>' +
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
      const fieldMap = { 'sf-startcash': 'startCash', 'sf-startshares': 'startShares', 'sf-startcum': 'startCumulative', 'sf-monthly': 'monthlyVol', 'sf-pool': 'poolSize' };
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
      poolSize: parseFloat(document.getElementById('newPool').value) || 0,
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
      return loadDirHandle();
    }).then(function () {
      bindHistoryEvents();
      bindSettingsEvents();
      document.getElementById('fundSelect').addEventListener('change', function (e) {
        curFundId = e.target.value;
        renderToday();
      });
      document.getElementById('histFundFilter').addEventListener('change', renderHistory);
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
    goToday: goToday, doExportExcel: doExportExcel, doExportBackup: doExportBackup,
    saveToOneDrive: saveToOneDrive, toggleAudit: toggleAudit
  };
})();

window.App = App;

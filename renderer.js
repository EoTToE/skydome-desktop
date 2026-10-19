/* 桌面星穹浮层 v3 — 渲染进程
   单击选中 / 双击打开 · 格子 CRUD · 导入 · 拖入 · 真实图标 · 收纳格子 · 滚动
   点击穿透: 交互矩形由 ResizeObserver + 异步填充后显式 markRect 重报 (修复"下半截穿透"bug) */
(function () {
  "use strict";
  var shell = window.shell || {};
  var S = null;

  /* ---------- 点击穿透: 上报交互矩形(屏幕/DIP 坐标) ---------- */
  var rectDirty = true, rectScheduled = false;
  /* 合并上报: 多次 markRect 只排一次 rAF, 下一帧统一重报(取代原「常驻 rAF 每帧轮询」的空转) */
  function scheduleRect() {
    if (rectScheduled) return; rectScheduled = true;
    requestAnimationFrame(function () { rectScheduled = false; if (rectDirty) { rectDirty = false; reportRects(); } });
  }
  function markRect() { rectDirty = true; scheduleRect(); }
  function reportRects() {
    var nodes = document.querySelectorAll('.panel,.cell,.quit,#celladd,#celltidy,#console');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    }
    if (shell.reportRects) shell.reportRects(out);
  }

  /* ---------- 中央控制台 (半圆控制舱) ----------
     合并为单窗口后, 控制台直接在本页 → 不再需要 §1.6 的热区桥接(#chot / setConsoleOpen), 整块删除。
     面板只经 SkyHost(契约 §3 铁律), 引擎由 sky-engine.js 提供。 */
  var consoleNames = {};                     // HIP → 显示用星名(供 trknow 显示)
  function trackShort(v) { return v.name ? v.name.split(' ')[0] : ('HIP ' + v.hip); }
  function trackTitle(v) { return (v.name || ('HIP ' + v.hip)) + ' · ' + (+v.mag).toFixed(2) + ' · ' + (v.dist || '未知'); }
  function renderTrackKnow() {
    var el = document.getElementById('trknow');
    if (!el || !window.SkyHost) return;
    var hip = window.SkyHost.tracked;
    if (hip == null) { el.innerHTML = '追踪中 <b>未选择</b>'; return; }
    el.innerHTML = '追踪中 <b>' + (consoleNames[hip] || ('HIP ' + hip)) + '</b>';
  }
  function renderTrack(list) {                // SkyHost.onVisible → track 网格(只显星名, 3列)
    var el = document.getElementById('trklist');
    if (!el) return;
    list = list || [];
    for (var i = 0; i < list.length; i++) { if (list[i].name) consoleNames[list[i].hip] = trackShort(list[i]); }
    if (!list.length) {
      el.innerHTML = '<div class="r" style="grid-column:1/-1;cursor:default;color:#8fb8d8">暂无带星轨的恒星</div>';
    } else {
      var tracked = window.SkyHost ? window.SkyHost.tracked : null, h = '';
      for (var k = 0; k < list.length && k < 9; k++) {
        var v = list[k], on = (tracked === v.hip);
        h += '<div class="r' + (on ? ' on' : '') + '" data-hip="' + v.hip + '" title="' + trackTitle(v) + '">' + trackShort(v) + '</div>';
      }
      el.innerHTML = h;
    }
    renderTrackKnow();
  }
  function renderQueryResult(r) {             // SkyHost.onQueryResult → #qres
    var el = document.getElementById('qres');
    if (!el) return;
    el.className = 'qres' + ((r && r.cls) ? (' ' + r.cls) : '');
    el.textContent = (r && r.msg) || '';
  }
  function tickClock() {                       // 1s: 时钟 / 日期 / 恒星·在轨 计数
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    var c = document.getElementById('clk');
    if (c) c.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    var dt = document.getElementById('dt');
    if (dt) dt.textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    if (window.SkyHost && window.SkyHost.counts) {
      var ct = window.SkyHost.counts;
      var sc = document.getElementById('starc'); if (sc) sc.textContent = ct.total;
      var sa = document.getElementById('satc'); if (sa) sa.textContent = ct.onOrbit;
    }
    var cx = document.getElementById('cssinfo');       // 紧凑态也显示: 中国空间站(天和)实时状态
    if (cx && window.SkyHost && window.SkyHost.css) {
      var cs = window.SkyHost.css;
      if (cs && cs.alt != null && cs.alt >= 0) cx.innerHTML = '天和 · 高度 ' + Math.round(cs.alt) + '°';
      else if (cs && cs.ready) cx.innerHTML = '天和 · 地平线下';
      else cx.innerHTML = '天和 · 定位中…';
    }
  }
  function wcode(c) { if (c === 0) return '晴'; if (c <= 3) return '少云'; if (c <= 48) return '雾'; if (c <= 67) return '雨'; if (c <= 77) return '雪'; if (c <= 82) return '阵雨'; return '阴'; }
  function applyObsToConsole() {
    var loc = document.getElementById('loc');
    var obs = (S && S.sky && S.sky.obs) || (window.SkyHost && window.SkyHost.obs);
    if (loc) loc.textContent = (obs && obs.city) || '未知';
  }
  function refreshWeather() {                  // 占位 → 尽力取 Open-Meteo, 失败回落 '—'
    var el = document.getElementById('wx');
    if (!el) return;
    var obs = (S && S.sky && S.sky.obs) || { lat: 28.23, lon: 112.94 };
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + obs.lat + '&longitude=' + obs.lon + '&current=temperature_2m,weather_code';
    fetch(u, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      var c = j && j.current; if (!c) { el.textContent = '—'; return; }
      el.textContent = c.temperature_2m + '° ' + wcode(c.weather_code);
    }).catch(function () { el.textContent = '—'; });
  }
  /* 用 state.json 的 sky 初始化引擎(观测者/追踪), 并刷新控制台显示 */
  function applySkyState() {
    if (!window.SkyHost) return;
    if (S && S.sky && S.sky.obs && window.SkyHost.applyObs) window.SkyHost.applyObs(S.sky.obs);
    if (S && S.sky && S.sky.track != null && window.SkyHost.track) window.SkyHost.track(S.sky.track);
    applyObsToConsole();
  }
  function bindConsole() {
    /* ---- 设置面板 ---- */
    function setv(id, v) { var e = document.getElementById(id); if (e) e.value = v; }
    function applyVis() {
      var sc = (S && S.settings) || {};
      var rail = document.getElementById('rail'); if (rail) rail.style.display = (sc.showRail === false) ? 'none' : '';
      var cells = document.getElementById('cells'); if (cells) cells.style.display = (sc.showCells === false) ? 'none' : '';
      markRect();
    }
    function openSettings() {
      var o = (S && S.sky && S.sky.obs) || {};
      var sc = (S && S.settings) || {};
      setv('st-city', o.city || '长沙');
      setv('st-lat', o.lat != null ? o.lat : 28.23);
      setv('st-lon', o.lon != null ? o.lon : 112.94);
      var sp = document.getElementById('st-speed');
      if (sp) sp.value = String(sc.speed || (window.SkyHost && window.SkyHost.speed) || 1);
      var r = document.getElementById('st-rail'); if (r) r.checked = (sc.showRail !== false);
      var c = document.getElementById('st-cells'); if (c) c.checked = (sc.showCells !== false);
      var wa = document.getElementById('st-wallauto'); if (wa) wa.checked = !!sc.wallAuto;
      var wmn = document.getElementById('st-wallmin'); if (wmn) wmn.value = sc.wallMin || 5;
      if (shell.getAutostart) shell.getAutostart().then(function (v) { var a = document.getElementById('st-auto'); if (a) a.checked = !!v; });
      document.body.classList.add('setopen');
      shell.forceInteractive && shell.forceInteractive(true);
      markRect();
    }
    function closeSettings() {
      document.body.classList.remove('setopen');
      shell.forceInteractive && shell.forceInteractive(false);
      markRect();
    }
    var sb = document.getElementById('setbtn'); if (sb) sb.onclick = function (e) { e.stopPropagation(); openSettings(); };
    var sw = document.getElementById('st-wall');
    if (sw) sw.onclick = function (e) {
      e.stopPropagation();
      var cv = document.getElementById('sky');
      if (!cv || !shell.setOsWallpaper) return;
      var url = '';
      try { url = cv.toDataURL('image/png'); } catch (err) { url = ''; }
      if (!url) { addLocalMsg('导出壁纸失败', 'err'); return; }
      shell.setOsWallpaper(url).then(function (ok) {
        addLocalMsg('Windows 壁纸：' + (ok ? '已设为当前星空（静态，UAC/锁屏也可见）' : '设置失败'), ok ? 'ok' : 'err');
      });
    };
    var scl = document.getElementById('st-classify');
    if (scl) scl.onclick = function (e) {
      e.stopPropagation();
      if (!shell.classifyDesktop) return;
      shell.classifyDesktop().then(function (r) {
        if (r && r.ok) { addLocalMsg('已按分类重建 ' + r.cells + ' 个格子', 'ok'); }
        return shell.getState ? shell.getState() : null;
      }).then(function (st) { if (st) { S = st; applyVis(); renderAll(); } });
      closeSettings();
    };
    var scls = document.getElementById('st-close'); if (scls) scls.onclick = function (e) { e.stopPropagation(); closeSettings(); };
    var ssv = document.getElementById('st-save'); if (ssv) ssv.onclick = function (e) {
      e.stopPropagation();
      S.settings = S.settings || {};
      var city = (document.getElementById('st-city').value || '').trim() || '自定义';
      var lat = parseFloat(document.getElementById('st-lat').value), lon = parseFloat(document.getElementById('st-lon').value);
      if (isFinite(lat) && isFinite(lon)) {
        S.sky = S.sky || {};
        S.sky.obs = { lat: lat, lon: lon, city: city };
        if (window.SkyHost && window.SkyHost.applyObs) window.SkyHost.applyObs(S.sky.obs);
      }
      var sd = parseInt(document.getElementById('st-speed').value, 10);
      if (isFinite(sd) && window.SkyHost && window.SkyHost.setSpeed) { window.SkyHost.setSpeed(sd); S.settings.speed = sd; }
      S.settings.showRail = document.getElementById('st-rail').checked;
      S.settings.showCells = document.getElementById('st-cells').checked;
      S.settings.wallAuto = document.getElementById('st-wallauto').checked;
      var wm = parseInt(document.getElementById('st-wallmin').value, 10);
      S.settings.wallMin = (isFinite(wm) && wm > 0) ? wm : 5;
      wallSig = '';                      // 强制 applyWallAuto 重新按新配置起定时器
      if (S.settings.wallAuto) pushOsWallpaper();
      applyVis();
      var au = document.getElementById('st-auto').checked;
      if (shell.setAutostart) shell.setAutostart(au).then(function () { addLocalMsg('开机自启：' + (au ? '已开启' : '已关闭'), 'info'); });
      save(); closeSettings(); renderAll();
    };
    window.__applyVis = applyVis;
    /* 一键普通桌面 / 返回 */
    function setPlain(v) {
      document.body.classList.toggle('plain', v);
      if (window.SkyHost && window.SkyHost.setPaused) window.SkyHost.setPaused(v);
      markRect();
    }
    var pm = document.getElementById('plainmode');
    if (pm) pm.onclick = function (e) { e.stopPropagation(); setPlain(true); };
    var bp = document.getElementById('backplane');
    if (bp) bp.onclick = function (e) { e.stopPropagation(); setPlain(false); };
    var spd = document.getElementById('spdv');          // 时间流速(壁纸动感)切换
    if (spd) {
      var SPD = [1, 30, 120, 300, 600, 1800];
      var cur = (window.SkyHost && window.SkyHost.speed) || 1;
      var lbl = function (v) { return v === 1 ? '⏩ 实时' : ('⏩ ×' + v); };
      spd.textContent = lbl(cur);
      spd.onclick = function (e) {
        e.stopPropagation();
        var i = SPD.indexOf(cur); cur = SPD[(i + 1) % SPD.length];
        if (window.SkyHost && window.SkyHost.setSpeed) window.SkyHost.setSpeed(cur);
        spd.textContent = lbl(cur);
      };
    }
    var q = document.getElementById('q');
    if (q) {
      q.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); if (window.SkyHost) window.SkyHost.query(q.value); }
      });
      q.addEventListener('focus', function () { shell.forceInteractive && shell.forceInteractive(true); });
      q.addEventListener('blur', function () { shell.forceInteractive && shell.forceInteractive(false); });
    }
    var trk = document.getElementById('trklist');   // 行点击: 切换追踪(经 SkyHost), 并写回 state.sky.track
    if (trk) trk.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== trk) {
        if (t.getAttribute && t.getAttribute('data-hip') && /(^|\s)r(\s|$)/.test(t.className || '')) {
          var hip = parseInt(t.getAttribute('data-hip'), 10);
          var next = (window.SkyHost && window.SkyHost.tracked === hip) ? null : hip;
          if (window.SkyHost) window.SkyHost.track(next);
          if (S) { S.sky = S.sky || {}; S.sky.track = next; save(); }
          return;
        }
        t = t.parentNode;
      }
    });
    if (window.SkyHost) {
      window.SkyHost.onVisible(renderTrack);
      window.SkyHost.onQueryResult(renderQueryResult);
    }
    /* 控制台: 默认紧凑, 悬停展开; 每次切换必须 markRect ——
       否则刚露出的区域会被穿透判定当成桌面, 点击落空。
       #q 有焦点或有输入时不自动收起(留给用户继续搜索)。 */
    var con = document.getElementById('console');
    if (con) {
      var conHover = false;
      function qBusy() { return !!(q && (q === document.activeElement || (q.value || '').trim())); }
      function conClose() { if (con.classList.contains('open')) { con.classList.remove('open'); markRect(); } }
      con.addEventListener('mouseenter', function () { conHover = true; con.classList.add('open'); markRect(); });
      con.addEventListener('mouseleave', function () { conHover = false; if (!qBusy()) conClose(); });
    /* 关键兜底: 穿透态下 #console 收不到鼠标事件 → 用主进程下发的【全局光标】驱动展开/收起。
       迟滞: 进入用紧凑框、退出用展开框(固定几何, 不用动画中的 rect) → 不抖动, 也保证能走到控制条按钮。 */
    if (shell.onCursor) {
      shell.onCursor(function (p) {
        if (!p) return;
        var vw = window.innerWidth, vh = window.innerHeight, by = vh - 36.4;
        var openBox = { l: vw / 2 - 282, r: vw / 2 + 282, t: by - 320, b: by };
        var compactBox = { l: vw / 2 - 115, r: vw / 2 + 115, t: by - 130, b: by };
        if (!con.classList.contains('open')) {
          if (p.x >= compactBox.l && p.x <= compactBox.r && p.y >= compactBox.t && p.y <= compactBox.b) {
            conHover = true; con.classList.add('open'); markRect();
          }
        } else {
          if (!(p.x >= openBox.l - 8 && p.x <= openBox.r + 8 && p.y >= openBox.t - 8 && p.y <= openBox.b + 8)) {
            conHover = false; if (!qBusy()) conClose();
          }
        }
      });
    }
      con.addEventListener('transitionend', function () { markRect(); });   // 过渡结束再报一次真实矩形
      if (q) q.addEventListener('blur', function () { if (!conHover && !qBusy()) conClose(); });
    }
    tickClock(); setInterval(tickClock, 1000);
    refreshWeather();
  }

  /* ---------- 选中 (单击) ---------- */
  function clearSel() {
    var a = document.querySelectorAll('.sel');
    for (var i = 0; i < a.length; i++) a[i].classList.remove('sel');
  }
  function selectOnly(node) { clearSel(); if (node) node.classList.add('sel'); }

  /* ---------- 通用工具 ---------- */
  function activeTodo() { return (S.todos || []).filter(function (t) { return t.working && !t.done && t.path; })[0] || null; }
  function workPath() { var w = activeTodo(); return w ? w.path : ''; }
  function baseName(p) { var a = String(p || '').split(/[\\/]/); return a[a.length - 1] || String(p || ''); }
  function openPath(p) { if (p && shell.fsOpen) shell.fsOpen(p); }
  function addLocalMsg(t, l) { if (shell.addMessage) shell.addMessage(t, l); }

  /* 图标: 只用 Windows 原生 shell 图标 (main 进程 app.getFileIcon)。
     槽位常驻 16px, 图标未到/取不到都留白 —— 绝不画占位点、绝不调色/放大。 */
  function loadIcon(img, p) {
    if (!p || !shell.icon) return;
    shell.icon(p).then(function (u) {
      if (u && img) { img.src = u; img.style.visibility = 'visible'; }
    }).catch(function () { /* 取不到 → 保持留白 */ });
  }
  /* 文件行图标: 文件(非目录)优先试 shell.thumb(图片缩略图, 48px 源由 CSS 缩到 16px 槽);
     thumb 缺失 / 返回空 → 回落原生 shell.icon。目录永远走原生文件夹图标。
     shell.thumb 由主进程并行新增, 这里必须 guarding(没有时行为与今天完全一致)。 */
  function loadRowIcon(img, p, isDir) {
    if (!p) return;
    if (isDir || !shell.thumb) { loadIcon(img, p); return; }
    shell.thumb(p).then(function (u) {
      if (u && img) { img.src = u; img.style.visibility = 'visible'; }
      else loadIcon(img, p);
    }).catch(function () { loadIcon(img, p); });
  }
  /* 通用行: 单击选中 / 双击打开 / 可选右键菜单 */
  function listRow(cls, name, isDir, fullPath, menuCb) {
    var it = document.createElement('div');
    it.className = cls + (isDir ? ' d' : '');
    it.dataset.path = fullPath || '';
    it.dataset.dir = isDir ? '1' : '0';
    var img = document.createElement('img'); img.className = 'ico'; img.alt = '';
    var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name; nm.title = name;
    it.appendChild(img); it.appendChild(nm);
    it.onclick = function (ev) { ev.stopPropagation(); selectOnly(it); };
    it.ondblclick = function (ev) { ev.stopPropagation(); openPath(fullPath); };
    if (menuCb) it.oncontextmenu = function (ev) { ev.preventDefault(); ev.stopPropagation(); menuCb(fullPath); };
    loadRowIcon(img, fullPath, isDir);
    return it;
  }

  /* ---------- 渲染 ---------- */
  function renderAll() { applyWallAuto(); renderWork(); renderTodo(); renderMsgs(); renderCells(); markRect(); }
  /* ---- 静态壁纸: 导出当前星空 → Windows 壁纸; 可选定时重导(跟着天象走) ---- */
  var wallTimer = null, wallSig = '';
  function pushOsWallpaper() {
    var cv = document.getElementById('sky');
    if (!cv || !shell.setOsWallpaper) return;
    var url = '';
    try { url = cv.toDataURL('image/png'); } catch (e) { url = ''; }
    if (!url) return;
    shell.setOsWallpaper(url).then(function (ok) {
      addLocalMsg('Windows 壁纸已更新' + (ok ? '' : '（失败）'), ok ? 'info' : 'err');
    });
  }
  function applyWallAuto() {
    var sc = (S && S.settings) || {};
    var sig = (sc.wallAuto ? '1' : '0') + '|' + (sc.wallMin || 5);
    if (sig === wallSig) return;
    wallSig = sig;
    if (wallTimer) { clearInterval(wallTimer); wallTimer = null; }
    if (sc.wallAuto) wallTimer = setInterval(pushOsWallpaper, Math.max(1, sc.wallMin || 5) * 60000);
  }

  /* ---------- 工作格子 · 空闲态「拾光卡」(联网内容轮播) ----------
     无「正在工作」待办时, 轮播 3 个免费无 key、支持 CORS 的源:
       NASA APOD / NOAA 空间天气 Kp / Hacker News 热榜。
     · 会话内轮换 —— 不写 state.json(形状不变, 未知键照旧保留)
     · 每源惰性抓取 + 内存缓存 5 分钟
     · 任一源失败自动跳下一源; 全部失败 → 本地星穹/天文冷知识 5 条(面板永不为空)
     · 每次改动 DOM 后 markRect() (点击穿透判定始终正确) */
  var IDLE_TTL = 5 * 60 * 1000;             // 单源缓存 5 分钟
  var IDLE_MS = 45000;                      // 轮换间隔 45s
  var idleCache = {};                       // key → { at, data }
  var idleIdx = 0;                          // 会话内轮换索引
  var idleTimer = null;                     // 45s setInterval
  var idleSeq = 0;                          // 过期回调拦截(与 wkSeq 同思路)
  var FACTS = [
    '星穹之上, 肉眼可见的恒星约 6000 颗, 而银河系就有上千亿颗。',
    '一光年是光走一年的距离, 约 9.46 万亿公里。',
    '天狼星是一对双星, 伴星「天狼 B」是一颗致密白矮星。',
    '空间站每约 90 分钟绕地球一圈, 宇航员一天能看 16 次日出。',
    'Kp≥5 即地磁暴: 极光向低纬扩散, 高纬通信与导航可能受扰。',
  ];
  function elN(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function fetchJson(url, timeoutMs) {          // 带超时的 CORS fetch (任何失败都 reject)
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var opt = { cache: 'no-store' }; if (ctl) opt.signal = ctl.signal;
    var to = setTimeout(function () { try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ } }, timeoutMs || 9000);
    return fetch(url, opt).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) { clearTimeout(to); return j; }, function (e) { clearTimeout(to); throw e; });
  }
  /* 英文→中文: 先试要求的 translate.googleapis.com; 失败(本机被墙) 退 MyMemory; 再失败显原文。
     仅翻译当前展示的卡片; 结果按原文缓存(会话内内存)。绝不抛出、绝不空白。 */
  var trCache = {};
  function transGoogle(text) {
    var u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(text);
    return fetchJson(u, 3500).then(function (arr) {
      var out = '';
      if (Array.isArray(arr) && Array.isArray(arr[0])) arr[0].forEach(function (s) { if (s && s[0]) out += s[0]; });
      out = out.trim(); if (!out) throw new Error('empty google'); return out;
    });
  }
  function transMyMemory(text) {
    var u = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|zh-CN';
    return fetchJson(u, 7000).then(function (j) {
      var out = String(((j && j.responseData && j.responseData.translatedText) || '')).trim();
      if (!out || /MYMEMORY WARNING/i.test(out) || out === text) throw new Error('bad mymemory');
      return out;
    });
  }
  function translateEn(text) {
    var t = String(text || '').trim();
    if (!t || /[\u4e00-\u9fff]/.test(t)) return Promise.resolve(t);   // 空 / 已含中文 → 原样
    if (trCache[t]) return Promise.resolve(trCache[t]);
    var q = t.slice(0, 480);
    return transGoogle(q).catch(function () { return transMyMemory(q); })
      .then(function (zh) { zh = String(zh || '').trim(); if (!zh) throw new Error('empty'); trCache[t] = zh; return zh; })
      .catch(function () { return t; });                              // 全部失败 → 原文(绝不空白)
  }
  function loadHitokoto() {                      // 一言: 原生中文, 无 key, CORS(*)
    return fetchJson('https://v1.hitokoto.cn/', 8000).then(function (j) {
      if (!j || !j.hitokoto) throw new Error('bad hitokoto');
      return { kind: 'hitokoto', text: String(j.hitokoto),
               from: j.from ? String(j.from) : '', who: j.from_who ? String(j.from_who) : '' };
    });
  }
  function loadApod() {                          // NASA 每日天文
    return fetchJson('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY').then(function (j) {
      if (!j || !j.title) throw new Error('bad apod');
      var ex = String(j.explanation || '').replace(/\s+/g, ' ').trim();
      return {
        kind: 'apod', media: (j.media_type === 'video' ? 'video' : 'image'),
        title: String(j.title), text: ex.slice(0, 130) + (ex.length > 130 ? '…' : ''),
        thumb: (j.media_type === 'image') ? String(j.url || j.hdurl || '') : '',
        url: String(j.hdurl || j.url || ''),
        credit: j.copyright ? String(j.copyright).slice(0, 60) : '',
      };
    });
  }
  function kpFromProducts(j) {                   // 形如 [["time_tag","Kp",...],[...],[...]]
    if (!Array.isArray(j) || !j.length) return null;
    var last = j[j.length - 1];
    if (Array.isArray(last)) { var v = parseFloat(last[1]); if (isFinite(v)) return { kp: v, time: String(last[0] || '') }; }
    return null;
  }
  function kpFrom1m(j) {                         // 形如 [{time_tag,kp_index,...}, ...]
    if (!Array.isArray(j) || !j.length) return null;
    var last = j[j.length - 1];
    if (last && typeof last === 'object') {
      var cand = (last.kp_index != null) ? last.kp_index : ((last.kp != null) ? last.kp : last.estimated_kp);
      var v = parseFloat(cand); if (isFinite(v)) return { kp: v, time: String(last.time_tag || '') };
    }
    return null;
  }
  function loadNoaa() {                          // NOAA 空间天气: 先 products, 失败退 1m
    return fetchJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json')
      .then(function (j) { var k = kpFromProducts(j); if (k) return k; throw new Error('bad noaa products'); })
      .catch(function () {
        return fetchJson('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json')
          .then(function (j2) { var k2 = kpFrom1m(j2); if (k2) return k2; throw new Error('bad noaa 1m'); });
      }).then(function (k) { return { kind: 'noaa', kp: k.kp, time: k.time }; });
  }
  function loadHN() {                            // Hacker News 热榜(取前 5 条)
    return fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json').then(function (ids) {
      if (!Array.isArray(ids) || !ids.length) throw new Error('bad hn');
      return Promise.all(ids.slice(0, 5).map(function (id) {
        return fetchJson('https://hacker-news.firebaseio.com/v0/item/' + id + '.json').then(function (it) {
          if (!it || !it.title) return null;
          return { title: String(it.title), score: (typeof it.score === 'number' ? it.score : 0),
                   url: String(it.url || ('https://news.ycombinator.com/item?id=' + id)) };
        }).catch(function () { return null; });
      })).then(function (arr) {
        var items = arr.filter(function (x) { return x; });
        if (!items.length) throw new Error('bad hn items');
        return { kind: 'hn', items: items };
      });
    });
  }
  var IDLE_SOURCES = [
    { key: 'hitokoto', label: '一言 · 中文妙语', load: loadHitokoto },   // 原生中文, 放首位保证默认卡即中文
    { key: 'apod', label: 'NASA · 每日天文', load: loadApod },           // 英文 → 译中文
    { key: 'noaa', label: 'NOAA · 空间天气', load: loadNoaa },           // 已中文化
    { key: 'hn', label: 'Hacker News · 热榜', load: loadHN },            // 英文 → 译中文
  ];
  function idleData(i, force) {                  // 命中 5 分钟缓存则直接返回, 否则惰性抓取
    var s = IDLE_SOURCES[i], c = idleCache[s.key];
    if (!force && c && (Date.now() - c.at) < IDLE_TTL) return Promise.resolve(c.data);
    return s.load().then(function (d) { idleCache[s.key] = { at: Date.now(), data: d }; return d; });
  }
  function openUrl(u) { if (u && shell.fsOpen) shell.fsOpen(u); }
  function paintApod(body, d) {
    if (d.media === 'image' && d.thumb) {
      var im = elN('img', 'idlthumb'); im.loading = 'lazy'; im.alt = '';
      im.onerror = function () { im.style.display = 'none'; };
      im.src = d.thumb; body.appendChild(im);
    }
    var t = elN('div', 'idltitle', d.title);          // 先显原文(绝不空白), 译好再换中文
    t.title = '点击打开'; t.onclick = function () { openUrl(d.url); };
    body.appendChild(t);
    var tx = null;
    if (d.text) { tx = elN('div', 'idltext', d.text); body.appendChild(tx); }
    if (d.media === 'video') {
      var l = elN('div', 'idllink', '▶ 观看视频 ›'); l.onclick = function () { openUrl(d.url); };
      body.appendChild(l);
    }
    if (d.credit) body.appendChild(elN('div', 'idlsrc', '© ' + d.credit));
    translateEn(d.title).then(function (zh) { if (zh && zh !== d.title) { t.textContent = zh; markRect(); } });
    if (tx) translateEn(d.text).then(function (zh) { if (zh && zh !== d.text) { tx.textContent = zh; markRect(); } });
  }
  function paintNoaa(body, d) {                        // NOAA 空间天气: 中文标签; Kp≥5 → 红「地磁活动偏强」
    var kpv = Math.round(d.kp * 10) / 10, warn = kpv >= 5;
    var row = elN('div', 'idlkp');
    row.appendChild(elN('span', 'idlkpv' + (warn ? ' warn' : ''), 'Kp ' + kpv));
    row.appendChild(elN('span', 'idlkpt' + (warn ? ' warn' : ''), warn ? '地磁活动偏强' : (kpv >= 4 ? '地磁活跃' : '地磁平静')));
    body.appendChild(row);
    var when = d.time ? ('（' + d.time.replace('T', ' ').slice(5, 16) + '）') : '';
    body.appendChild(elN('div', 'idltext', '空间天气 · Kp ' + kpv + when));
  }
  function paintHN(body, d) {                          // HN 热榜: 标题译中文(先原文后替换)
    var box = elN('div', 'idlehn');
    d.items.forEach(function (it) {
      var r = elN('div', 'hnrow');
      var ti = elN('span', 'hntitle', it.title); ti.title = it.title;
      r.appendChild(ti); r.appendChild(elN('span', 'hnscore', String(it.score)));
      r.onclick = function () { openUrl(it.url); };
      box.appendChild(r);
      translateEn(it.title).then(function (zh) { if (zh && zh !== it.title) { ti.textContent = zh; ti.title = zh; markRect(); } });
    });
    body.appendChild(box);
  }
  function paintHitokoto(body, d) {                    // 一言: 原生中文
    body.appendChild(elN('div', 'idlquote', '「' + d.text + '」'));
    var by = d.who ? (d.who + (d.from ? ' · ' + d.from : '')) : d.from;
    if (by) body.appendChild(elN('div', 'idlsrc', '—— ' + by));
  }
  function paintFacts(body) {                    // 离线兜底: 面板永不为空
    body.innerHTML = '';
    body.appendChild(elN('div', 'idlsrc', '离线 · 星穹冷知识'));
    FACTS.forEach(function (f) { body.appendChild(elN('div', 'idltext idlfact', f)); });
  }
  function paintIdle(body, d) {
    body.innerHTML = '';
    if (!d) { paintFacts(body); return; }
    if (d.kind === 'hitokoto') paintHitokoto(body, d);
    else if (d.kind === 'apod') paintApod(body, d);
    else if (d.kind === 'noaa') paintNoaa(body, d);
    else if (d.kind === 'hn') paintHN(body, d);
    else paintFacts(body);
  }
  function renderIdle(force, depth) {            // 画当前源; 失败→跳下一源; 全失败→冷知识
    depth = depth || 0;
    var list = document.getElementById('wklist');
    if (!list) return;
    idleSeq++; var seq = idleSeq;
    var n = IDLE_SOURCES.length;
    var i = ((idleIdx % n) + n) % n, src = IDLE_SOURCES[i];
    list.innerHTML = '';
    var card = elN('div', 'idlecard'), top = elN('div', 'idletop');
    top.appendChild(elN('span', 'srclabel', src.label));
    var nx = elN('span', 'idlebtn', '›'); nx.title = '下一个来源';
    nx.onclick = function (ev) { ev.stopPropagation(); idleIdx = (i + 1) % n; renderIdle(false, 0); };
    var rf = elN('span', 'idlebtn', '⟳'); rf.title = '刷新';
    rf.onclick = function (ev) { ev.stopPropagation(); renderIdle(true, 0); };
    top.appendChild(nx); top.appendChild(rf);
    card.appendChild(top);
    var body = elN('div', 'idlebody'); card.appendChild(body);
    list.appendChild(card);
    body.appendChild(elN('div', 'wkempty', '加载中…'));
    markRect();
    idleData(i, force).then(function (d) {
      if (seq !== idleSeq) return;               // 已被更新的渲染取代
      paintIdle(body, d); markRect();
    }).catch(function () {
      if (seq !== idleSeq) return;
      if (depth < n - 1) { idleIdx = (i + 1) % n; renderIdle(force, depth + 1); return; }   // 失败 → 跳下一源
      paintFacts(body); markRect();                                                          // 全部失败 → 离线冷知识
    });
  }
  function startIdle(force) {                    // 进入空闲态: 保证定时器唯一 + 立即渲染
    if (!idleTimer) idleTimer = setInterval(function () {
      idleIdx = (idleIdx + 1) % IDLE_SOURCES.length; renderIdle(false, 0);
    }, IDLE_MS);
    renderIdle(!!force, 0);
  }
  function stopIdle() { if (idleTimer) { clearInterval(idleTimer); idleTimer = null; } }

  /* ---------- 工作格子: 「正在工作」待办所关联文件夹的内容 ---------- */
  var wkSeq = 0;
  /* ---------- 空闲态: 快捷方式(网址/软件/文件) ---------- */
  function renderShortcuts(list) {
    var arr = (S.shortcuts || []);
    if (!arr.length) {
      var e = document.createElement('div'); e.className = 'wkempty';
      e.textContent = '还没有快捷方式 · 用下面的 ＋ 添加';
      list.appendChild(e);
    }
    arr.forEach(function (s) {
      var it = document.createElement('div'); it.className = 'wkitem';
      it.style.cursor = 'pointer';
      var img = document.createElement('img'); img.className = 'ico'; img.alt = '';
      var nm = document.createElement('span'); nm.className = 'nm';
      nm.textContent = s.title || s.target || '?'; nm.title = s.target || '';
      var ed = document.createElement('span'); ed.textContent = '✎'; ed.title = '重命名';
      ed.style.cssText = 'margin-left:auto;color:#5c7b98;cursor:pointer;font-size:12px;padding:0 3px';
      ed.onmouseenter = function () { ed.style.color = '#9fe6b0'; };
      ed.onmouseleave = function () { ed.style.color = '#5c7b98'; };
      ed.onclick = function (ev) { ev.stopPropagation(); beginShortcutRename(s, it); };
      var x = document.createElement('span'); x.textContent = '×'; x.title = '移除（不删文件）';
      x.style.cssText = 'color:#5c7b98;cursor:pointer;font-size:13px;padding:0 4px';
      x.onmouseenter = function () { x.style.color = '#ff8a8a'; };
      x.onmouseleave = function () { x.style.color = '#5c7b98'; };
      x.onclick = function (ev) {
        ev.stopPropagation();
        S.shortcuts = (S.shortcuts || []).filter(function (y) { return y !== s; });
        save(); renderAll();
      };
      it.appendChild(img); it.appendChild(nm); it.appendChild(ed); it.appendChild(x);
      it.onclick = function (ev) { ev.stopPropagation(); if (s.target) openPath(s.target); };
      it.oncontextmenu = function (ev) { ev.preventDefault(); ev.stopPropagation(); beginShortcutRename(s, it); };
      if (s.kind === 'path') loadIcon(img, s.target); else img.style.visibility = 'hidden';
      list.appendChild(it);
    });
    var add = document.createElement('div');
    add.style.cssText = 'display:flex;gap:14px;padding:6px 0 2px';
    var bu = document.createElement('span'); bu.textContent = '＋ 网址';
    bu.style.cssText = 'font-size:11px;color:#7fd0ff;cursor:pointer';
    bu.onclick = function (ev) { ev.stopPropagation(); addShortcutUrl(list); };
    var bf = document.createElement('span'); bf.textContent = '＋ 软件 · 文件';
    bf.style.cssText = 'font-size:11px;color:#7fd0ff;cursor:pointer';
    bf.onclick = function (ev) { ev.stopPropagation(); addShortcutPath(); };
    var bg = document.createElement('span'); bg.textContent = '设置链接…';
    bg.style.cssText = 'font-size:11px;color:#6f8aa6;cursor:pointer';
    bg.onclick = function (ev) { ev.stopPropagation(); addShortcutUrl(list); };
    add.appendChild(bu); add.appendChild(bf);
    list.appendChild(add);
    markRect();
  }
  function addShortcutUrl(list) {
    var row = document.createElement('div'); row.className = 'wkitem';
    var inp = document.createElement('input'); inp.className = 'rn'; inp.placeholder = '名称 网址（也可只填网址）回车';
    row.appendChild(inp); list.appendChild(row);
    inp.focus(); shell.forceInteractive && shell.forceInteractive(true);
    var done = false;
    function fin(commit) {
      if (done) return; done = true;
      shell.forceInteractive && shell.forceInteractive(false);
      var v = (inp.value || '').trim();
      if (commit && v) {
        var name = '', url = v, sp = v.split(/\s+/);
        if (sp.length >= 2) {                       // 支持 “名称 网址” 一起填
          var last = sp[sp.length - 1];
          if (/^(https?:\/\/|[\w-]+(\.[\w-]+)+)/.test(last)) { url = last; name = sp.slice(0, -1).join(' '); }
        }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        var title = name || url.replace(/^https?:\/\//i, '').split('/')[0];
        S.shortcuts = S.shortcuts || [];
        S.shortcuts.push({ id: 's' + Date.now(), kind: 'url', title: title, target: url });   // 显示名 / 网址内藏
        save();
      }
      renderAll();
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
    inp.addEventListener('blur', function () { fin(true); });
    inp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  }
  function addShortcutPath() {
    if (!shell.fsPick) return;
    shell.fsPick('files').then(function (ps) {
      if (!ps || !ps.length) return;
      S.shortcuts = S.shortcuts || [];
      ps.forEach(function (p) {
        S.shortcuts.push({ id: 's' + Date.now() + Math.random().toString(36).slice(2, 6), kind: 'path', title: baseName(p).replace(/\.(lnk|url|exe)$/i, ''), target: p });
      });
      save(); renderAll();
    });
  }
  function beginShortcutRename(s, row) {
    var nm = row.querySelector('.nm'); if (!nm) return;
    var inp = document.createElement('input'); inp.className = 'rn'; inp.value = s.title || '';
    row.replaceChild(inp, nm); inp.focus(); inp.select();
    shell.forceInteractive && shell.forceInteractive(true);
    var done = false;
    function fin(commit) {
      if (done) return; done = true;
      shell.forceInteractive && shell.forceInteractive(false);
      if (commit) { var v = inp.value.trim(); if (v) s.title = v; }
      save(); renderAll();
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
    inp.addEventListener('blur', function () { fin(true); });
    inp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  }
  function renderWork() {
    var hd = document.getElementById('workhd');
    var sub = document.getElementById('wksub');
    var list = document.getElementById('wklist');
    var openBtn = document.getElementById('wkopen');
    if (!hd || !sub || !list) return;
    wkSeq++; idleSeq++;                    // idleSeq++: 使在途的空闲卡回调作废(防止盖到新列表)
    var seq = wkSeq;
    list.innerHTML = '';
    var t = activeTodo();
    if (!t) {
      hd.textContent = '工作格子 · 快捷方式';
      sub.textContent = '空闲 · 点击直接打开';
      sub.title = '';
      if (openBtn) openBtn.classList.add('off');
      var ref0 = document.getElementById('wkref'); if (ref0) ref0.style.display = 'none';   // 空闲态(快捷方式)无需刷新
      stopIdle();
      renderShortcuts(list);
      return;
    }
    stopIdle();                            // 进入工作态: 停掉轮播, 恢复文件夹列表
    var ref1 = document.getElementById('wkref'); if (ref1) ref1.style.display = '';
    if (openBtn) openBtn.classList.remove('off');
    hd.textContent = '工作格子 · ' + baseName(t.path);
    sub.textContent = '⏳ ' + t.text;
    sub.title = t.text;
    var slot = document.createElement('div'); slot.className = 'wkempty'; slot.textContent = '读取中…';
    list.appendChild(slot);
    if (!shell.fsList) { slot.textContent = '（无法读取，主进程未就绪）'; return; }
    var dir = t.path;
    shell.fsList(dir).then(function (r) {
      if (seq !== wkSeq) return;            // 已被更新的渲染取代, 丢弃
      list.innerHTML = '';
      if (!r || !r.ok) {
        var e = document.createElement('div'); e.className = 'wkempty';
        e.textContent = '无法读取：' + ((r && r.error) || '');
        list.appendChild(e); markRect(); return;
      }
      var ents = r.entries || [];
      if (!ents.length) {
        var e2 = document.createElement('div'); e2.className = 'wkempty'; e2.textContent = '（空文件夹）';
        list.appendChild(e2); markRect(); return;
      }
      ents.forEach(function (en) {
        list.appendChild(listRow('wkitem', en.name, en.isDir, dir + '\\' + en.name));
      });
      markRect();                            // 关键修复: 内容长高后重报矩形
    }).catch(function () {
      if (seq !== wkSeq) return;
      list.innerHTML = '';
      var e3 = document.createElement('div'); e3.className = 'wkempty'; e3.textContent = '读取失败';
      list.appendChild(e3); markRect();
    });
  }

  function renderTodo() {
    var el = document.getElementById('tlist');
    el.innerHTML = '';
    (S.todos || []).forEach(function (t) {
      var row = document.createElement('div');
      row.className = 'row' + (t.done ? ' done' : '');
      var cb = document.createElement('span'); cb.className = 'cb' + (t.done ? ' on' : '');
      cb.onclick = function () { t.done = !t.done; save(); renderAll(); };
      var tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = t.text; tx.title = t.text + '（双击改名）';
      tx.ondblclick = function (ev) {           // 双击待办文字 → 就地改名
        ev.stopPropagation();
        var inp = document.createElement('input'); inp.className = 'rn'; inp.value = t.text;
        row.replaceChild(inp, tx); inp.focus(); inp.select();
        shell.forceInteractive && shell.forceInteractive(true);
        var done = false;
        function fin(commit) {
          if (done) return; done = true;
          shell.forceInteractive && shell.forceInteractive(false);
          if (commit) { var v = inp.value.trim(); if (v) t.text = v; }
          save(); renderAll();
        }
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') fin(false); });
        inp.addEventListener('blur', function () { fin(true); });
        inp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
      };
      var tag = document.createElement('span'); tag.className = 'tag' + (t.working ? '' : ' off');
      tag.textContent = t.working ? '正在工作' : '工作';
      tag.title = '设为/取消 正在工作';
      tag.onclick = function () {
        var was = t.working;
        S.todos.forEach(function (x) { x.working = false; });
        t.working = !was; save(); renderAll();
      };
      var fl = document.createElement('span'); fl.className = 'fl';
      fl.textContent = t.path ? '📁' : '＋';
      fl.title = t.path ? ('打开：' + t.path) : '关联文件夹';
      fl.onclick = function () {
        if (t.path) { shell.fsOpen(t.path); }
        else shell.fsPick('folder').then(function (p) { if (p) { t.path = p; save(); renderAll(); } });
      };
      var x = document.createElement('span'); x.className = 'x'; x.textContent = '×';
      x.onclick = function () { S.todos = S.todos.filter(function (y) { return y !== t; }); save(); renderAll(); };
      row.appendChild(cb); row.appendChild(tx); row.appendChild(tag); row.appendChild(fl); row.appendChild(x);
      el.appendChild(row);
    });
  }

  var msgsTab = 'notify';                      // 'notify' | 'search' (两个独立功能区, 互不干扰)
  function pickIntoCell(pth) {
    if (!shell.pickTarget) return;
    shell.pickTarget().then(function (id) {
      if (!id) return;
      var tgt = (S.cells || []).filter(function (x) { return x.id === id; })[0];
      if (!tgt) return;
      tgt.items = tgt.items || [];
      if (tgt.items.indexOf(pth) < 0) tgt.items.push(pth);
      save(); renderAll();
      addLocalMsg('已收纳：' + baseName(pth) + ' → ' + (tgt.title || id), 'info');
    });
  }
  function doSearch() {
    var inp = document.getElementById('snew');
    var q = (inp && inp.value || '').trim();
    if (!q || !shell.searchFiles) return;
    S.messages = (S.messages || []).filter(function (m) { return m.kind !== 'search'; });   // 清掉上一轮搜索结果
    shell.searchFiles(q).then(function (arr) {
      (arr || []).forEach(function (x) {
        S.messages.unshift({ time: Date.now() + Math.random(), level: 'info', kind: 'search',
          text: (x.isDir ? '📁 ' : '📄 ') + x.name, path: x.path, isDir: !!x.isDir });
      });
      if (inp) inp.value = '';
      msgsTab = 'search';
      save(); renderAll();
    });
  }
  function renderMsgs() {
    var el = document.getElementById('mlist');
    if (!el) return;
    el.innerHTML = '';
    var all = (S.messages || []);
    var list = all.filter(function (m) {
      return (msgsTab === 'search') ? (m.kind === 'search') : (m.kind !== 'search');
    }).slice(0, 3);
    var tabs = document.querySelectorAll('.mtab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-mt') === msgsTab);
    if (!list.length) { el.innerHTML = '<div class="empty">' + (msgsTab === 'search' ? '输入关键字回车搜索' : '暂无消息') + '</div>'; return; }
    list.forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'msg ' + (m.level || 'info') + (m.path ? ' act' : '');
      var t = document.createElement('span'); t.className = 'mt';
      var dt = new Date(m.time || Date.now());
      t.textContent = ('0' + dt.getHours()).slice(-2) + ':' + ('0' + dt.getMinutes()).slice(-2);
      d.appendChild(t); d.appendChild(document.createTextNode(m.text || ''));
      if (m.path) {
        d.title = (m.kind === 'search' ? '点击打开所在文件夹' : '点击收纳到格子') + ' · 右键更多';
        (function (msg) {
          d.onclick = function (ev) {
            ev.stopPropagation();
            if (msg.kind === 'search') { if (shell.fsReveal) shell.fsReveal(msg.path); return; }
            pickIntoCell(msg.path);
          };
          d.oncontextmenu = function (ev) {
            ev.preventDefault(); ev.stopPropagation();
            if (shell.msgMenu) shell.msgMenu({ path: msg.path, kind: msg.kind || '', id: msg.time });
          };
        })(m);
      }
      el.appendChild(d);
    });
  }

  /* ---------- 格子 ---------- */
  var cellObs = [];
  var ro = new ResizeObserver(function () { markRect(); });
  function clearCellObs() {
    for (var i = 0; i < cellObs.length; i++) { try { ro.unobserve(cellObs[i]); } catch (e) { /* ignore */ } }
    cellObs = [];
  }
  function observeRail() {
    ['panel-work', 'panel-todo', 'panel-msgs', 'panel-skyinfo', 'panel-track', 'console'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) { try { ro.observe(e); } catch (err) { /* ignore */ } }
    });
  }

  function cellMenuFor(c) { if (shell.cellMenu) shell.cellMenu({ cellId: c.id, target: 'header', kind: c.kind }); }
  function rowMenuFor(c, fullPath) { if (shell.cellMenu) shell.cellMenu({ cellId: c.id, target: 'row', rowPath: fullPath, kind: c.kind }); }

  function renderCells() {
    var host = document.getElementById('cells');
    clearCellObs();
    host.innerHTML = '';
    (S.cells || []).forEach(function (c) { host.appendChild(buildCell(c)); });
    markRect();
  }

  /* 胶囊折叠: 切换 cell.capsule; 只改 class + chevron, 不动 cell.h(展开即还原原高度)。 */
  function toggleCapsule(el, c) {
    c.capsule = !c.capsule;
    if (c.capsule) el.classList.add('capsule'); else el.classList.remove('capsule');
    var cap = el.querySelector('.cap');
    if (cap) { cap.textContent = c.capsule ? '▸' : '▾'; cap.title = c.capsule ? '展开' : '折叠'; }
    markRect();
    save();
  }

  function buildCell(c) {
    var el = document.createElement('div');
    el.className = 'cell' + (c.capsule ? ' capsule' : '');
    el.dataset.cellId = c.id;
    el.style.left = (c.x || 0) + 'px';
    el.style.top = (c.y || 0) + 'px';
    el.style.width = (c.w || 230) + 'px';
    el.style.height = (c.h || 220) + 'px';

    var head = document.createElement('div'); head.className = 't';
    var title = document.createElement('span'); title.textContent = c.title || '格子';
    var sp = document.createElement('span'); sp.className = 'sp';
    sp.textContent = (c.kind === 'link' ? 'LINK' : (c.kind === 'collect' ? 'BAG' : (c.dynamic === 'working' ? 'WORK' : 'DIR')));
    head.appendChild(title); head.appendChild(sp);
    var cap = document.createElement('span'); cap.className = 'cap';
    cap.textContent = c.capsule ? '▸' : '▾'; cap.title = c.capsule ? '展开' : '折叠';
    cap.onmousedown = function (ev) { ev.stopPropagation(); };
    cap.onclick = function (ev) { ev.stopPropagation(); toggleCapsule(el, c); };
    head.appendChild(cap);
    head.oncontextmenu = function (ev) { ev.preventDefault(); ev.stopPropagation(); cellMenuFor(c); };
    el.appendChild(head);

    var body = document.createElement('div'); body.className = 'b';
    el.appendChild(body);
    var acts = document.createElement('div'); acts.className = 'acts';
    el.appendChild(acts);

    if (c.kind === 'link') buildLink(c, body, acts);
    else if (c.kind === 'collect') buildCollect(c, body, acts);
    else buildFolder(c, body, acts);

    attachDragSelect(el, head, c);
    attachDrop(el, c);

    /* 右下角拖拽手柄: 改高度(保持宽 w 不变), 结束持久化 h 并重报矩形 */
    var grip = document.createElement('div'); grip.className = 'grip'; grip.title = '拖动改高度';
    el.appendChild(grip);
    attachResize(el, grip, c);

    el.addEventListener('mouseenter', function () { el.classList.add('hot'); burst(el); });
    el.addEventListener('mouseleave', function () { el.classList.remove('hot'); });

    cellObs.push(el); try { ro.observe(el); } catch (e) { /* ignore */ }
    return el;
  }

  function buildLink(c, body, acts) {
    var li = document.createElement('div'); li.className = 'it';
    var nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = (c.url || '(未设置)'); nm.title = c.url || '';
    li.appendChild(nm);
    li.onclick = function (ev) { ev.stopPropagation(); selectOnly(li); };
    li.ondblclick = function (ev) { ev.stopPropagation(); if (c.url) openPath(c.url); };
    li.oncontextmenu = function (ev) { ev.preventDefault(); ev.stopPropagation(); cellMenuFor(c); };
    body.appendChild(li);

    var sl = document.createElement('span'); sl.textContent = '设置链接';
    sl.onclick = function (ev) { ev.stopPropagation(); beginLinkEdit(c, li); };
    acts.appendChild(sl);
  }

  function density(n) { return n <= 8 ? 'd1' : (n <= 20 ? 'd2' : 'd3'); }   // 图标自适应: 少→大 多→小
  function buildFolder(c, body, acts) {
    var path = (c.dynamic === 'working') ? (workPath() || c.path) : c.path;
    var slot = document.createElement('div'); slot.className = 'empty'; slot.textContent = '读取中…';
    body.appendChild(slot);
    if (path && shell.fsList) {
      shell.fsList(path).then(function (r) {
        slot.className = ''; slot.textContent = '';
        if (!r || !r.ok) {
          var e = document.createElement('div'); e.className = 'empty';
          e.textContent = '无法读取：' + ((r && r.error) || '');
          slot.appendChild(e); markRect(); return;
        }
        var ents = r.entries || [];
        body.className = 'b ' + density(ents.length);
        ents.forEach(function (en) {
          var full = path + '\\' + en.name;
          slot.appendChild(listRow('it', en.name, en.isDir, full, function () { rowMenuFor(c, full); }));
        });
        if (!ents.length) { var e2 = document.createElement('div'); e2.className = 'empty'; e2.textContent = '（空文件夹）'; slot.appendChild(e2); }
        markRect();                          // 关键修复
      });
    } else { slot.textContent = (path ? '（无法读取，主进程未就绪）' : '（未设置文件夹）'); }

    var o = document.createElement('span'); o.textContent = '↗ 资源管理器';
    o.onclick = function (ev) { ev.stopPropagation(); if (path) shell.fsOpen(path); };
    var im = document.createElement('span'); im.textContent = '＋ 导入';
    im.onclick = function (ev) { ev.stopPropagation(); importInto(c); };
    acts.appendChild(o); acts.appendChild(im);
  }

  function buildCollect(c, body, acts) {
    var items = c.items || [];
    var slot = document.createElement('div'); slot.className = 'empty';
    body.appendChild(slot);
    if (!items.length) {
      slot.textContent = '（空 · 拖入文件/文件夹，或 ＋ 导入）';
    } else if (shell.fsListItems) {
      slot.textContent = '读取中…';
      shell.fsListItems(items).then(function (r) {
        slot.textContent = '';
        var arr = (r && r.items) || [];
        body.className = 'b ' + density(arr.length);
        arr.forEach(function (en) {
          var full = en.path;
          var it = listRow('it', en.name, en.isDir, full, function () { rowMenuFor(c, full); });
          if (en.missing) { it.style.opacity = '.5'; it.title = en.name + '（已失效）'; }
          slot.appendChild(it);
        });
        markRect();                          // 关键修复
      });
    } else { slot.textContent = '（主进程未就绪）'; }

    var im = document.createElement('span'); im.textContent = '＋ 导入';
    im.onclick = function (ev) { ev.stopPropagation(); importInto(c); };
    var cl = document.createElement('span'); cl.textContent = '清空';
    cl.onclick = function (ev) { ev.stopPropagation(); c.items = []; save(); renderAll(); };
    acts.appendChild(im); acts.appendChild(cl);
  }

  /* 头部拖动移动 + 未移动则单击选中 (阈值 3px) */
  function attachDragSelect(el, head, c) {
    head.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      if (ev.target && ev.target.tagName === 'INPUT') return;   // 重命名输入框不触发拖动
      shell.forceInteractive && shell.forceInteractive(true);
      var sx = ev.screenX, sy = ev.screenY, ox = c.x || 0, oy = c.y || 0, moved = false;
      function mv(e) {
        if (!moved && Math.abs(e.screenX - sx) < 3 && Math.abs(e.screenY - sy) < 3) return;
        moved = true;
        c.x = ox + (e.screenX - sx); c.y = oy + (e.screenY - sy);
        el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; markRect();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        shell.forceInteractive && shell.forceInteractive(false);
        if (moved) {
          c.x = Math.round((c.x || 0) / 10) * 10;      // 拖拽结束: 吸附 10px 网格
          c.y = Math.round((c.y || 0) / 10) * 10;
          el.style.left = c.x + 'px'; el.style.top = c.y + 'px';
          markRect();
          save();
        } else if (c.capsule) {
          toggleCapsule(el, c);                        // 折叠态: 点击头部整片即展开
        } else {
          selectOnly(el);                              // 未移动 = 单击选中格子
        }
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  /* 右下角手柄拖动改高度: 只改 h(像素), 保持 w 不变; 结束时 markRect + 持久化 */
  function attachResize(el, grip, c) {
    grip.addEventListener('mousedown', function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault(); ev.stopPropagation();
      shell.forceInteractive && shell.forceInteractive(true);
      var sy = ev.screenY, oh = (typeof c.h === 'number' && c.h > 0) ? c.h : 220;
      function mv(e) {
        var h = Math.max(120, Math.round(oh + (e.screenY - sy)));
        c.h = h; el.style.height = h + 'px';
        markRect();
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        shell.forceInteractive && shell.forceInteractive(false);
        markRect();          // 高度变了 → 必须重报交互矩形, 不能破坏穿透
        save();              // 持久化 h 到 state.json
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  /* 拖入投放: 依赖 preload 的 webUtils.getPathForFile (Electron 32+ 无 File.path) */
  function attachDrop(el, c) {
    el.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; el.classList.add('drop'); });
    el.addEventListener('dragleave', function () { el.classList.remove('drop'); });
    el.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('drop');
      var fl = e.dataTransfer && e.dataTransfer.files;
      if (!fl || !fl.length) return;
      var paths = [];
      for (var i = 0; i < fl.length; i++) {
        var p = shell.pathForFile ? shell.pathForFile(fl[i]) : '';
        if (p) paths.push(p);
      }
      if (!paths.length) { addLocalMsg('拖入失败：无法解析文件路径', 'err'); return; }
      appendToCollect(c, paths);
    });
  }
  function appendToCollect(c, paths) {
    if (c.kind !== 'collect') {
      c.kind = 'collect'; c.items = c.items || []; c.path = null; c.dynamic = null;
      addLocalMsg('已把「' + (c.title || '格子') + '」转为收纳格子，加入 ' + paths.length + ' 项', 'info');
    }
    var seen = {}; (c.items || []).forEach(function (p) { seen[p] = 1; });
    paths.forEach(function (p) { if (!seen[p]) { c.items.push(p); seen[p] = 1; } });
    save(); renderAll();
  }

  /* 导入: 原生菜单选 文件夹/文件; folder→镜像 or 追加到 collect; files→追加到 collect */
  function importInto(c) {
    if (!shell.cellImportChoose) return;
    shell.cellImportChoose().then(function (mode) {
      if (!mode) return;
      if (mode === 'folder') {
        shell.fsPick('folder').then(function (p) {
          if (!p) return;
          if (c.kind === 'collect') appendToCollect(c, [p]);
          else { c.kind = 'folder'; c.path = p; c.dynamic = null; c.items = null; save(); renderAll(); }
        });
      } else {
        shell.fsPick('files').then(function (ps) {
          if (!ps || !ps.length) return;
          appendToCollect(c, ps);
        });
      }
    });
  }

  /* 新建格子: 由 kind 直接创建 (右键菜单"新建格子"子菜单调用) */
  function createCell(kind) {
    if (!kind) return;
    var cells = S.cells || (S.cells = []);
    var base = cells.length ? cells[cells.length - 1] : { x: 120, y: 120 };
    var c = {
      id: 'c' + Date.now(), title: (kind === 'folder' ? '新建文件夹' : (kind === 'collect' ? '新建收纳' : '新建链接')),
      kind: kind, x: (base.x || 120) + 28, y: (base.y || 120) + 28, w: 230, h: 220,
    };
    if (kind === 'folder') { c.path = ''; }
    if (kind === 'collect') { c.items = []; }
    if (kind === 'link') { c.url = 'https://'; }
    cells.push(c); save(); renderAll();
  }

  /* 新建格子 (左下角 "＋ 新建格子" 按钮入口): 先弹原生菜单选类型 */
  function newCell() {
    if (!shell.cellNewChoose) return;
    shell.cellNewChoose().then(createCell);
  }

  /* 整理格子 (左下角 "▦ 整理" 按钮入口): 把非胶囊格子铺成规整网格。
     左上留 14px 边距; 右侧在 #rail 左缘(x=875, right:22 width:288)再退 14px 留缝; 列宽用格子默认宽 230。 */
  function tidyCells() {
    var cells = (S.cells || []).filter(function (c) { return !c.capsule; });
    if (!cells.length) return;
    var padL = 14, padT = 14, gap = 16, cw = 230;
    var railLeft = window.innerWidth - 22 - 288;
    var cols = Math.max(1, Math.floor((railLeft - 14 - padL + gap) / (cw + gap)));
    var i, j, y = padT;
    for (i = 0; i < cells.length; i += cols) {
      var row = cells.slice(i, i + cols), rowH = 0;
      for (j = 0; j < row.length; j++) rowH = Math.max(rowH, row[j].h || 220);
      for (j = 0; j < row.length; j++) { row[j].x = padL + j * (cw + gap); row[j].y = y; }
      y += rowH + gap;
    }
    save(); renderAll();
  }

  /* 就地重命名标题 (替代 window.prompt) */
  function startRename(c) {
    var el = document.querySelector('.cell[data-cell-id="' + c.id + '"]');
    if (!el) return;
    var head = el.querySelector('.t'); var title = head && head.querySelector('span');
    if (!head || !title) return;
    var inp = document.createElement('input'); inp.className = 'rn'; inp.value = c.title || '';
    head.replaceChild(inp, title); inp.focus(); inp.select();
    shell.forceInteractive && shell.forceInteractive(true);
    var done = false;
    function fin(commit) {
      if (done) return; done = true;
      shell.forceInteractive && shell.forceInteractive(false);
      if (commit) { var v = inp.value.trim(); if (v) c.title = v; }
      save(); renderAll();
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); fin(true); }
      else if (e.key === 'Escape') { e.preventDefault(); fin(false); }
    });
    inp.addEventListener('blur', function () { fin(true); });
    inp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  /* 就地编辑链接 */
  function beginLinkEdit(c, li) {
    var nm = li.querySelector('.nm');
    if (!nm) return;
    var inp = document.createElement('input'); inp.className = 'rn'; inp.value = c.url || 'https://';
    li.replaceChild(inp, nm); inp.focus(); inp.select();
    shell.forceInteractive && shell.forceInteractive(true);
    var done = false;
    function fin(commit) {
      if (done) return; done = true;
      shell.forceInteractive && shell.forceInteractive(false);
      if (commit) { var v = inp.value.trim(); if (v) c.url = v; }
      save(); renderAll();
    }
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); fin(true); }
      else if (e.key === 'Escape') { e.preventDefault(); fin(false); }
    });
    inp.addEventListener('blur', function () { fin(true); });
    inp.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  }

  /* 原生右键菜单结果回送 */
  function handleCellAction(a) {
    if (!a) return;
    var c = (S.cells || []).filter(function (x) { return x.id === a.cellId; })[0];
    if (!c) return;
    if (a.action === 'open') {
      var p = (a.target === 'row') ? a.rowPath : (c.kind === 'link' ? c.url : c.path);
      if (p) openPath(p);
    } else if (a.action === 'reveal') {
      var rp = (a.target === 'row') ? a.rowPath : c.path;
      if (rp && shell.fsReveal) shell.fsReveal(rp);
    } else if (a.action === 'rename') {
      startRename(c);
    } else if (a.action === 'delete') {
      S.cells = (S.cells || []).filter(function (x) { return x !== c; }); save(); renderAll();
    } else if (a.action === 'clear') {
      if (c.kind === 'collect') { c.items = []; save(); renderAll(); }
    } else if (a.action === 'eject') {
      if (a.target === 'row' && a.rowPath && Array.isArray(c.items)) {
        c.items = c.items.filter(function (p) { return p !== a.rowPath; });
        addLocalMsg('已移出格子：' + baseName(a.rowPath) + '（文件未删除）', 'info');
        save(); renderAll();
      }
    } else if (a.action === 'moveTo') {
      var tgt = (S.cells || []).filter(function (x) { return x.id === a.arg; })[0];
      if (tgt && a.rowPath && Array.isArray(c.items)) {
        c.items = c.items.filter(function (p) { return p !== a.rowPath; });
        tgt.items = tgt.items || [];
        if (tgt.items.indexOf(a.rowPath) < 0) tgt.items.push(a.rowPath);
        addLocalMsg('已转移「' + baseName(a.rowPath) + '」→ ' + (tgt.title || tgt.id), 'info');
        save(); renderAll();
      }
    } else if (a.action === 'new') {
      createCell(a.arg);
    }
  }

  /* ---------- 待办新增 ---------- */
  function addTodo() {
    var i = document.getElementById('tnew');
    var v = (i.value || '').trim();
    if (!v) return;
    S.todos.push({ id: 't' + Date.now(), text: v, working: false, done: false, path: '' });
    i.value = ''; save(); renderAll();
  }

  /* ---------- 光效 ---------- */
  var fx = document.getElementById('fx'), fc = fx.getContext('2d'), W, H, DPR, parts = [];
  function resizeF() {
    DPR = 1; W = window.innerWidth; H = window.innerHeight; // 粒子是柔光点, DPR=1 足够且填充率省 4 倍
    fx.width = W * DPR; fx.height = H * DPR; fx.style.width = W + 'px'; fx.style.height = H + 'px';
    fc.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function burst(el) {
    var r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, N = 36;
    for (var i = 0; i < N; i++) {
      var a = Math.random() * 6.2832, d = 100 + Math.random() * 180;
      parts.push({
        x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d,
        tx: r.left + Math.random() * r.width, ty: r.top + Math.random() * r.height,
        t: 0, life: 500 + Math.random() * 400,
        c: Math.random() < .5 ? '160,220,255' : '120,200,255', s: 0.8 + Math.random() * 1.7
      });
    }
    ensureAnim();          // 有粒子 → 确保动画循环在跑(空闲时它是停的)
  }
  function tickAnim() {
    fc.clearRect(0, 0, W, H); fc.globalCompositeOperation = 'lighter';
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i]; p.t += 16;
      var k = Math.min(1, p.t / p.life), e = 1 - Math.pow(1 - k, 3);
      var x = p.x + (p.tx - p.x) * e, y = p.y + (p.ty - p.y) * e, a = Math.sin(k * Math.PI);
      fc.fillStyle = 'rgba(' + p.c + ',' + (a * .9) + ')';
      fc.beginPath(); fc.arc(x, y, p.s * (1 - k * .4), 0, 6.2832); fc.fill();
      if (k >= 1) parts.splice(i, 1);
    }
    fc.globalCompositeOperation = 'source-over';
  }
  /* 粒子动画按需运行: 仅当有粒子时才排 rAF; 粒子清空 → 清一次屏后停(空闲时零 rAF 空转)。
     重启: burst() → ensureAnim()。 */
  var animating = false;
  function rafLoop() {
    if (parts.length) { tickAnim(); requestAnimationFrame(rafLoop); }
    else { animating = false; fc.clearRect(0, 0, W, H); }   // 最后一帧: 清屏并停
  }
  function ensureAnim() { if (!animating) { animating = true; requestAnimationFrame(rafLoop); } }

  /* ---------- 状态 ---------- */
  function save() { if (shell.setState) return shell.setState(S); }

  /* ---------- 启动 ---------- */
  function boot() {
    document.getElementById('tadd').onclick = addTodo;
    var tn = document.getElementById('tnew');
    tn.addEventListener('keydown', function (e) { if (e.key === 'Enter') addTodo(); });
    /* 消息格子: 搜索框 + 通知/搜索 标签 + 清空 + 右键动作回送 */
    var sn = document.getElementById('snew');
    if (sn) {
      sn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
      sn.addEventListener('focus', function () { shell.forceInteractive && shell.forceInteractive(true); });
      sn.addEventListener('blur', function () { shell.forceInteractive && shell.forceInteractive(false); });
    }
    var sb2 = document.getElementById('sbtn'); if (sb2) sb2.onclick = function (e) { e.stopPropagation(); doSearch(); };
    var mts = document.querySelectorAll('.mtab');
    for (var mi = 0; mi < mts.length; mi++) mts[mi].onclick = function (e) { e.stopPropagation(); msgsTab = this.getAttribute('data-mt'); renderMsgs(); markRect(); };
    var mc = document.getElementById('mclear'); if (mc) mc.onclick = function (e) {
      e.stopPropagation();
      S.messages = (S.messages || []).filter(function (m) { return (msgsTab === 'search') ? (m.kind !== 'search') : (m.kind === 'search'); });
      save(); renderAll();
    };
    if (shell.onMsgAction) shell.onMsgAction(function (a) {
      if (!a) return;
      if (a.action === 'reveal') { if (a.path && shell.fsReveal) shell.fsReveal(a.path); }
      else if (a.action === 'file') { pickIntoCell(a.path); }
      else if (a.action === 'del') { S.messages = (S.messages || []).filter(function (m) { return m.time !== a.id; }); save(); renderAll(); }
    });
    tn.addEventListener('focus', function () { shell.forceInteractive && shell.forceInteractive(true); });
    tn.addEventListener('blur', function () { shell.forceInteractive && shell.forceInteractive(false); });
    document.getElementById('quit').onclick = function () { shell.quit && shell.quit(); };
    document.getElementById('wkopen').onclick = function () { if (activeTodo()) shell.fsOpen(workPath()); };
    document.getElementById('wkref').onclick = function () { renderWork(); };   // 刷新=重绘(工作态→文件夹 / 空闲态→快捷方式); 拾光卡已停用
    var ca = document.getElementById('celladd');
    if (ca) ca.onclick = function () { newCell(); };
    var ct = document.getElementById('celltidy');
    if (ct) ct.onclick = function () { tidyCells(); };
    window.addEventListener('resize', function () { resizeF(); markRect(); });

    // 点击面板空白 / 非格子区域 → 清除选中 (桌面空白处优先穿透, 不会到这里)
    document.addEventListener('mousedown', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest('.cell') && !t.closest('.panel')) clearSel();
    });

    if (shell.onState) shell.onState(function (s) { S = s; renderAll(); applySkyState(); });
    if (shell.onCellAction) shell.onCellAction(handleCellAction);

    observeRail();
    bindConsole();

    (shell.getState ? shell.getState() : Promise.reject()).then(function (s) {
      S = s; renderAll(); applySkyState();
    }).catch(function () {
      S = { version: 4, cells: [], todos: [], messages: [{ time: Date.now(), level: 'err', text: '无法读取状态(主进程未就绪)' }], sky: { obs: { lat: 28.23, lon: 112.94, city: '长沙' }, track: null } };
      renderAll(); applySkyState();
    });

    resizeF(); markRect();               // 不再常驻 rAF: 粒子动画由 burst() 按需启动
  }
  boot();
})();

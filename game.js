/* ============================================================
   game.js —— 《合成大一中》游戏逻辑
   包含：自研物理（PBD 位置约束求解）、Canvas 渲染、
        合成/爆炸/复活币/判负、音效（实时合成，无音频文件）、
        本地排行榜与昵称存档
   换皮不用改这里，请改 config.js
   ============================================================ */

(function () {
  'use strict';

  const CFG = window.SKIN || (typeof SKIN !== 'undefined' ? SKIN : null);
  if (!CFG) {
    document.body.innerHTML =
      '<div style="padding:40px;font-size:18px;line-height:1.8;text-align:center">' +
      '没有读到 config.js 里的配置<br>请确认 config.js 和 index.html 在同一个文件夹</div>';
    throw new Error('SKIN 配置缺失');
  }
  const LVS = CFG.levels;
  const TOP = LVS.length - 1;
  const RULE = CFG.rule;

  /* ---------------- 常量：棋盘设计尺寸（420 × 700）---------------- */
  const W = 420, H = 700, WALL = 7;
  const FLOOR = H - WALL;
  const DROP_Y = 86;                    // 投放位置（当前这颗画在这儿）
  const DANGER_Y = RULE.dangerY;        // 警戒线
  const OVER_LIMIT = RULE.overLimit;    // 越线累计多少秒判负
  const REST_SPEED = RULE.restSpeed;    // 低于这个速度才算「卡住了」
  const G = RULE.gravity;
  const SUB = 3, ITER = 6;              // 子步 / 迭代
  const E_BALL = 0.38, E_WALL = 0.45;   // 弹性
  const REST_TH = 55;                   // 撞速低于此值不反弹
  const FRICTION = 0.955;               // 切向摩擦
  const MERGE_PAD = 0.8;                // 合成接触容差
  const DROP_MS = RULE.dropInterval;
  const COIN_EVERY = RULE.coinEvery;
  const BLAST_SCORE = RULE.topBlastScore;
  const ASSET_FILL = (CFG.photos && CFG.photos.fill) || 0.92;  // 贴图主体占画布比例（config.js 里可调）
  const SPAWN_WEIGHTS = [0.28, 0.24, 0.20, 0.16, 0.12];
  const AVOID_REPEAT = true;

  /* ---------------- 存档键 ---------------- */
  const LS = {
    best: 'dyz.best',
    mute: 'dyz.mute',
    name: 'dyz.name',
    list: 'dyz.leaderboard',
  };

  /* ---------------- 页面元素 ---------------- */
  const cvs = document.getElementById('board');
  const ctx = cvs.getContext('2d');
  const stage = document.getElementById('stage');
  const nextCvs = document.getElementById('next');
  const nctx = nextCvs.getContext('2d');

  const $ = function (id) { return document.getElementById(id); };
  const uiScore = $('uiScore'), uiBest = $('uiBest'), uiCoins = $('uiCoins');
  const maskRevive = $('maskRevive'), maskOver = $('maskOver');
  const maskRank = $('maskRank'), maskSponsor = $('maskSponsor');

  /* ---------------- 工具 ---------------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function readNum(key, def) {
    const v = parseInt(localStorage.getItem(key) || '', 10);
    return isNaN(v) ? def : v;
  }

  function parseColor(c) {
    const s = String(c || '').trim();
    let m = /^#?([0-9a-f]{6})$/i.exec(s);
    if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
    m = /^#?([0-9a-f]{3})$/i.exec(s);
    if (m) { const t = m[1]; return [parseInt(t[0] + t[0], 16), parseInt(t[1] + t[1], 16), parseInt(t[2] + t[2], 16)]; }
    return [200, 200, 200];
  }

  function mix(rgb, target, amt) {
    return 'rgb(' + Math.round(rgb[0] + (target - rgb[0]) * amt) + ',' +
      Math.round(rgb[1] + (target - rgb[1]) * amt) + ',' +
      Math.round(rgb[2] + (target - rgb[2]) * amt) + ')';
  }

  /* ---------------- 贴图加载（失败自动重试 3 次，再失败就用程序化图形）---------------- */
  const sprites = LVS.map(function (lv) {
    if (!lv.img) return { ok: false, el: null, tries: 0 };
    const s = { ok: false, el: null, tries: 0, src: lv.img };
    loadSprite(s);
    return s;
  });

  function loadSprite(s) {
    if (!s.src || s.tries >= 3) return;
    s.tries++;
    const el = new Image();
    el.onload = function () { s.ok = true; s.el = el; };
    el.onerror = function () { setTimeout(function () { loadSprite(s); }, 400); };
    el.src = s.src;
  }

  function ready(s) { return s && s.ok && s.el && s.el.complete && s.el.naturalWidth > 0; }

  /* ---------------- 音效：WebAudio 实时合成，不需要音频文件 ---------------- */
  let actx = null;
  let muted = localStorage.getItem(LS.mute) === '1' || CFG.audio.startMuted;

  function ensureAudio() {
    if (actx) return actx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { actx = new AC(); } catch (e) { actx = null; }
    return actx;
  }

  function beep(freq, freq2, dur, type, vol) {
    if (muted) return;
    const a = ensureAudio();
    if (!a) return;
    if (a.state === 'suspended' && a.resume) a.resume();
    try {
      const o = a.createOscillator(), g = a.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, a.currentTime);
      if (freq2 && freq2 !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq2), a.currentTime + dur);
      g.gain.setValueAtTime(vol || 0.12, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination);
      o.start(); o.stop(a.currentTime + dur + 0.02);
    } catch (e) { /* 忽略 */ }
  }

  function noise(dur, vol) {
    if (muted) return;
    const a = ensureAudio();
    if (!a) return;
    try {
      const len = Math.floor(a.sampleRate * dur);
      const buf = a.createBuffer(1, len, a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = a.createBufferSource(); src.buffer = buf;
      const g = a.createGain(); g.gain.value = vol || 0.15;
      src.connect(g); g.connect(a.destination);
      src.start();
    } catch (e) { /* 忽略 */ }
  }

  function buzz(ms) {
    if (muted) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 游戏状态 ---------------- */
  let balls = [];
  let parts = [];
  let pops = [];
  let score = 0;
  let best = readNum(LS.best, 0);
  let blastCoins = 0;      // 爆炸得到的复活币
  let spentCoins = 0;      // 已用掉的复活币
  let state = 'play';      // play | revive | over
  let cur = 0, nxt = 0;
  let aimX = W / 2;
  let lastDropAt = -1e9;
  let nowMs = 0;

  function coins() {
    return Math.floor(score / COIN_EVERY) + blastCoins - spentCoins;
  }

  function getNick() {
    let n = localStorage.getItem(LS.name) || '';
    n = String(n).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
    return n || '默认用户';
  }

  function setNick(v) {
    const n = String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
    localStorage.setItem(LS.name, n);
    return getNick();
  }

  /* ---------------- 生成 / 移除 ---------------- */
  function addBall(x, y, lv, vy) {
    const r = LVS[lv].r;
    const b = {
      x: x, y: y, px: x, py: y, vx: 0, vy: vy || 0,
      r: r, lv: lv, iw: 1 / (r * r),
      landed: false, overTime: 0, dead: false, merged: false,
      bornAt: nowMs, sx: 1, sy: 1,
    };
    balls.push(b);
    return b;
  }

  function weightedSpawn() {
    const n = Math.min(SPAWN_WEIGHTS.length, LVS.length);
    let t = 0;
    for (let i = 0; i < n; i++) t += SPAWN_WEIGHTS[i];
    let x = Math.random() * t;
    for (let i = 0; i < n; i++) { x -= SPAWN_WEIGHTS[i]; if (x <= 0) return i; }
    return 0;
  }

  function rollNext() {
    let n = weightedSpawn();
    if (AVOID_REPEAT && n === cur) n = weightedSpawn();
    return n;
  }

  function removeBall(b) { b.dead = true; }

  /* ---------------- 物理：PBD 位置约束求解 ---------------- */
  let contacts = [];
  let wallHits = [];

  function solvePairPos(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const s = a.r + b.r;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) d = 1e-6;
    if (d >= s) return;
    const nx = dx / d, ny = dy / d;
    const w = a.iw + b.iw;
    const k = (s - d) / w;
    a.x -= nx * k * a.iw; a.y -= ny * k * a.iw;
    b.x += nx * k * b.iw; b.y += ny * k * b.iw;
    a.landed = true; b.landed = true;
  }

  function solveWallPos(b) {
    if (b.y + b.r > FLOOR) { b.y = FLOOR - b.r; b.landed = true; }
    if (b.x - b.r < WALL) { b.x = WALL + b.r; b.landed = true; }
    if (b.x + b.r > W - WALL) { b.x = W - WALL - b.r; b.landed = true; }
  }

  function collectContacts(pairs, hits) {
    pairs.length = 0; hits.length = 0;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= a.r + b.r + 2) continue;
        const nx = d < 1e-6 ? 0 : dx / d, ny = d < 1e-6 ? -1 : dy / d;
        const v0 = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        pairs.push({ a: a, b: b, v0: v0 });
      }
      /* 地面 / 左右墙 */
      if (a.y + a.r > FLOOR - 0.5) hits.push({ b: a, ax: 1, sign: -1, v0: a.vy });
      else if (a.x - a.r < WALL + 0.5) hits.push({ b: a, ax: 0, sign: 1, v0: a.vx });
      else if (a.x + a.r > W - WALL - 0.5) hits.push({ b: a, ax: 0, sign: -1, v0: a.vx });
    }
  }

  function applyRestitution(pairs, hits) {
    /* 球与球：回弹 + 切向摩擦 */
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i], a = p.a, b = p.b;
      if (a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) d = 1e-6;
      const nx = dx / d, ny = dy / d;
      const w = a.iw + b.iw;

      const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
      const vn = rvx * nx + rvy * ny;
      if (p.v0 < -REST_TH) {
        const jn = (-E_BALL * p.v0 - vn) / w;
        a.vx -= nx * jn * a.iw; a.vy -= ny * jn * a.iw;
        b.vx += nx * jn * b.iw; b.vy += ny * jn * b.iw;
        /* 撞击挤压变形 */
        const power = Math.min(0.3, (-p.v0) / 2400);
        if (power > 0.02) {
          a.sx = Math.min(1.3, a.sx + power * (Math.abs(ny)));
          a.sy = Math.min(1.3, a.sy + power * (Math.abs(nx)));
          b.sx = Math.min(1.3, b.sx + power * (Math.abs(ny)));
          b.sy = Math.min(1.3, b.sy + power * (Math.abs(nx)));
        }
      }
      const tx = -ny, ty = nx;
      const vt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
      const jt = (vt * FRICTION - vt) / w;
      a.vx -= tx * jt * a.iw; a.vy -= ty * jt * a.iw;
      b.vx += tx * jt * b.iw; b.vy += ty * jt * b.iw;
    }

    /* 球与墙 / 地面 */
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i], b = h.b;
      if (b.dead) continue;
      if (-h.sign * h.v0 > REST_TH) {
        const nv = -E_WALL * h.v0;
        if (h.ax === 1) b.vy = nv; else b.vx = nv;
        const power = Math.min(0.3, Math.abs(h.v0) / 2400);
        if (power > 0.02) {
          if (h.ax === 1) { b.sx = Math.min(1.3, b.sx + power); b.sy = Math.max(0.7, b.sy - power * 0.4); }
          else { b.sy = Math.min(1.3, b.sy + power); b.sx = Math.max(0.7, b.sx - power * 0.4); }
        }
      }
      /* 墙面摩擦 */
      const other = h.ax === 1 ? 0 : 1;
      if (other === 0) b.vx *= FRICTION; else b.vy *= FRICTION;
    }
  }

  function detectMerges() {
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.merged || a.dead) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.merged || b.dead) continue;
        if (a.lv !== b.lv) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= a.r + b.r + MERGE_PAD) {
          a.merged = true; b.merged = true;
          mergeQueue.push([a, b]);
        }
      }
    }
  }

  function stepPhysics(dt) {
    const h = dt / SUB;
    for (let s = 0; s < SUB; s++) {
      let i, j;
      for (i = 0; i < balls.length; i++) {
        const b = balls[i];
        b.px = b.x; b.py = b.y;
        b.vy += G * h;
        b.x += b.vx * h;
        b.y += b.vy * h;
      }

      collectContacts(contacts, wallHits);

      for (let it = 0; it < ITER; it++) {
        for (i = 0; i < balls.length; i++) {
          const a = balls[i];
          for (j = i + 1; j < balls.length; j++) solvePairPos(a, balls[j]);
        }
        for (i = 0; i < balls.length; i++) solveWallPos(balls[i]);
        if (it === 0) detectMerges();
      }

      /* 速度由位置差反推 */
      for (i = 0; i < balls.length; i++) {
        const b = balls[i];
        b.vx = (b.x - b.px) / h;
        b.vy = (b.y - b.py) / h;
      }

      applyRestitution(contacts, wallHits);
    }
  }

  /* ---------------- 合成处理 ---------------- */
  const mergeQueue = [];

  function addParts(x, y, lv, n, strong) {
    const cfg = LVS[lv];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (strong ? 120 : 60) + Math.random() * (strong ? 260 : 140);
      parts.push({
        x: x, y: y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60,
        r: (strong ? 3 : 2) + Math.random() * 3,
        life: 0.5 + Math.random() * 0.5, age: 0,
        c: Math.random() < 0.5 ? (cfg.pc1 || cfg.c1) : (cfg.pc2 || cfg.c2),
      });
    }
  }

  function addPop(x, y, text, color, size) {
    pops.push({ x: x, y: y, text: text, color: color, size: size, age: 0, life: 0.9 });
  }

  function processMerges() {
    while (mergeQueue.length) {
      const pair = mergeQueue.shift();
      const a = pair[0], b = pair[1];
      if (a.dead || b.dead) continue;
      const lv = a.lv;
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;

      removeBall(a); removeBall(b);
      balls = balls.filter(function (t) { return !t.dead; });

      if (lv >= TOP) {
        /* 两个最高级撞一起：一起炸掉，加 500 分 + 一枚复活币 */
        score += BLAST_SCORE;
        blastCoins += 1;
        addParts(cx, cy, TOP, 26, true);
        addPop(cx, cy - 18, '+' + BLAST_SCORE, '#e2543f', 32);
        addPop(cx, cy + 22, '💥 爆炸！+1 枚复活币', '#7a4520', 20);
        beep(180, 60, 0.32, 'square', 0.14);
        noise(0.3, 0.18);
        buzz(60);
      } else {
        const nl = lv + 1;
        score += LVS[nl].score;
        const nb = addBall(cx, cy, nl, -1);
        nb.sx = 1.25; nb.sy = 0.75;
        addParts(cx, cy, nl, 10 + nl * 2, false);
        addPop(cx, cy - 16, '+' + LVS[nl].score, '#e2543f', 28);
        addPop(cx, cy + 20, LVS[nl].name, '#7a4520', 20);
        beep(320 + nl * 45, 520 + nl * 60, 0.14, 'triangle', 0.1);
        buzz(12 + nl * 2);
      }
      updateHud();
    }
  }

  /* ---------------- 判负规则 ---------------- */
  function checkOverflow(dt) {
    const rs2 = REST_SPEED * REST_SPEED;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead || !b.landed) continue;
      const sp2 = b.vx * b.vx + b.vy * b.vy;
      if (b.y - b.r < DANGER_Y) {
        if (sp2 < rs2) {
          b.overTime += dt;
          if (b.overTime > OVER_LIMIT) { gameOver(); return; }
        } else {
          b.overTime -= dt * 2;
        }
      } else {
        b.overTime -= dt * 2;
      }
      if (b.overTime < 0) b.overTime = 0;
    }
  }

  function gameOver() {
    if (state !== 'play') return;
    state = 'revive';
    if (score > best) {
      best = score;
      localStorage.setItem(LS.best, String(best));
    }
    updateHud();
    beep(420, 90, 0.5, 'sawtooth', 0.12);
    $('rvScore').textContent = score;
    const c = coins();
    $('rvCoinLeft').textContent = '还剩 ' + c + ' 枚';
    const btn = $('btnRevive');
    btn.disabled = c <= 0;
    btn.style.opacity = c <= 0 ? '0.45' : '1';
    show(maskRevive, true);
  }

  function settle() {
    state = 'over';
    $('ovScore').textContent = score;
    $('ovBest').textContent = best;
    $('ovNick').textContent = getNick();
    $('ovState').textContent = '正在结算…';
    $('btnRetry').classList.add('hidden');
    show(maskOver, true);
    setTimeout(function () { submitScore(); }, 320);
  }

  /* ---------------- 本地排行榜（不需要服务器，数据存在本机）---------------- */
  function loadList() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS.list) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function submitScore() {
    if (score <= 0) {
      $('ovState').textContent = '0 分不上榜';
      return;
    }
    try {
      const arr = loadList();
      arr.unshift({ n: getNick(), s: score, t: Date.now() });
      const trimmed = arr.slice(0, 20);
      localStorage.setItem(LS.list, JSON.stringify(trimmed));
      $('ovState').textContent = '已记录到本机榜单 🎉';
      $('btnRetry').classList.add('hidden');
    } catch (e) {
      $('ovState').textContent = '提交失败';
      $('btnRetry').classList.remove('hidden');
    }
  }

  function renderList() {
    const arr = loadList().slice();
    arr.sort(function (a, b) { return (b.s || 0) - (a.s || 0); });
    const ol = $('rankList');
    ol.textContent = '';
    if (!arr.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有记录，先玩一局吧～';
      ol.appendChild(li);
      return;
    }
    arr.forEach(function (it, i) {
      const li = document.createElement('li');
      const no = document.createElement('span'); no.className = 'no'; no.textContent = '#' + (i + 1);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.n || '默认用户';
      const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = it.s || 0;
      li.appendChild(no); li.appendChild(nm); li.appendChild(sc);
      ol.appendChild(li);
    });
  }

  /* ---------------- 投放 ---------------- */
  function tryDrop() {
    if (state !== 'play') return;
    if (nowMs - lastDropAt < DROP_MS) return;
    const r = LVS[cur].r;
    const x = clamp(aimX, WALL + r + 1, W - WALL - r - 1);
    addBall(x, DROP_Y, cur, 1);
    lastDropAt = nowMs;
    cur = nxt;
    nxt = rollNext();
    drawNext();
    beep(560, 380, 0.09, 'sine', 0.09);
  }

  function reviveGame() {
    if (coins() <= 0) return;
    /* 清掉警戒线以上（含压线）的所有水果 */
    balls = balls.filter(function (b) { return (b.y - b.r) >= DANGER_Y - 6; });
    balls.forEach(function (b) { b.overTime = 0; });
    spentCoins += 1;
    state = 'play';
    lastDropAt = nowMs - DROP_MS;
    show(maskRevive, false);
    updateHud();
    beep(300, 620, 0.22, 'triangle', 0.12);
  }

  function resetGame() {
    balls = []; parts = []; pops = []; mergeQueue.length = 0;
    score = 0; blastCoins = 0; spentCoins = 0;
    cur = weightedSpawn();
    nxt = rollNext();
    state = 'play';
    lastDropAt = -1e9;
    show(maskRevive, false);
    show(maskOver, false);
    updateHud();
    drawNext();
  }

  /* ---------------- 绘制 ---------------- */
  function drawFruit(g, lv, cx, cy, r) {
    const s = sprites[lv];
    if (ready(s)) {
      const box = (r * 2) / ASSET_FILL;
      g.save();
      if (CFG.photos.clipCircle) {
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.closePath();
        g.clip();
      }
      g.drawImage(s.el, cx - box / 2, cy - box / 2, box, box);
      g.restore();
      return;
    }
    /* 兜底：程序化小圆球（带表情） */
    const cfg = LVS[lv];
    const base = parseColor(cfg.c2 || '#cccccc');
    const light = parseColor(cfg.c1 || '#ffffff');
    const grd = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.05);
    grd.addColorStop(0, mix(light, 255, 0.35));
    grd.addColorStop(0.6, 'rgb(' + base[0] + ',' + base[1] + ',' + base[2] + ')');
    grd.addColorStop(1, mix(base, 0, 0.22));
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = grd;
    g.fill();
    g.lineWidth = Math.max(1, r * 0.06);
    g.strokeStyle = mix(base, 0, 0.3);
    g.stroke();
    if (r > 10) {
      const ey = cy - r * 0.12, ex = r * 0.3, er = Math.max(1, r * 0.1);
      g.fillStyle = 'rgba(60,35,20,0.75)';
      g.beginPath(); g.arc(cx - ex, ey, er, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(cx + ex, ey, er, 0, Math.PI * 2); g.fill();
      g.beginPath();
      g.arc(cx, cy + r * 0.12, r * 0.3, 0.15 * Math.PI, 0.85 * Math.PI);
      g.lineWidth = Math.max(1, r * 0.08);
      g.strokeStyle = 'rgba(60,35,20,0.6)';
      g.stroke();
    }
  }

  function drawBoard() {
    const B = CFG.board;
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, B.bgTop);
    grd.addColorStop(1, B.bgBottom);
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);

    /* 四条边 */
    const rBot = 24;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W, 0);
    ctx.lineTo(W, FLOOR + WALL - rBot);
    ctx.quadraticCurveTo(W, FLOOR + WALL, W - rBot, FLOOR + WALL);
    ctx.lineTo(rBot, FLOOR + WALL);
    ctx.quadraticCurveTo(0, FLOOR + WALL, 0, FLOOR + WALL - rBot);
    ctx.closePath();
    ctx.fillStyle = B.wallColor;
    ctx.fill();

    ctx.fillStyle = B.innerColor;
    ctx.fillRect(WALL, 0, W - WALL * 2, FLOOR);

    /* 警戒线 */
    ctx.save();
    ctx.setLineDash([12, 10]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = B.dangerColor;
    ctx.beginPath();
    ctx.moveTo(WALL, DANGER_Y);
    ctx.lineTo(W - WALL, DANGER_Y);
    ctx.stroke();
    ctx.restore();
    if (B.dangerLabel) {
      ctx.save();
      ctx.font = '600 11px system-ui, "PingFang SC", sans-serif';
      ctx.fillStyle = B.dangerColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(B.dangerLabel, WALL + 6, DANGER_Y - 4);
      ctx.restore();
    }
  }

  function drawBalls() {
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.scale(b.sx, b.sy);
      drawFruit(ctx, b.lv, 0, 0, b.r);
      ctx.restore();
      /* 挤压回弹：慢慢回到原样 */
      b.sx += (1 - b.sx) * 0.16;
      b.sy += (1 - b.sy) * 0.16;
    }
  }

  function drawAim() {
    if (state !== 'play' && state !== 'revive') return;
    const r = LVS[cur].r;
    const x = clamp(aimX, WALL + r + 1, W - WALL - r - 1);
    const okNow = (nowMs - lastDropAt >= DROP_MS);
    ctx.save();
    ctx.setLineDash([7, 11]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = okNow ? 'rgba(122,69,32,0.35)' : 'rgba(122,69,32,0.15)';
    ctx.beginPath();
    ctx.moveTo(x, DROP_Y + r + 4);
    ctx.lineTo(x, FLOOR - 4);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = okNow ? 1 : 0.4;
    drawFruit(ctx, cur, x, DROP_Y, r);
    ctx.restore();
  }

  function drawParts(dt) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age >= p.life) { parts.splice(i, 1); continue; }
      p.vy += 900 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.save();
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPops(dt) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) { pops.splice(i, 1); continue; }
      const y = p.y - t * 60;
      ctx.globalAlpha = 1 - t * t;
      ctx.font = '800 ' + p.size + 'px system-ui, "PingFang SC", sans-serif';
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, y);
    }
    ctx.restore();
  }

  function drawNext() {
    nctx.clearRect(0, 0, nextCvs.width, nextCvs.height);
    const size = nextCvs.width;
    const r = Math.min(size * 0.42, size / ASSET_FILL * 0.42);
    drawFruit(nctx, nxt, size / 2, size / 2, r);
  }

  function render(dt) {
    ctx.clearRect(0, 0, W, H);
    drawBoard();
    drawBalls();
    drawParts(dt);
    drawAim();
    drawPops(dt);
  }

  /* ---------------- 画布自适应 ---------------- */
  let lastCssW = 0;
  function fitCanvas() {
    const rect = cvs.getBoundingClientRect();
    if (!rect.width) return;
    lastCssW = rect.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = (rect.width / W) * dpr;
    cvs.width = Math.round(W * s);
    cvs.height = Math.round(H * s);
    ctx.setTransform(s, 0, 0, s, 0, 0);
  }

  /* ---------------- 信息栏 / 合成表 ---------------- */
  function updateHud() {
    uiScore.textContent = score;
    uiBest.textContent = best;
    uiCoins.textContent = '🪙×' + coins();
  }

  function buildChart() {
    const box = $('chartList');
    box.textContent = '';
    LVS.forEach(function (lv, i) {
      if (i > 0) {
        const ar = document.createElement('span');
        ar.className = 'chart-arrow';
        ar.textContent = '›';
        box.appendChild(ar);
      }
      const item = document.createElement('div');
      item.className = 'chart-item';
      const c = document.createElement('canvas');
      c.width = 68; c.height = 68;
      const g = c.getContext('2d');
      item.appendChild(c);
      const nm = document.createElement('span');
      nm.textContent = lv.name;
      item.appendChild(nm);
      box.appendChild(item);
      drawChartIcon(g, i, 30);
    });
    $('chartTip').innerHTML = '✨ ' + CFG.text.topBlastTip.replace('{TOP}', LVS[TOP].name);
  }

  function drawChartIcon(g, lv, r) {
    g.clearRect(0, 0, 68, 68);
    drawFruit(g, lv, 34, 34, r);
  }

  /* ---------------- 弹窗开关 ---------------- */
  function show(el, on) {
    if (on) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }

  /* ---------------- 输入：鼠标 / 触屏 / 键盘 ---------------- */
  function aimAt(clientX) {
    const rect = cvs.getBoundingClientRect();
    aimX = clamp((clientX - rect.left) / rect.width * W, WALL + 6, W - WALL - 6);
  }

  stage.addEventListener('pointerdown', function (e) {
    ensureAudio();
    aimAt(e.clientX);
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    if (e.pointerType !== 'touch') tryDrop();   // 鼠标：按下即投放
  });

  stage.addEventListener('pointermove', function (e) {
    aimAt(e.clientX);
  });

  stage.addEventListener('pointerup', function (e) {
    if (e.pointerType === 'touch') { aimAt(e.clientX); tryDrop(); }  // 触屏：松手才投放
  });

  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;   // 输入框里不抢按键
    if (e.code === 'ArrowLeft') { aimX = clamp(aimX - 8, WALL + 6, W - WALL - 6); e.preventDefault(); }
    if (e.code === 'ArrowRight') { aimX = clamp(aimX + 8, WALL + 6, W - WALL - 6); e.preventDefault(); }
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (state === 'play') tryDrop();
    }
    if (e.code === 'KeyR') { resetGame(); }
  });

  /* 按钮 */
  $('btnRestart').addEventListener('click', function () { resetGame(); });
  $('btnAgain').addEventListener('click', function () { resetGame(); });
  $('btnGiveUp').addEventListener('click', function () { show(maskRevive, false); settle(); });
  $('btnRevive').addEventListener('click', function () { reviveGame(); });
  $('btnRetry').addEventListener('click', function () { submitScore(); });
  $('btnEditNick').addEventListener('click', function () {
    $('rankNick').value = localStorage.getItem(LS.name) || '';
    renderList();
    show(maskRank, true);
    setTimeout(function () { $('rankNick').focus(); }, 60);
  });

  $('btnRank').addEventListener('click', function () { $('rankNick').value = localStorage.getItem(LS.name) || ''; renderList(); show(maskRank, true); });
  $('btnRank2').addEventListener('click', function () { $('rankNick').value = localStorage.getItem(LS.name) || ''; renderList(); show(maskRank, true); });
  $('btnRankClose').addEventListener('click', function () { show(maskRank, false); });

  $('btnSound').addEventListener('click', function () {
    muted = !muted;
    localStorage.setItem(LS.mute, muted ? '1' : '0');
    $('btnSound').textContent = muted ? '🔇音效关' : '🔊音效开';
    if (!muted) beep(520, 700, 0.1, 'sine', 0.1);
  });

  $('btnSponsor').addEventListener('click', function () { show(maskSponsor, true); });
  $('btnSponsorClose').addEventListener('click', function () { show(maskSponsor, false); });

  [$('uiNick'), $('rankNick')].forEach(function (inp) {
    const save = function () {
      const n = setNick(inp.value);
      inp.value = n === '默认用户' ? '' : n;
      $('ovNick').textContent = n;
      if (inp === $('uiNick')) $('rankNick').value = inp.value;
      else $('uiNick').value = inp.value;
    };
    inp.addEventListener('change', save);
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', function (e) { if (e.code === 'Enter') { save(); inp.blur(); } });
  });

  /* ---------------- 初始化界面文字 ---------------- */
  document.title = CFG.text.title;
  $('uiTitle').textContent = CFG.text.title;
  $('uiTips').textContent = CFG.text.operateTip;
  $('uiNick').value = localStorage.getItem(LS.name) || '';
  $('rankNick').value = $('uiNick').value;
  $('btnSound').textContent = muted ? '🔇音效关' : '🔊音效开';
  if (CFG.sponsor.qr) $('spQr').src = CFG.sponsor.qr;
  if (CFG.sponsor.foot) $('spFoot').textContent = CFG.sponsor.foot;
  if (CFG.sponsor.text) $('spText').innerHTML = CFG.sponsor.text;

  const TH = CFG.theme;
  if (TH.pageBgTop && TH.pageBgBottom) {
    document.body.style.background = 'linear-gradient(180deg,' + TH.pageBgTop + ' 0%, ' + TH.pageBgBottom + ' 100%)';
  }

  /* ---------------- 主循环 ---------------- */
  let last = 0;
  function loop(t) {
    requestAnimationFrame(loop);
    nowMs = t;
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    if (dt > 0.05) dt = 0.05;
    if (dt <= 0) dt = 1 / 60;

    if (cvs.getBoundingClientRect().width !== lastCssW) fitCanvas();

    if (state === 'play') {
      stepPhysics(dt);
      processMerges();
      checkOverflow(dt);
    }
    render(dt);
  }

  /* ---------------- 启动 ---------------- */
  fitCanvas();
  buildChart();
  resetGame();
  updateHud();
  requestAnimationFrame(loop);

  /* 图片是异步加载的，加载完刷新一下图标和「下一个」 */
  let refreshTimes = 0;
  const refreshTimer = setInterval(function () {
    if (refreshTimes++ > 15) { clearInterval(refreshTimer); return; }
    buildChart();
    drawNext();
  }, 400);

  /* 调试用（控制台可输入） */
  window.__SUIKA__ = {
    state: function () { return { score: score, balls: balls.length, state: state, coins: coins() }; },
    reset: resetGame,
    drop: tryDrop,
    levels: LVS,
  };

})();

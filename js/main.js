/* 승강급 장기 화면 · 진행 */
(function () {
  'use strict';

  const J = window.Janggi;
  const R = window.JanggiRanks;

  // 판 좌표: 교차점 간격 100, 바깥 여백 52 (viewBox 904 × 1004)
  const S = 100;
  const M = 52;
  const W = M * 2 + S * 8;
  const H = M * 2 + S * 9;

  const MAIN_TIME = 300;   // 기본 시간 5분
  const BYO_TIME = 30;     // 초읽기 30초
  const BYO_COUNT = 3;     // 초읽기 3회
  const MOVE_LIMIT = 200;  // 200수가 되면 점수로 승부
  const SETUP_SECONDS = 20;
  const ITEM_LIMIT = { undo: 3, hint: 3 };
  const STORE_KEY = 'janggi.profile.v1';

  const RADIUS = { K: 46, R: 40, C: 40, H: 40, E: 40, A: 30, P: 30 };
  const SETUP_NAMES = Object.keys(J.SETUPS);
  const OPP_NAMES = ['Deplomat', '차포떼고', '궁성지기', '포격수', '외통수', '멍군장군', '초한지', '묘수풀이', '한수위', '졸병일호', '명국사냥꾼', '면상장인'];

  const $ = (id) => document.getElementById(id);
  const svg = $('board');

  // ───────────── 프로필 저장 ─────────────
  function loadProfile() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE_KEY));
      if (p && Number.isInteger(p.rank)) return p;
    } catch (e) { /* 저장소를 쓸 수 없으면 새 프로필 */ }
    return null;
  }
  function saveProfile() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(profile)); } catch (e) { /* 무시 */ }
  }
  const stored = loadProfile();
  let profile = stored || { name: '나', rank: 8, points: 0, wins: 0, losses: 0 };

  // ───────────── AI 실행 (가능하면 Web Worker) ─────────────
  let worker = null;
  let workerBroken = false;
  const pending = new Map();
  let jobSeq = 0;

  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      if (window.__JANGGI_WORKER_SRC__) {
        const url = URL.createObjectURL(new Blob([window.__JANGGI_WORKER_SRC__], { type: 'text/javascript' }));
        worker = new Worker(url);
      } else {
        worker = new Worker('js/ai-worker.js');
      }
      worker.onmessage = (e) => {
        const job = pending.get(e.data.id);
        pending.delete(e.data.id);
        if (job) job.cb(e.data.result);
      };
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        workerBroken = true;
        worker = null;
        const jobs = [...pending.values()];
        pending.clear();
        jobs.forEach(runSync);
      };
    } catch (e) {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }
  function runSync(job) {
    setTimeout(() => job.cb(window.JanggiAI.findBestMove(job.board, job.side, job.params)), 30);
  }
  function runAI(board, side, params, cb) {
    const job = { id: ++jobSeq, board: board.slice(), side, params, cb };
    const w = getWorker();
    if (w) {
      pending.set(job.id, job);
      w.postMessage({ id: job.id, board: job.board, side, params });
    } else {
      runSync(job);
    }
  }

  // ───────────── 대국 상태 ─────────────
  let g = null;
  let reqSeq = 0;
  let setupTimer = null;

  function freshClock() { return { main: MAIN_TIME, byo: BYO_TIME, count: BYO_COUNT }; }

  function newGame() {
    reqSeq++;
    clearInterval(setupTimer);
    const mySide = Math.random() < 0.5 ? J.CHO : J.HAN;
    const aiSetup = SETUP_NAMES[Math.floor(Math.random() * SETUP_NAMES.length)];
    g = {
      mySide,
      aiSide: J.opponent(mySide),
      oppName: OPP_NAMES[Math.floor(Math.random() * OPP_NAMES.length)],
      oppRank: profile.rank,
      mySetup: '마상마상',
      aiSetup,
      board: null,
      turn: J.CHO,
      history: [],
      selected: -1,
      targets: [],
      hint: null,
      started: false,
      over: false,
      thinking: false,
      checkSide: null,
      clocks: { c: freshClock(), h: freshClock() },
      items: { undo: ITEM_LIMIT.undo, hint: ITEM_LIMIT.hint },
      lastTick: 0,
    };
    g.board = buildBoard();
    render();
    showSetupDialog();
  }

  function buildBoard() {
    const cho = g.mySide === J.CHO ? g.mySetup : g.aiSetup;
    const han = g.mySide === J.HAN ? g.mySetup : g.aiSetup;
    return J.initialBoard(cho, han);
  }

  function startGame() {
    clearInterval(setupTimer);
    closeDialog();
    g.board = buildBoard();
    g.started = true;
    g.lastTick = performance.now();
    render();
    showToast('대국 시작', 'small');
    if (g.turn === g.aiSide) requestAI();
  }

  const isMyTurn = () => g && g.started && !g.over && !g.thinking && g.turn === g.mySide;

  // ───────────── 수 두기 ─────────────
  function playMove(m) {
    const from = J.moveFrom(m);
    const to = J.moveTo(m);
    const piece = g.board[from];
    const captured = J.makeMove(g.board, m);
    g.history.push({ m, piece, captured, side: g.turn, note: J.notation(piece, m) });
    finishTurn();
    render();
    animatePiece(from, to);
    afterTurn();
  }

  function playPass() {
    g.history.push({ pass: true, side: g.turn, note: '한수 쉼' });
    finishTurn();
    render();
    showToast('한수 쉼', 'small');
    afterTurn();
  }

  function finishTurn() {
    const c = g.clocks[g.turn];
    if (c.main <= 0) c.byo = BYO_TIME; // 초읽기 안에 두면 초읽기 시간을 다시 채운다
    g.turn = J.opponent(g.turn);
    g.selected = -1;
    g.targets = [];
    g.hint = null;
  }

  function afterTurn() {
    const side = g.turn;
    const check = J.inCheck(g.board, side);
    const legal = J.legalMoves(g.board, side);
    const wasCheck = g.checkSide;
    g.checkSide = check ? side : null;

    if (check && legal.length === 0) {
      render();
      showToast('외통!', 'check');
      setTimeout(() => endGame(J.opponent(side), '외통'), 900);
      return;
    }
    if (check) showToast('장군!', 'check');
    else if (wasCheck && wasCheck !== side) showToast('멍군!', 'block');

    if (g.history.length >= MOVE_LIMIT) {
      const my = J.materialScore(g.board, g.mySide);
      const op = J.materialScore(g.board, g.aiSide);
      endGame(my > op ? g.mySide : g.aiSide, `${MOVE_LIMIT}수 점수 판정`);
      return;
    }
    render();

    if (legal.length === 0) {
      // 움직일 수 있는 기물이 없으면 자동으로 한수 쉼
      setTimeout(() => { if (!g.over && g.turn === side) playPass(); }, 700);
      return;
    }
    if (side === g.aiSide) requestAI();
  }

  function requestAI() {
    const id = ++reqSeq;
    g.thinking = true;
    updateButtons();
    const started = Date.now();
    const think = 500 + Math.random() * 900; // 너무 빨리 두면 어색하므로 최소 생각 시간
    runAI(g.board, g.aiSide, R.aiParams(g.oppRank), (res) => {
      if (id !== reqSeq || g.over) return;
      const wait = Math.max(0, think - (Date.now() - started));
      setTimeout(() => {
        if (id !== reqSeq || g.over) return;
        g.thinking = false;
        if (res.move === null || res.move === undefined) playPass();
        else playMove(res.move);
      }, wait);
    });
  }

  function endGame(winner, reason) {
    if (g.over) return;
    g.over = true;
    g.thinking = false;
    reqSeq++;
    const won = winner === g.mySide;
    const before = profile.rank;
    const res = R.applyResult(profile, won);
    profile = res.profile;
    if (won) profile.wins = (profile.wins || 0) + 1;
    else profile.losses = (profile.losses || 0) + 1;
    saveProfile();
    render();
    showResultDialog(won, reason, before, res.change);
  }

  // ───────────── 입력 ─────────────
  function toDisplay(x, y) {
    return g && g.mySide === J.HAN ? [8 - x, 9 - y] : [x, y];
  }
  function px(i) {
    const [dx, dy] = toDisplay(J.xOf(i), J.yOf(i));
    return [M + dx * S, M + dy * S];
  }

  svg.addEventListener('click', (e) => {
    if (!g || !g.started || g.over) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const vy = ((e.clientY - rect.top) / rect.height) * H;
    const dx = Math.round((vx - M) / S);
    const dy = Math.round((vy - M) / S);
    if (dx < 0 || dx > 8 || dy < 0 || dy > 9) return;
    if (Math.hypot(vx - (M + dx * S), vy - (M + dy * S)) > S * 0.5) return;
    const [x, y] = toDisplay(dx, dy); // 뒤집기는 자기 자신의 역함수
    onPoint(J.idx(x, y));
  });

  function onPoint(i) {
    if (!isMyTurn()) return;
    if (g.selected >= 0 && g.targets.includes(i)) {
      playMove(J.makeMoveCode(g.selected, i));
      return;
    }
    const p = g.board[i];
    if (p && p[0] === g.mySide && i !== g.selected) {
      g.selected = i;
      g.targets = J.legalMovesFrom(g.board, i).map(J.moveTo);
    } else {
      g.selected = -1;
      g.targets = [];
    }
    render();
  }

  $('btn-pass').addEventListener('click', () => {
    if (!isMyTurn()) return;
    if (J.inCheck(g.board, g.mySide)) {
      showToast('장군 중에는 쉴 수 없어요', 'small');
      return;
    }
    playPass();
  });

  $('btn-resign').addEventListener('click', () => {
    if (!g || !g.started || g.over) return;
    openDialog(`
      <div class="dlg-body">
        <h3>기권할까요?</h3>
        <p>기권하면 이번 대국은 패배로 기록되고 승급 점수가 1 줄어듭니다.</p>
      </div>
      <div class="dlg-foot">
        <button type="button" class="btn-sub" data-act="close">계속 두기</button>
        <button type="button" class="btn-main" data-act="resign">기권</button>
      </div>`, {
      resign: () => { closeDialog(); endGame(g.aiSide, '기권'); },
    });
  });

  $('btn-items').addEventListener('click', () => {
    if (!g || !g.started || g.over) return;
    const canUndo = g.items.undo > 0 && g.history.some((h) => h.side === g.mySide);
    const canHint = g.items.hint > 0 && isMyTurn();
    openDialog(`
      ${head('아이템')}
      <div class="dlg-body">
        <div class="item-list">
          <button type="button" class="item" data-act="undo" ${canUndo ? '' : 'disabled'}>
            <span class="ico">↶</span>
            <span><b>무르기</b><small>내가 둔 마지막 수를 되돌립니다</small></span>
            <span class="left">${g.items.undo}회</span>
          </button>
          <button type="button" class="item" data-act="hint" ${canHint ? '' : 'disabled'}>
            <span class="ico">訓</span>
            <span><b>훈수</b><small>고수가 둘 만한 수를 판에 표시합니다</small></span>
            <span class="left">${g.items.hint}회</span>
          </button>
        </div>
      </div>
      <div class="dlg-foot"><button type="button" class="btn-sub" data-act="close">닫기</button></div>`, {
      undo: () => { closeDialog(); undo(); },
      hint: () => { closeDialog(); hint(); },
    });
  });

  function undo() {
    if (!g.history.some((h) => h.side === g.mySide)) return;
    reqSeq++;
    g.thinking = false;
    for (;;) {
      const h = g.history.pop();
      if (!h.pass) J.unmakeMove(g.board, h.m, h.captured);
      if (h.side === g.mySide) break;
    }
    g.turn = g.mySide;
    g.items.undo--;
    g.selected = -1;
    g.targets = [];
    g.hint = null;
    g.checkSide = J.inCheck(g.board, g.mySide) ? g.mySide : null;
    render();
    showToast('무르기', 'small');
  }

  function hint() {
    if (!isMyTurn()) return;
    g.items.hint--;
    g.thinking = true;
    updateButtons();
    const id = ++reqSeq;
    showToast('훈수를 찾는 중…', 'small');
    runAI(g.board, g.mySide, { ...R.aiParams(22), timeMs: 1500, noise: 0, mistakeRate: 0 }, (res) => {
      if (id !== reqSeq || g.over) return;
      g.thinking = false;
      g.hint = res.move;
      render();
    });
  }

  $('btn-log').addEventListener('click', () => {
    const items = g ? g.history.map((h, k) => `<li class="${h.side}"><span class="n">${k + 1}.</span><b>${h.note}</b></li>`).join('') : '';
    openDialog(`
      ${head('기보')}
      <div class="dlg-body">
        <div class="log">${items ? `<ol>${items}</ol>` : '<div class="empty">아직 둔 수가 없습니다</div>'}</div>
        <p>표기: 출발 위치(행·열) + 기물 + 도착 위치. 행은 위에서부터 1~9, 0, 열은 왼쪽부터 1~9입니다.</p>
      </div>
      <div class="dlg-foot"><button type="button" class="btn-sub" data-act="close">닫기</button></div>`);
  });

  $('btn-settings').addEventListener('click', () => showProfileDialog(false));

  // ───────────── 팝업 ─────────────
  let dialogHandlers = {};
  function openDialog(html, handlers) {
    dialogHandlers = handlers || {};
    $('dialog').innerHTML = html;
    $('overlay').hidden = false;
    const first = $('dialog').querySelector('.btn-main, button');
    if (first) first.focus({ preventScroll: true });
  }
  function closeDialog() {
    $('overlay').hidden = true;
    $('dialog').innerHTML = '';
    dialogHandlers = {};
  }
  $('dialog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'close') closeDialog();
    else if (dialogHandlers[act]) dialogHandlers[act](b);
  });

  function head(title, countId) {
    return `<div class="dlg-head">
      <svg class="gear" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.2" /></svg>
      <h2>${title}</h2>${countId ? `<span class="count" id="${countId}"></span>` : ''}</div>`;
  }

  function miniPiece(p) {
    return `<svg class="mini" viewBox="-42 -42 84 84" aria-hidden="true">${pieceShape(p, 36)}</svg>`;
  }
  function setupRow(side, setup) {
    return J.SETUPS[setup].split('').map((t) => miniPiece(side + t)).join('');
  }

  function showSetupDialog() {
    const oppLabel = g.aiSide === J.HAN ? '한 상차림' : '초 상차림';
    const opts = SETUP_NAMES.map((name) => `
      <button type="button" class="setup-opt" data-act="pick" data-setup="${name}" aria-pressed="${name === g.mySetup}" aria-label="${name}">
        ${setupRow(g.mySide, name)}
      </button>`).join('');
    const firstNote = g.mySide === J.CHO ? '초(楚)를 잡았습니다. 먼저 둡니다.' : '한(漢)을 잡았습니다. 덤 1.5점을 받고 나중에 둡니다.';
    openDialog(`
      ${head('승강급 대국', 'setup-count')}
      <div class="dlg-body">
        <div><h3>상차림 선택</h3><p>대국 시작시 상/마의 위치를 선택합니다. ${firstNote}</p></div>
        <div class="setup-opp"><span class="label">${oppLabel}</span><span>${setupRow(g.aiSide, g.aiSetup)}</span></div>
        <div class="setup-grid">${opts}</div>
      </div>
      <div class="dlg-foot"><button type="button" class="btn-main" data-act="start">확인</button></div>`, {
      pick: (b) => {
        g.mySetup = b.dataset.setup;
        $('dialog').querySelectorAll('.setup-opt').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
        g.board = buildBoard();
        render();
      },
      start: startGame,
    });
    let left = SETUP_SECONDS;
    $('setup-count').textContent = left;
    setupTimer = setInterval(() => {
      left--;
      const el = $('setup-count');
      if (el) el.textContent = left;
      if (left <= 0) startGame();
    }, 1000);
  }

  function meterHTML() {
    const n = R.PROMOTE_AT;
    let dots = '';
    for (let k = n; k >= 1; k--) dots += `<i class="${profile.points <= -k ? 'down' : ''}"></i>`;
    dots += '<span class="sep"></span>';
    for (let k = 1; k <= n; k++) dots += `<i class="${profile.points >= k ? 'up' : ''}"></i>`;
    return `<div class="meter"><span>강급</span>${dots}<span>승급</span></div>`;
  }

  function showResultDialog(won, reason, beforeRank, change) {
    let changeText;
    if (change > 0) changeText = `<span class="rank-change">${R.rankName(beforeRank)} → ${R.rankName(profile.rank)} 승급!</span>`;
    else if (change < 0) changeText = `<span class="rank-change down">${R.rankName(beforeRank)} → ${R.rankName(profile.rank)} 강급</span>`;
    else {
      const need = R.PROMOTE_AT - profile.points;
      changeText = `<span class="rank-change${won ? '' : ' down'}">승급까지 ${need}승 남음</span>`;
    }
    openDialog(`
      ${head('승강급 대국')}
      <div class="dlg-body">
        <div class="result-title ${won ? 'win' : 'lose'}">${won ? '승리' : '패배'}</div>
        <div class="result-reason">${reason}${won ? '승' : '패'} · ${g.history.length}수 · 상대 ${R.rankName(g.oppRank)} ${escapeHTML(g.oppName)}</div>
        <div class="rank-box">
          <span class="rank-now">${R.rankName(profile.rank)}</span>
          ${meterHTML()}
          ${changeText}
        </div>
      </div>
      <div class="dlg-foot">
        <button type="button" class="btn-sub" data-act="close">판 보기</button>
        <button type="button" class="btn-main" data-act="again">다시 대국</button>
      </div>`, { again: newGame });
  }

  function showProfileDialog(first) {
    const options = R.RANKS.map((r, k) => `<option value="${k}" ${k === profile.rank ? 'selected' : ''}>${r}</option>`).join('');
    const playing = g && g.started && !g.over;
    openDialog(`
      ${head(first ? '장기 시작하기' : '내 정보')}
      <div class="dlg-body">
        ${first ? '<p>내 급수를 고르면 같은 급수의 AI와 승강급 대국을 둡니다. 3번 더 이기면 승급, 3번 더 지면 강급합니다.</p>' : ''}
        <div class="field"><label for="pf-name">닉네임</label><input id="pf-name" maxlength="10" value="${escapeHTML(profile.name)}"></div>
        <div class="field"><label for="pf-rank">급수 (18급 ~ 9단)</label><select id="pf-rank">${options}</select></div>
        ${first ? '' : `<div class="record"><div><b>${profile.wins || 0}</b><span>승</span></div><div><b>${profile.losses || 0}</b><span>패</span></div><div><b>${profile.points > 0 ? '+' : ''}${profile.points}</b><span>승급 점수</span></div></div>`}
        ${first ? '' : meterHTML()}
        ${playing ? '<p>급수를 바꾸면 다음 대국부터 적용됩니다.</p>' : ''}
      </div>
      <div class="dlg-foot">
        ${first ? '' : '<button type="button" class="btn-sub" data-act="save">저장</button>'}
        <button type="button" class="btn-main" data-act="newgame">${first ? '대국 시작' : '새 대국'}</button>
      </div>`, {
      save: () => { applyProfileForm(); closeDialog(); render(); },
      newgame: () => {
        if (playing && !first) {
          applyProfileForm();
          openDialog(`
            <div class="dlg-body"><h3>새 대국을 시작할까요?</h3><p>지금 두고 있는 대국은 기권패로 처리됩니다.</p></div>
            <div class="dlg-foot"><button type="button" class="btn-sub" data-act="close">취소</button><button type="button" class="btn-main" data-act="go">새 대국</button></div>`, {
            go: () => { closeDialog(); endGame(g.aiSide, '기권'); newGame(); },
          });
          return;
        }
        applyProfileForm();
        newGame();
      },
    });
  }

  function applyProfileForm() {
    const name = $('pf-name').value.trim() || '나';
    const rank = parseInt($('pf-rank').value, 10);
    if (rank !== profile.rank) profile.points = 0;
    profile.name = name;
    profile.rank = rank;
    saveProfile();
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ───────────── 알림 ─────────────
  let toastTimer = null;
  function showToast(text, kind) {
    const t = $('toast');
    t.className = 'toast';
    void t.offsetWidth;
    t.textContent = text;
    t.className = `toast show ${kind || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 1400);
  }

  // ───────────── 그리기 ─────────────
  function octagon(r) {
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      pts.push(`${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  }

  function pieceShape(p, r) {
    const color = p[0] === J.HAN ? 'var(--han)' : 'var(--cho)';
    const fs = p[1] === 'K' ? r * 1.12 : r * 1.22;
    return `<polygon points="${octagon(r)}" fill="url(#pc-edge)" stroke="#9c9c9c" stroke-width="1.2"/>
      <polygon points="${octagon(r * 0.86)}" fill="url(#pc-face)"/>
      <text class="glyph" y="${(r * 0.02).toFixed(1)}" font-size="${fs.toFixed(1)}" fill="${color}">${J.HANJA[p[0]][p[1]]}</text>`;
  }

  function staticLayer() {
    const L = [];
    const X = (x) => M + x * S;
    const Y = (y) => M + y * S;
    for (let y = 0; y < 10; y++) L.push(`<line x1="${X(0)}" y1="${Y(y)}" x2="${X(8)}" y2="${Y(y)}"/>`);
    for (let x = 0; x < 9; x++) L.push(`<line x1="${X(x)}" y1="${Y(0)}" x2="${X(x)}" y2="${Y(9)}"/>`);
    for (const top of [0, 7]) {
      L.push(`<line x1="${X(3)}" y1="${Y(top)}" x2="${X(5)}" y2="${Y(top + 2)}"/>`);
      L.push(`<line x1="${X(5)}" y1="${Y(top)}" x2="${X(3)}" y2="${Y(top + 2)}"/>`);
    }
    L.push(`<rect class="frame" x="${X(0)}" y="${Y(0)}" width="${S * 8}" height="${S * 9}" fill="none" stroke="var(--line)" stroke-width="3"/>`);
    return `
      <defs>
        <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--wood-hi)"/><stop offset="1" stop-color="var(--wood-lo)"/>
        </linearGradient>
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="3" seed="7"/>
          <feColorMatrix values="0 0 0 0 0.55  0 0 0 0 0.36  0 0 0 0 0.12  0 0 0 0.55 -0.12"/>
          <feComposite in2="SourceGraphic" operator="in"/>
        </filter>
        <linearGradient id="pc-edge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f7f7f7"/><stop offset="0.55" stop-color="#d4d4d4"/><stop offset="1" stop-color="#a8a8a8"/>
        </linearGradient>
        <radialGradient id="pc-face" cx="0.42" cy="0.35" r="0.75">
          <stop offset="0" stop-color="#ffffff"/><stop offset="0.7" stop-color="#f3f3f1"/><stop offset="1" stop-color="#e2e2e0"/>
        </radialGradient>
        <radialGradient id="glow">
          <stop offset="0.45" stop-color="#fff7c2" stop-opacity="0.95"/><stop offset="1" stop-color="#ffe680" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#wood)"/>
      <rect width="${W}" height="${H}" fill="#000" filter="url(#grain)" opacity="0.55"/>
      <g class="grid">${L.join('')}</g>`;
  }

  let staticHTML = null;

  function render() {
    if (!g) return;
    if (!staticHTML) staticHTML = staticLayer();
    const out = [staticHTML];
    const moves = g.history.filter((h) => !h.pass);
    const last = moves[moves.length - 1];

    // 직전 두 수(양쪽)의 출발점 ×
    for (const h of moves.slice(-2)) {
      const [x, y] = px(J.moveFrom(h.m));
      out.push(`<path class="xmark" d="M${x - 9} ${y - 9}L${x + 9} ${y + 9}M${x + 9} ${y - 9}L${x - 9} ${y + 9}"/>`);
    }
    if (last && !g.over) {
      const [x, y] = px(J.moveTo(last.m));
      out.push(`<circle cx="${x}" cy="${y}" r="${RADIUS[last.piece[1]] + 18}" fill="url(#glow)"/>`);
    }
    if (g.hint !== null && g.hint !== undefined) {
      const [x1, y1] = px(J.moveFrom(g.hint));
      const [x2, y2] = px(J.moveTo(g.hint));
      out.push(`<line class="hint-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }

    for (let i = 0; i < 90; i++) {
      const p = g.board[i];
      if (!p) continue;
      const [x, y] = px(i);
      const r = RADIUS[p[1]];
      const sel = i === g.selected;
      out.push(`<g class="piece${sel ? ' selected' : ''}" data-i="${i}" style="transform:translate(${x}px,${y - (sel ? 6 : 0)}px)">${pieceShape(p, r)}`
        + (sel ? `<polygon class="sel-ring" points="${octagon(r + 5)}"/>` : '')
        + (p[1] === 'K' && g.checkSide === p[0] && !g.over ? `<circle class="check-ring" r="${r + 10}"/>` : '')
        + '</g>');
    }
    if (g.hint !== null && g.hint !== undefined) {
      for (const i of [J.moveFrom(g.hint), J.moveTo(g.hint)]) {
        const [x, y] = px(i);
        out.push(`<circle class="hint-ring" cx="${x}" cy="${y}" r="44"/>`);
      }
    }
    for (const t of g.targets) {
      const [x, y] = px(t);
      if (g.board[t]) out.push(`<circle class="target-cap" cx="${x}" cy="${y}" r="${RADIUS[g.board[t][1]] + 8}"/>`);
      else out.push(`<circle class="target" cx="${x}" cy="${y}" r="15"/>`);
    }
    svg.innerHTML = out.join('');

    renderPanel();
    updateButtons();
  }

  function animatePiece(from, to) {
    const el = svg.querySelector(`.piece[data-i="${to}"]`);
    if (!el || !el.animate) return;
    const [x1, y1] = px(from);
    const [x2, y2] = px(to);
    el.animate([
      { transform: `translate(${x1}px,${y1}px)` },
      { transform: `translate(${x2}px,${y2}px)` },
    ], { duration: 220, easing: 'cubic-bezier(.3,.7,.4,1)' });
  }

  function fmt(sec) {
    const s = Math.max(0, Math.ceil(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderPanel() {
    const n = g.history.length;
    $('title').textContent = n > 0 ? `승강급 대국 - ${n}수` : '승강급 대국';
    $('me-side').textContent = g.mySide === J.CHO ? '楚' : '漢';
    $('opp-side').textContent = g.aiSide === J.CHO ? '楚' : '漢';
    $('me-score').textContent = `${J.materialScore(g.board, g.mySide).toFixed(1)}점`;
    $('opp-score').textContent = `${J.materialScore(g.board, g.aiSide).toFixed(1)}점`;
    $('me-rank').textContent = R.rankName(profile.rank);
    $('me-name').textContent = profile.name;
    $('opp-rank').textContent = R.rankName(g.oppRank);
    $('opp-name').textContent = g.oppName;
    const active = g.started && !g.over;
    $('player-me').classList.toggle('active', active && g.turn === g.mySide);
    $('player-opp').classList.toggle('active', active && g.turn === g.aiSide);
    const bar = document.querySelector('.turnbar');
    bar.classList.toggle('opp', g.turn === g.aiSide);
    bar.classList.toggle('none', !active);
    renderClocks();
  }

  function renderClocks() {
    for (const [who, side] of [['me', g.mySide], ['opp', g.aiSide]]) {
      const c = g.clocks[side];
      $(`${who}-time`).textContent = fmt(c.main > 0 ? c.main : c.byo);
      $(`${who}-byo`).textContent = c.count;
      $(`player-${who}`).classList.toggle('urgent', c.main <= 0 && c.byo <= 10 && g.turn === side && !g.over);
    }
  }

  function updateButtons() {
    const mine = isMyTurn();
    $('btn-pass').disabled = !mine;
    $('btn-resign').disabled = !g || !g.started || g.over;
    $('btn-items').disabled = !g || !g.started || g.over;
  }

  // 초시계 눈금
  (function drawTicks() {
    const t = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r1 = k % 6 === 0 ? 20 : 23.5;
      t.push(`<line x1="${32 + Math.sin(a) * r1}" y1="${32 - Math.cos(a) * r1}" x2="${32 + Math.sin(a) * 25.5}" y2="${32 - Math.cos(a) * 25.5}"/>`);
    }
    $('sw-ticks').innerHTML = t.join('');
  })();

  // ───────────── 시계 ─────────────
  setInterval(() => {
    if (!g || !g.started || g.over) return;
    const now = performance.now();
    const dt = (now - g.lastTick) / 1000;
    g.lastTick = now;
    if (!$('overlay').hidden && !g.thinking && g.turn === g.mySide) return; // 내 차례에 팝업을 열어 둔 동안은 멈춤
    const c = g.clocks[g.turn];
    if (c.main > 0) {
      c.main -= dt;
      if (c.main < 0) { c.byo += c.main; c.main = 0; }
    } else {
      c.byo -= dt;
      if (c.byo <= 0) {
        if (c.count > 1) {
          c.count--;
          c.byo = BYO_TIME;
        } else {
          c.count = 0;
          c.byo = 0;
          renderClocks();
          endGame(J.opponent(g.turn), '시간');
          return;
        }
      }
    }
    const spent = c.main > 0 ? MAIN_TIME - c.main : BYO_TIME - c.byo;
    $('sw-hand').style.transform = `rotate(${(spent % 60) * 6}deg)`;
    renderClocks();
  }, 200);

  // ───────────── 시작 ─────────────
  newGame();
  if (!stored) {
    clearInterval(setupTimer);
    showProfileDialog(true);
  }
})();

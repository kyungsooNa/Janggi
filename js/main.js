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

  const RADIUS = { K: 48, R: 42, C: 42, H: 42, E: 42, A: 31, P: 31 };
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
  const RECORD_KEY = 'janggi.records.v1';
  const RECORD_MAX = 100;
  function loadRecords() {
    try {
      const r = JSON.parse(localStorage.getItem(RECORD_KEY));
      if (Array.isArray(r)) return r;
    } catch (e) { /* 무시 */ }
    return [];
  }
  let records = loadRecords();
  function saveRecord(rec) {
    records.unshift(rec);
    records = records.slice(0, RECORD_MAX);
    try { localStorage.setItem(RECORD_KEY, JSON.stringify(records)); } catch (e) { /* 무시 */ }
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
    cancelFlight();
    const pref = profile.sidePref;
    const mySide = pref === J.CHO || pref === J.HAN ? pref : (Math.random() < 0.5 ? J.CHO : J.HAN);
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
    flyPiece(from, to, piece, captured, afterTurn);
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
    const think = 250 + Math.random() * 450; // 너무 빨리 두면 어색하므로 최소 생각 시간
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
    saveRecord({
      date: Date.now(),
      mySide: g.mySide,
      myRank: before,
      oppName: g.oppName,
      oppRank: g.oppRank,
      won,
      reason,
      change: res.change,
      cho: g.mySide === J.CHO ? g.mySetup : g.aiSetup,
      han: g.mySide === J.HAN ? g.mySetup : g.aiSetup,
      moves: g.history.map((h) => (h.pass ? -1 : h.m)),
    });
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
      render();
      liftSelected();
      return;
    }
    g.selected = -1;
    g.targets = [];
    render();
  }

  $('btn-pass').addEventListener('click', () => {
    if (g && g.replay) { replayStep(-1); return; }
    if (!isMyTurn()) return;
    if (J.inCheck(g.board, g.mySide)) {
      showToast('장군 중에는 쉴 수 없어요', 'small');
      return;
    }
    playPass();
  });

  $('btn-resign').addEventListener('click', () => {
    if (g && g.replay) { replayStep(1); return; }
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
    if (g && g.replay) { showRecordsDialog(); return; }
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
    cancelFlight();
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

  function showSetupDialog(keepTimer) {
    const sideBtn = (side) => `<button type="button" class="side-btn" data-act="side" data-side="${side}" aria-pressed="${g.mySide === side}">
        <span class="hz ${side === J.CHO ? 'cho' : 'han'}">${side === J.CHO ? '楚' : '漢'}</span>${side === J.CHO ? '초 (먼저)' : '한 (덤 1.5)'}</button>`;
    const oppLabel = g.aiSide === J.HAN ? '한 상차림' : '초 상차림';
    const opts = SETUP_NAMES.map((name) => `
      <button type="button" class="setup-opt" data-act="pick" data-setup="${name}" aria-pressed="${name === g.mySetup}" aria-label="${name}">
        ${setupRow(g.mySide, name)}
      </button>`).join('');
    const firstNote = g.mySide === J.CHO ? '초(楚)는 먼저 둡니다.' : '한(漢)은 덤 1.5점을 받고 나중에 둡니다.';
    openDialog(`
      ${head('승강급 대국', 'setup-count')}
      <div class="dlg-body">
        <div><h3>상차림 선택</h3><p>대국 시작시 상/마의 위치를 선택합니다. ${firstNote}</p></div>
        <div class="side-pick"><span class="label">내 진영</span>${sideBtn(J.CHO)}${sideBtn(J.HAN)}</div>
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
      side: (b) => {
        if (b.dataset.side === g.mySide) return;
        g.mySide = b.dataset.side;
        g.aiSide = J.opponent(g.mySide);
        g.board = buildBoard();
        render();
        showSetupDialog(true);
      },
      start: startGame,
    });
    $('setup-count').textContent = g.setupLeft;
    if (keepTimer) return;
    g.setupLeft = SETUP_SECONDS;
    $('setup-count').textContent = g.setupLeft;
    setupTimer = setInterval(() => {
      g.setupLeft--;
      const el = $('setup-count');
      if (el) el.textContent = g.setupLeft;
      if (g.setupLeft <= 0) startGame();
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
      </div>
      <div class="dlg-foot"><button type="button" class="btn-link" data-act="records">대국 기록 보기</button></div>`, { again: newGame, records: () => showRecordsDialog() });
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
        <div class="field"><label for="pf-side">내 진영</label><select id="pf-side">
          <option value="random" ${!profile.sidePref || profile.sidePref === 'random' ? 'selected' : ''}>대국마다 무작위</option>
          <option value="c" ${profile.sidePref === 'c' ? 'selected' : ''}>항상 초 (楚, 먼저 둠)</option>
          <option value="h" ${profile.sidePref === 'h' ? 'selected' : ''}>항상 한 (漢, 덤 1.5점)</option>
        </select></div>
        <label class="toggle" for="pf-sound">착수 효과음 <input type="checkbox" id="pf-sound" ${profile.sound === false ? '' : 'checked'}></label>
        ${first ? '' : `<div class="record"><div><b>${profile.wins || 0}</b><span>승</span></div><div><b>${profile.losses || 0}</b><span>패</span></div><div><b>${profile.points > 0 ? '+' : ''}${profile.points}</b><span>승급 점수</span></div></div>`}
        ${first ? '' : meterHTML()}
        ${first ? '' : '<button type="button" class="btn-sub" data-act="records">대국 기록 보기</button>'}
        ${playing ? '<p>급수와 진영을 바꾸면 다음 대국부터 적용됩니다.</p>' : ''}
      </div>
      <div class="dlg-foot">
        ${first ? '' : '<button type="button" class="btn-sub" data-act="save">저장</button>'}
        <button type="button" class="btn-main" data-act="newgame">${first ? '대국 시작' : '새 대국'}</button>
      </div>`, {
      save: () => { applyProfileForm(); closeDialog(); render(); },
      records: () => { applyProfileForm(); showRecordsDialog(); },
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

  // ───────────── 대국 기록 · 기보 재생 ─────────────
  function fmtDate(t) {
    const d = new Date(t);
    const two = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  function statLine(list) {
    const w = list.filter((r) => r.won).length;
    const l = list.length - w;
    const rate = list.length ? Math.round((w / list.length) * 100) : 0;
    return { w, l, rate, n: list.length };
  }

  function showRecordsDialog() {
    const playing = g && g.started && !g.over && !g.replay;
    const all = statLine(records);
    const cho = statLine(records.filter((r) => r.mySide === J.CHO));
    const han = statLine(records.filter((r) => r.mySide === J.HAN));
    let streak = 0;
    for (const r of records) { if (r.won === (records[0] && records[0].won)) streak++; else break; }
    const streakText = records.length ? `${streak}연${records[0].won ? '승' : '패'}` : '-';
    const rows = records.map((r, k) => {
      const side = r.mySide === J.CHO ? '<span class="hz cho">楚</span>' : '<span class="hz han">漢</span>';
      const change = r.change > 0 ? `<em class="up">▲ ${R.rankName(r.myRank + 1)}</em>` : r.change < 0 ? `<em class="down">▼ ${R.rankName(r.myRank - 1)}</em>` : '';
      return `<li><button type="button" class="rec" data-act="replay" data-k="${k}" ${playing ? 'disabled' : ''}>
        <span class="res ${r.won ? 'win' : 'lose'}">${r.won ? '승' : '패'}</span>
        <span class="mid"><b>${side} vs ${R.rankName(r.oppRank)} ${escapeHTML(r.oppName)}</b>
          <small>${fmtDate(r.date)} · ${r.reason}${r.won ? '승' : '패'} · ${r.moves.length}수 ${change}</small></span>
        <span class="go" aria-hidden="true">›</span></button></li>`;
    }).join('');
    openDialog(`
      ${head('대국 기록')}
      <div class="dlg-body">
        <div class="record">
          <div><b>${all.n}</b><span>대국</span></div>
          <div><b>${all.w}승 ${all.l}패</b><span>승률 ${all.rate}%</span></div>
          <div><b>${streakText}</b><span>최근 흐름</span></div>
        </div>
        <div class="split">
          <span><span class="hz cho">楚</span> 초로 ${cho.w}승 ${cho.l}패 (${cho.rate}%)</span>
          <span><span class="hz han">漢</span> 한으로 ${han.w}승 ${han.l}패 (${han.rate}%)</span>
        </div>
        <div class="rec-list">${rows ? `<ul>${rows}</ul>` : '<div class="empty">아직 끝낸 대국이 없습니다. 한 판 두면 여기에 쌓입니다.</div>'}</div>
        ${playing ? '<p>지금 두는 대국이 끝나면 지난 기보를 다시 볼 수 있습니다.</p>' : (rows ? '<p>대국을 누르면 판에서 한 수씩 다시 볼 수 있습니다.</p>' : '')}
      </div>
      <div class="dlg-foot">
        <button type="button" class="btn-sub" data-act="close">닫기</button>
        ${playing ? '' : '<button type="button" class="btn-main" data-act="again">새 대국</button>'}
      </div>`, {
      replay: (b) => enterReplay(records[Number(b.dataset.k)]),
      again: newGame,
    });
  }

  function enterReplay(rec) {
    if (!rec) return;
    cancelFlight();
    reqSeq++;
    clearInterval(setupTimer);
    g = {
      mySide: rec.mySide,
      aiSide: J.opponent(rec.mySide),
      oppName: rec.oppName,
      oppRank: rec.oppRank,
      board: J.initialBoard(rec.cho, rec.han),
      turn: J.CHO,
      history: [],
      selected: -1,
      targets: [],
      hint: null,
      started: false,
      over: true,
      thinking: false,
      checkSide: null,
      clocks: { c: freshClock(), h: freshClock() },
      items: { undo: 0, hint: 0 },
      replay: { rec, ply: 0 },
    };
    closeDialog();
    render();
    showToast(`${rec.won ? '승' : '패'} · ${rec.moves.length}수 기보`, 'small');
  }

  function replayStep(dir) {
    const rp = g.replay;
    if (dir > 0) {
      if (rp.ply >= rp.rec.moves.length) return;
      const m = rp.rec.moves[rp.ply++];
      if (m < 0) {
        g.history.push({ pass: true, side: g.turn, note: '한수 쉼' });
        g.turn = J.opponent(g.turn);
        g.checkSide = null;
        render();
        showToast('한수 쉼', 'small');
        return;
      }
      const from = J.moveFrom(m);
      const to = J.moveTo(m);
      const piece = g.board[from];
      const captured = J.makeMove(g.board, m);
      g.history.push({ m, piece, captured, side: g.turn, note: J.notation(piece, m) });
      g.turn = J.opponent(g.turn);
      g.checkSide = J.inCheck(g.board, g.turn) ? g.turn : null;
      flyPiece(from, to, piece, captured, () => {
        if (rp.ply === rp.rec.moves.length) showToast(`${rp.rec.reason}${rp.rec.won ? '승' : '패'}`, rp.rec.won ? 'block' : 'check');
        else if (g.checkSide) showToast('장군!', 'check');
      });
    } else {
      if (rp.ply === 0) return;
      cancelFlight();
      rp.ply--;
      const h = g.history.pop();
      if (!h.pass) J.unmakeMove(g.board, h.m, h.captured);
      g.turn = h.side;
      g.checkSide = J.inCheck(g.board, g.turn) ? g.turn : null;
      render();
    }
  }

  // 기보 재생 중 키보드 ← →
  window.addEventListener('keydown', (e) => {
    if (!g || !g.replay || !$('overlay').hidden) return;
    if (e.key === 'ArrowLeft') replayStep(-1);
    else if (e.key === 'ArrowRight') replayStep(1);
  });

  function applyProfileForm() {
    const name = $('pf-name').value.trim() || '나';
    const rank = parseInt($('pf-rank').value, 10);
    if (rank !== profile.rank) profile.points = 0;
    profile.name = name;
    profile.rank = rank;
    profile.sidePref = $('pf-side').value;
    profile.sound = $('pf-sound').checked;
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
    const fs = p[1] === 'K' ? r * 1.16 : r * 1.3;
    return `<polygon points="${octagon(r)}" fill="url(#pc-edge)" stroke="#9c9c9c" stroke-width="1.2"/>
      <polygon points="${octagon(r * 0.86)}" fill="url(#pc-face)"/>
      <text class="glyph ${p[0] === J.HAN ? 'han' : 'cho'}" y="${(r * 0.02).toFixed(1)}" font-size="${fs.toFixed(1)}" fill="${color}">${J.HANJA[p[0]][p[1]]}</text>`;
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

  // 판은 세 겹: 고정(나무·선) / dyn(기물·표시, render 때마다 새로 그림) / fx(날아가는 기물 연출)
  let layersReady = false;
  function ensureLayers() {
    if (layersReady) return;
    svg.innerHTML = `${staticLayer()}<g id="dyn"></g><g id="fx"></g>`;
    layersReady = true;
  }

  function render() {
    if (!g) return;
    ensureLayers();
    const out = [];
    const moves = g.history.filter((h) => !h.pass);
    const last = moves[moves.length - 1];
    const hidden = g.flying ? g.flying.to : -1; // 날아가는 중인 기물은 fx 층에서 그린다

    // 직전 두 수(양쪽)의 출발점 ×
    for (const h of moves.slice(-2)) {
      const [x, y] = px(J.moveFrom(h.m));
      out.push(`<path class="xmark" d="M${x - 9} ${y - 9}L${x + 9} ${y + 9}M${x + 9} ${y - 9}L${x - 9} ${y + 9}"/>`);
    }
    const live = !g.over || g.replay;
    if (last && live && !g.flying) {
      const [x, y] = px(J.moveTo(last.m));
      out.push(`<circle class="glow" cx="${x}" cy="${y}" r="${RADIUS[last.piece[1]] + 18}" fill="url(#glow)"/>`);
    }
    if (g.hint !== null && g.hint !== undefined) {
      const [x1, y1] = px(J.moveFrom(g.hint));
      const [x2, y2] = px(J.moveTo(g.hint));
      out.push(`<line class="hint-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`);
    }

    for (let i = 0; i < 90; i++) {
      const p = g.board[i];
      if (!p || i === hidden) continue;
      const [x, y] = px(i);
      const r = RADIUS[p[1]];
      const sel = i === g.selected;
      out.push(`<g class="piece${sel ? ' selected' : ''}" data-i="${i}" style="transform:translate(${x}px,${y - (sel ? 6 : 0)}px) scale(${sel ? 1.05 : 1})">${pieceShape(p, r)}`
        + (sel ? `<polygon class="sel-ring" points="${octagon(r + 5)}"/>` : '')
        + (p[1] === 'K' && g.checkSide === p[0] && live ? `<circle class="check-ring" r="${r + 10}"/>` : '')
        + '</g>');
    }
    if (g.hint !== null && g.hint !== undefined) {
      for (const i of [J.moveFrom(g.hint), J.moveTo(g.hint)]) {
        const [x, y] = px(i);
        out.push(`<circle class="hint-ring" cx="${x}" cy="${y}" r="44"/>`);
      }
    }
    // 빈 칸만 점으로 보여 준다. 잡을 수 있는 상대 기물은 스스로 읽도록 표시하지 않는다.
    for (const t of g.targets) {
      if (g.board[t]) continue;
      const [x, y] = px(t);
      out.push(`<circle class="target" cx="${x}" cy="${y}" r="15"/>`);
    }
    $('dyn').innerHTML = out.join('');

    renderPanel();
    updateButtons();
  }

  // 기물을 집을 때 살짝 들어 올리는 연출
  function liftSelected() {
    const el = svg.querySelector('.piece.selected');
    if (!el || !el.animate || reducedMotion()) return;
    const [x, y] = px(g.selected);
    el.animate([
      { transform: `translate(${x}px,${y}px) scale(1)` },
      { transform: `translate(${x}px,${y - 6}px) scale(1.05)` },
    ], { duration: 80, easing: 'ease-out' });
  }

  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /*
   * 기물이 판에서 들려 → 포물선을 그리며 날아가 → "탁" 하고 내려앉는다.
   * 잡힌 기물은 착지 순간 튕겨 나가며 사라진다. onLand 는 착지 직후 호출.
   */
  function flyPiece(from, to, piece, captured, onLand) {
    cancelFlight();
    const fx = $('fx') || (ensureLayers(), $('fx'));
    const [x1, y1] = px(from);
    const [x2, y2] = px(to);
    const r = RADIUS[piece[1]];
    const dist = Math.hypot(x2 - x1, y2 - y1) / S;
    const quick = reducedMotion();
    const dur = quick ? 1 : Math.min(240, 130 + dist * 14);
    const lift = 4 + Math.min(8, dist * 1.5);
    const token = {};
    g.flying = { to, token, timers: [] };

    if (captured) fx.insertAdjacentHTML('beforeend', `<g class="piece victim" style="transform:translate(${x2}px,${y2}px)">${pieceShape(captured, RADIUS[captured[1]])}</g>`);
    fx.insertAdjacentHTML('beforeend', `<g class="piece flying" style="transform:translate(${x1}px,${y1}px)">${pieceShape(piece, r)}</g>`);
    const victim = fx.querySelector('.victim');
    const el = fx.querySelector('.flying');
    render();

    const T = (x, y, k) => `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${k})`;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    if (el.animate && !quick) {
      // 구간을 나누면 구간마다 속도가 줄어 멈칫거린다. 직선 이동 + 가운데서 살짝 떠오르기만 두고,
      // 가감속은 전체에 한 번만 걸어 출발하자마자 움직이고 끝에서만 부드럽게 멈추게 한다.
      el.animate([
        { transform: T(x1, y1, 1) },
        { transform: T(mx, my - lift, 1.06) },
        { transform: T(x2, y2, 1) },
      ], { duration: dur, easing: 'cubic-bezier(.25,.75,.4,1)', fill: 'forwards' });
    }

    const landAt = quick ? 0 : dur * 0.85;
    g.flying.timers.push(setTimeout(() => {
      if (!g.flying || g.flying.token !== token) return;
      playThock(!!captured);
      if (!quick) {
        fx.insertAdjacentHTML('afterbegin', `<circle class="ripple" cx="${x2}" cy="${y2}" r="${r}"/>`);
        const ripple = fx.querySelector('.ripple');
        if (ripple.animate) {
          ripple.animate([{ r: r, opacity: 0.85, strokeWidth: 6 }, { r: r + 20, opacity: 0, strokeWidth: 1 }], { duration: 300, easing: 'ease-out', fill: 'forwards' });
        }
      }
      if (victim) {
        const dirX = Math.sign(x2 - x1) || (Math.random() < 0.5 ? -1 : 1);
        const dirY = Math.sign(y2 - y1) || -1;
        if (victim.animate && !quick) {
          victim.animate([
            { transform: `translate(${x2}px,${y2}px) scale(1) rotate(0deg)`, opacity: 1 },
            { transform: `translate(${x2 + dirX * 28}px,${y2 + dirY * 18 - 14}px) scale(1.08) rotate(${dirX * 20}deg)`, opacity: 0.85, offset: 0.4 },
            { transform: `translate(${x2 + dirX * 50}px,${y2 + dirY * 30 + 6}px) scale(0.75) rotate(${dirX * 45}deg)`, opacity: 0 },
          ], { duration: 300, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
        } else {
          victim.remove();
        }
        const wrap = svg.parentElement;
        wrap.classList.remove('shake');
        void wrap.offsetWidth;
        if (!quick) wrap.classList.add('shake');
      }
    }, landAt));

    g.flying.timers.push(setTimeout(() => {
      if (!g.flying || g.flying.token !== token) return;
      g.flying = null;
      if (el) el.remove();
      render();
      if (onLand) onLand();
      // 튕겨 나간 기물과 물결은 마저 사라진 뒤 치운다
      setTimeout(() => { if (!g.flying) fx.innerHTML = ''; }, 320);
    }, dur));
  }

  function cancelFlight() {
    if (g && g.flying) {
      g.flying.timers.forEach(clearTimeout);
      g.flying = null;
    }
    const fx = $('fx');
    if (fx) fx.innerHTML = '';
  }

  // ───────────── 효과음 ("탁") ─────────────
  let actx = null;
  function audio() {
    if (profile.sound === false) return null;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) {
      return null;
    }
    return actx;
  }
  // 브라우저는 사용자가 한 번 누른 뒤에야 소리를 허락한다
  window.addEventListener('pointerdown', () => audio(), { once: true });

  function playThock(heavy) {
    const a = audio();
    if (!a || a.state !== 'running') return;
    const t = a.currentTime;
    // 나무끼리 부딪치는 짧은 소리
    const len = Math.floor(a.sampleRate * 0.07);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 5);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = heavy ? 1250 : 1900;
    bp.Q.value = 1.4;
    const ng = a.createGain();
    ng.gain.value = heavy ? 1.1 : 0.75;
    src.connect(bp).connect(ng).connect(a.destination);
    src.start(t);
    // 판이 울리는 낮은 소리
    const o = a.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(heavy ? 170 : 240, t);
    o.frequency.exponentialRampToValueAtTime(80, t + 0.1);
    const og = a.createGain();
    og.gain.setValueAtTime(heavy ? 0.55 : 0.32, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(og).connect(a.destination);
    o.start(t);
    o.stop(t + 0.15);
  }

  function fmt(sec) {
    const s = Math.max(0, Math.ceil(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderPanel() {
    const n = g.history.length;
    if (g.replay) $('title').textContent = `기보 재생 ${n} / ${g.replay.rec.moves.length}수`;
    else $('title').textContent = n > 0 ? `승강급 대국 - ${n}수` : '승강급 대국';
    for (const [id, side] of [['me-side', g.mySide], ['opp-side', g.aiSide]]) {
      $(id).textContent = side === J.CHO ? '楚' : '漢';
      $(id).className = `side-mark ${side === J.CHO ? 'cho' : 'han'}`;
    }
    $('me-score').textContent = `${J.materialScore(g.board, g.mySide).toFixed(1)}점`;
    $('opp-score').textContent = `${J.materialScore(g.board, g.aiSide).toFixed(1)}점`;
    $('me-rank').textContent = R.rankName(g.replay ? g.replay.rec.myRank : profile.rank);
    $('me-name').textContent = profile.name;
    $('opp-rank').textContent = R.rankName(g.oppRank);
    $('opp-name').textContent = g.oppName;
    const active = (g.started && !g.over) || !!g.replay;
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
    const labels = g && g.replay ? ['◀ 이전', '다음 ▶', '기록 목록'] : ['한수 쉼', '기 권', '아이템'];
    ['btn-pass', 'btn-resign', 'btn-items'].forEach((id, k) => { $(id).textContent = labels[k]; });
    if (g && g.replay) {
      $('btn-pass').disabled = g.replay.ply === 0;
      $('btn-resign').disabled = g.replay.ply >= g.replay.rec.moves.length;
      $('btn-items').disabled = false;
      return;
    }
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

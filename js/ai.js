/*
 * 장기 AI: 알파-베타(PVS) 네가맥스 + 정지 탐색 + 반복 심화
 *  - 치환표(Zobrist 해시): 이미 읽은 국면의 결과와 최선 수를 기억한다
 *  - 수 순서: 치환표 수 → 잡는 수(MVV-LVA) → 킬러 수 → 히스토리
 *  - 널 무브 가지치기: 장기는 한수 쉼이 합법이라 "한 번 쉬어도 충분히 좋은 국면"을 일찍 잘라낸다
 * 탐색 내부에서는 의사 합법수를 쓰고, 궁을 잡는 수가 있으면 즉시 승리로 본다.
 * 실력은 JanggiRanks.aiParams() 가 돌려주는 값으로 조절한다.
 */
(function (global) {
  'use strict';

  const J = global.Janggi || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const MATE = 100000;
  const EPS = 0.001; // 점수가 소수라 널 윈도우 폭으로 쓴다

  const DEFAULT_PARAMS = {
    depth: 3, timeMs: 1500, noise: 0, mistakeRate: 0, mistakeMargin: 0, quiesce: 6,
  };

  // ───────── Zobrist 해시 ─────────
  const PIECES = ['cK', 'cA', 'cE', 'cH', 'cR', 'cC', 'cP', 'hK', 'hA', 'hE', 'hH', 'hR', 'hC', 'hP'];
  const PIDX = {};
  PIECES.forEach((p, k) => { PIDX[p] = k; });
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return seed | 0;
  };
  const Z1 = new Int32Array(PIECES.length * 90);
  const Z2 = new Int32Array(PIECES.length * 90);
  for (let i = 0; i < Z1.length; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  const SIDE1 = rnd();
  const SIDE2 = rnd();

  // ───────── 치환표 ─────────
  const TT_BITS = 19;
  const TT_SIZE = 1 << TT_BITS;
  const TT_MASK = TT_SIZE - 1;
  const ttKey = new Int32Array(TT_SIZE);
  const ttLock = new Int32Array(TT_SIZE);
  const ttDepth = new Int8Array(TT_SIZE);
  const ttFlag = new Int8Array(TT_SIZE); // 0 없음, 1 정확, 2 하한, 3 상한
  const ttScore = new Float64Array(TT_SIZE);
  const ttMove = new Int32Array(TT_SIZE);
  let ttQuiesce = -1;
  const EXACT = 1;
  const LOWER = 2;
  const UPPER = 3;

  function clearTT() {
    ttFlag.fill(0);
    ttDepth.fill(0);
  }

  // 외통 점수는 "몇 수 뒤"가 국면마다 다르므로 치환표에는 현재 깊이를 뺀 값으로 저장한다
  const toTT = (s, ply) => (s > MATE / 2 ? s + ply : s < -MATE / 2 ? s - ply : s);
  const fromTT = (s, ply) => (s > MATE / 2 ? s - ply : s < -MATE / 2 ? s + ply : s);

  class Timeout extends Error {}

  function scoreFor(board, side) {
    const e = J.evaluate(board);
    return side === J.CHO ? e : -e;
  }

  function hasKingCapture(board, moves) {
    for (let i = 0; i < moves.length; i++) {
      const v = board[moves[i] & 127];
      if (v && v[1] === 'K') return true;
    }
    return false;
  }

  // 차·포·마 같은 큰 기물이 남아 있는가 (끝내기에서는 널 무브를 쓰지 않는다)
  function hasMajorPieces(board, side) {
    for (let i = 0; i < 90; i++) {
      const p = board[i];
      if (p && p[0] === side && (p[1] === 'R' || p[1] === 'C' || p[1] === 'H')) return true;
    }
    return false;
  }

  const captureScore = (board, m) => {
    const victim = board[m & 127];
    if (!victim) return 0;
    const attacker = board[m >> 7];
    return 1e6 + 100 * (J.VALUE[victim[1]] || 50) - (J.VALUE[attacker[1]] || 0);
  };

  // scores 가 가장 큰 수를 i 번째 자리로 옮긴다 (필요한 만큼만 정렬)
  function pickNext(moves, scores, i) {
    let best = i;
    for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const m = moves[i]; moves[i] = moves[best]; moves[best] = m;
      const s = scores[i]; scores[i] = scores[best]; scores[best] = s;
    }
    return moves[i];
  }

  function createSearch(deadline, quiesceDepth, useNull, useLmr) {
    let nodes = 0;
    let h1 = 0;
    let h2 = 0;
    const killers = new Int32Array(128 * 2).fill(-1);
    const history = new Float64Array(PIECES.length * 90);

    function tick() {
      if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Timeout();
    }

    function setHash(board, side) {
      h1 = 0;
      h2 = 0;
      for (let i = 0; i < 90; i++) {
        const p = board[i];
        if (p) { h1 ^= Z1[PIDX[p] * 90 + i]; h2 ^= Z2[PIDX[p] * 90 + i]; }
      }
      if (side === J.HAN) { h1 ^= SIDE1; h2 ^= SIDE2; }
    }

    // 해시를 함께 갱신하는 수 두기/무르기
    function make(board, m) {
      const from = m >> 7;
      const to = m & 127;
      const p = board[from];
      const cap = board[to];
      const pi = PIDX[p] * 90;
      h1 ^= Z1[pi + from] ^ Z1[pi + to] ^ SIDE1;
      h2 ^= Z2[pi + from] ^ Z2[pi + to] ^ SIDE2;
      if (cap) {
        const ci = PIDX[cap] * 90 + to;
        h1 ^= Z1[ci];
        h2 ^= Z2[ci];
      }
      board[to] = p;
      board[from] = null;
      return cap;
    }
    function unmake(board, m, cap) {
      const from = m >> 7;
      const to = m & 127;
      const p = board[to];
      const pi = PIDX[p] * 90;
      h1 ^= Z1[pi + from] ^ Z1[pi + to] ^ SIDE1;
      h2 ^= Z2[pi + from] ^ Z2[pi + to] ^ SIDE2;
      if (cap) {
        const ci = PIDX[cap] * 90 + to;
        h1 ^= Z1[ci];
        h2 ^= Z2[ci];
      }
      board[from] = p;
      board[to] = cap;
    }
    function flipSide() { h1 ^= SIDE1; h2 ^= SIDE2; }

    function quiesce(board, side, alpha, beta, qdepth, ply) {
      tick();
      const moves = J.pseudoMoves(board, side);
      if (hasKingCapture(board, moves)) return MATE - ply;
      const standPat = scoreFor(board, side);
      if (standPat >= beta || qdepth <= 0) return standPat;
      if (standPat > alpha) alpha = standPat;

      const caps = [];
      const scores = [];
      for (const m of moves) {
        if (board[m & 127]) { caps.push(m); scores.push(captureScore(board, m)); }
      }
      for (let i = 0; i < caps.length; i++) {
        const m = pickNext(caps, scores, i);
        const cap = J.makeMove(board, m);
        const score = -quiesce(board, J.opponent(side), -beta, -alpha, qdepth - 1, ply + 1);
        J.unmakeMove(board, m, cap);
        if (score >= beta) return score;
        if (score > alpha) alpha = score;
      }
      return alpha;
    }

    function negamax(board, side, depth, alpha, beta, ply, allowNull) {
      if (depth <= 0) return quiesce(board, side, alpha, beta, quiesceDepth, ply);
      tick();
      const alphaOrig = alpha;

      // 치환표 조회
      const idx = h1 & TT_MASK;
      let ttm = -1;
      if (ttFlag[idx] && ttKey[idx] === h1 && ttLock[idx] === h2) {
        ttm = ttMove[idx];
        if (ttDepth[idx] >= depth) {
          const s = fromTT(ttScore[idx], ply);
          const f = ttFlag[idx];
          if (f === EXACT) return s;
          if (f === LOWER && s > alpha) alpha = s;
          else if (f === UPPER && s < beta) beta = s;
          if (alpha >= beta) return s;
        }
      }

      const moves = J.pseudoMoves(board, side);
      if (hasKingCapture(board, moves)) return MATE - ply;
      const opp = J.opponent(side);

      // 널 무브: 한 번 쉬고도 beta 이상이면 이 국면은 더 볼 필요가 없다.
      // 장군 중이면 쉬는 순간 상대가 궁을 잡아 실패하므로 따로 확인하지 않아도 된다.
      if (useNull && allowNull && depth >= 3 && beta < MATE / 2 && hasMajorPieces(board, side)) {
        flipSide();
        const r = depth >= 6 ? 3 : 2;
        const s = -negamax(board, opp, depth - 1 - r, -beta, -beta + EPS, ply + 1, false);
        flipSide();
        if (s >= beta) return s;
      }

      const scores = new Array(moves.length);
      const k0 = killers[ply * 2];
      const k1 = killers[ply * 2 + 1];
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (m === ttm) scores[i] = 1e9;
        else if (board[m & 127]) scores[i] = captureScore(board, m);
        else if (m === k0) scores[i] = 9e5;
        else if (m === k1) scores[i] = 8e5;
        else scores[i] = history[PIDX[board[m >> 7]] * 90 + (m & 127)];
      }

      let best = -Infinity;
      let bestMove = -1;
      for (let i = 0; i < moves.length; i++) {
        const m = pickNext(moves, scores, i);
        const quiet = !board[m & 127] && m !== k0 && m !== k1;
        const cap = make(board, m);
        let score;
        if (i === 0) {
          score = -negamax(board, opp, depth - 1, -beta, -alpha, ply + 1, true);
        } else {
          // 뒤쪽의 조용한 수는 한 수 덜 읽어 보고, alpha 를 넘을 때만 제대로 다시 읽는다
          const reduce = useLmr && quiet && depth >= 3 && i >= 3 ? 1 : 0;
          score = -negamax(board, opp, depth - 1 - reduce, -alpha - EPS, -alpha, ply + 1, true);
          if (reduce && score > alpha) score = -negamax(board, opp, depth - 1, -alpha - EPS, -alpha, ply + 1, true);
          if (score > alpha && score < beta) score = -negamax(board, opp, depth - 1, -beta, -alpha, ply + 1, true);
        }
        unmake(board, m, cap);
        if (score > best) { best = score; bestMove = m; }
        if (score > alpha) alpha = score;
        if (alpha >= beta) {
          if (!cap) {
            if (killers[ply * 2] !== m) {
              killers[ply * 2 + 1] = killers[ply * 2];
              killers[ply * 2] = m;
            }
            history[PIDX[board[m >> 7]] * 90 + (m & 127)] += depth * depth;
          }
          break;
        }
      }

      // 둘 수 있는 수가 전혀 없으면 한수 쉼
      if (best === -Infinity) {
        flipSide();
        best = -negamax(board, opp, depth - 1, -beta, -alpha, ply + 1, false);
        flipSide();
      }

      ttKey[idx] = h1;
      ttLock[idx] = h2;
      ttDepth[idx] = depth;
      ttMove[idx] = bestMove;
      ttScore[idx] = toTT(best, ply);
      ttFlag[idx] = best <= alphaOrig ? UPPER : best >= beta ? LOWER : EXACT;
      return best;
    }

    return {
      negamax, make, unmake, setHash,
      getNodes: () => nodes,
    };
  }

  /**
   * 가장 좋은 수를 찾는다. 둘 수 있는 합법수가 없으면 move 는 null (한수 쉼).
   * params.forbidden: 반복수 등으로 둘 수 없는 수 (그것까지 빼면 둘 수가 없을 때는 무시)
   * @returns {{move: number|null, score: number, depth: number, nodes: number}}
   */
  function findBestMove(boardIn, side, paramsIn) {
    const params = { ...DEFAULT_PARAMS, ...(paramsIn || {}) };
    const board = boardIn.slice();
    let rootMoves = J.legalMoves(board, side);
    if (params.forbidden && params.forbidden.length) {
      const banned = new Set(params.forbidden);
      const allowed = rootMoves.filter((m) => !banned.has(m));
      if (allowed.length) rootMoves = allowed;
    }
    if (rootMoves.length === 0) return { move: null, score: 0, depth: 0, nodes: 0 };
    if (rootMoves.length === 1) return { move: rootMoves[0], score: 0, depth: 0, nodes: 0 };

    // 정지 탐색 깊이가 다르면 저장된 점수의 의미가 달라지므로 치환표를 비운다
    if (ttQuiesce !== params.quiesce) {
      clearTT();
      ttQuiesce = params.quiesce;
    }

    // 무작위성을 섞는 실력대는 모든 후보의 정확한 점수가 필요하므로 창을 좁히지 않는다
    const exactRoot = params.noise > 0 || params.mistakeRate > 0;
    const deadline = Date.now() + params.timeMs;
    const search = createSearch(deadline, params.quiesce, params.nullMove !== false, params.lmr !== false);
    search.setHash(board, side);
    const opp = J.opponent(side);

    let order = rootMoves.slice();
    let bestMove = order[0];
    let bestScore = -Infinity;
    let scored = [];
    let completedDepth = 0;

    for (let depth = 1; depth <= params.depth; depth++) {
      let iterBest = null;
      let iterScore = -Infinity;
      const iterScored = [];
      try {
        let alpha = -Infinity;
        for (let i = 0; i < order.length; i++) {
          const m = order[i];
          const cap = search.make(board, m);
          let score;
          try {
            if (exactRoot || i === 0) {
              score = -search.negamax(board, opp, depth - 1, -Infinity, exactRoot ? Infinity : -alpha, 1, true);
            } else {
              score = -search.negamax(board, opp, depth - 1, -alpha - EPS, -alpha, 1, true);
              if (score > alpha) score = -search.negamax(board, opp, depth - 1, -Infinity, -alpha, 1, true);
            }
          } finally {
            search.unmake(board, m, cap);
          }
          iterScored.push({ m, score });
          if (score > iterScore) {
            iterScore = score;
            iterBest = m;
          }
          if (score > alpha && !exactRoot) alpha = score;
        }
      } catch (e) {
        if (!(e instanceof Timeout)) throw e;
        // 시간이 다 돼 이번 깊이를 끝내지 못했어도, 다 읽은 후보 중 지난 깊이의 최선보다
        // 나은 수가 있으면 그 수를 쓴다 (첫 후보는 지난 깊이의 최선 수다).
        // 무작위를 섞는 실력대는 모든 후보 점수가 필요하므로 지난 깊이 결과를 그대로 쓴다.
        if (!exactRoot && iterBest !== null && iterBest !== bestMove && iterScore > -MATE / 2) {
          bestMove = iterBest;
          bestScore = iterScore;
        }
        break;
      }
      completedDepth = depth;
      bestMove = iterBest;
      bestScore = iterScore;
      scored = iterScored;
      // 다음 깊이는 이번에 좋았던 수부터 읽는다
      order = iterScored.slice().sort((a, b) => b.score - a.score).map((o) => o.m);
      if (Math.abs(bestScore) > MATE / 2) break; // 외통수를 찾았다
    }

    // 약한 급수일수록 사람처럼 실수한다. 단, 지는 외통수를 그냥 내주거나
    // 이기는 외통수를 놓치지는 않게 한다.
    if (exactRoot && scored.length > 1 && Math.abs(bestScore) < MATE / 2) {
      const candidates = scored.filter((o) => o.score > -MATE / 2);
      if (Math.random() < params.mistakeRate) {
        const pool = candidates.filter((o) => o.score >= bestScore - params.mistakeMargin);
        if (pool.length > 0) bestMove = pool[Math.floor(Math.random() * pool.length)].m;
      } else {
        const pool = candidates.filter((o) => o.score >= bestScore - params.noise);
        let pick = null;
        let pickScore = -Infinity;
        for (const { m, score } of pool) {
          const noisy = score + Math.random() * (params.noise + 0.01);
          if (noisy > pickScore) {
            pickScore = noisy;
            pick = m;
          }
        }
        if (pick !== null) bestMove = pick;
      }
    }

    return { move: bestMove, score: bestScore, depth: completedDepth, nodes: search.getNodes() };
  }

  const JanggiAI = { findBestMove, MATE, clearTT };
  if (typeof module !== 'undefined' && module.exports) module.exports = JanggiAI;
  global.JanggiAI = JanggiAI;
})(typeof self !== 'undefined' ? self : this);

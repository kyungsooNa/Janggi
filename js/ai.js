/*
 * 장기 AI: 알파-베타 네가맥스 + 정지 탐색 + 반복 심화
 * 탐색 내부에서는 의사 합법수를 쓰고, 궁을 잡는 수가 있으면 즉시 승리로 본다.
 * 실력은 JanggiRanks.aiParams() 가 돌려주는 값으로 조절한다.
 */
(function (global) {
  'use strict';

  const J = global.Janggi || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const MATE = 100000;

  const DEFAULT_PARAMS = {
    depth: 3, timeMs: 1500, noise: 0, mistakeRate: 0, mistakeMargin: 0, quiesce: 6,
  };

  class Timeout extends Error {}

  function scoreFor(board, side) {
    const e = J.evaluate(board);
    return side === J.CHO ? e : -e;
  }

  // 잡는 수를 먼저 (가치가 큰 기물을 값싼 기물로 잡는 순서)
  function orderMoves(board, moves, first) {
    const keyed = moves.map((m) => {
      let k = 0;
      if (m === first) k = 1e6;
      const victim = board[J.moveTo(m)];
      if (victim) {
        const attacker = board[J.moveFrom(m)];
        k += 100 * (J.VALUE[victim[1]] || 50) - (J.VALUE[attacker[1]] || 0);
      }
      return { m, k };
    });
    keyed.sort((a, b) => b.k - a.k);
    return keyed.map((o) => o.m);
  }

  function hasKingCapture(board, moves) {
    for (let i = 0; i < moves.length; i++) {
      const v = board[J.moveTo(moves[i])];
      if (v && v[1] === 'K') return true;
    }
    return false;
  }

  function createSearch(deadline, quiesceDepth) {
    let nodes = 0;

    function tick() {
      if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Timeout();
    }

    function quiesce(board, side, alpha, beta, qdepth, ply) {
      tick();
      const moves = J.pseudoMoves(board, side);
      if (hasKingCapture(board, moves)) return MATE - ply;
      const standPat = scoreFor(board, side);
      if (standPat >= beta || qdepth <= 0) return standPat;
      if (standPat > alpha) alpha = standPat;

      const captures = orderMoves(board, moves.filter((m) => board[J.moveTo(m)]));
      for (const m of captures) {
        const cap = J.makeMove(board, m);
        const score = -quiesce(board, J.opponent(side), -beta, -alpha, qdepth - 1, ply + 1);
        J.unmakeMove(board, m, cap);
        if (score >= beta) return score;
        if (score > alpha) alpha = score;
      }
      return alpha;
    }

    function negamax(board, side, depth, alpha, beta, ply) {
      if (depth <= 0) return quiesce(board, side, alpha, beta, quiesceDepth, ply);
      tick();
      const moves = J.pseudoMoves(board, side);
      if (hasKingCapture(board, moves)) return MATE - ply;
      let best = -Infinity;
      for (const m of orderMoves(board, moves)) {
        const cap = J.makeMove(board, m);
        const score = -negamax(board, J.opponent(side), depth - 1, -beta, -alpha, ply + 1);
        J.unmakeMove(board, m, cap);
        if (score > best) best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;
      }
      // 둘 수 있는 수가 전혀 없으면 한수 쉼
      if (best === -Infinity) {
        best = -negamax(board, J.opponent(side), depth - 1, -beta, -alpha, ply + 1);
      }
      return best;
    }

    return { negamax, getNodes: () => nodes };
  }

  /**
   * 가장 좋은 수를 찾는다. 둘 수 있는 합법수가 없으면 move 는 null (한수 쉼).
   * @returns {{move: number|null, score: number, depth: number, nodes: number}}
   */
  function findBestMove(boardIn, side, paramsIn) {
    const params = { ...DEFAULT_PARAMS, ...(paramsIn || {}) };
    const board = boardIn.slice();
    const rootMoves = J.legalMoves(board, side);
    if (rootMoves.length === 0) return { move: null, score: 0, depth: 0, nodes: 0 };
    if (rootMoves.length === 1) return { move: rootMoves[0], score: 0, depth: 0, nodes: 0 };

    // 무작위성을 섞는 실력대는 모든 후보의 정확한 점수가 필요하므로 창을 좁히지 않는다
    const exactRoot = params.noise > 0 || params.mistakeRate > 0;
    const deadline = Date.now() + params.timeMs;
    const search = createSearch(deadline, params.quiesce);
    let bestMove = rootMoves[0];
    let bestScore = -Infinity;
    let scored = [];
    let completedDepth = 0;

    for (let depth = 1; depth <= params.depth; depth++) {
      let iterBest = null;
      let iterScore = -Infinity;
      const iterScored = [];
      try {
        let alpha = -Infinity;
        for (const m of orderMoves(board, rootMoves, bestMove)) {
          const cap = J.makeMove(board, m);
          let score;
          try {
            score = -search.negamax(board, J.opponent(side), depth - 1, -Infinity, -alpha, 1);
          } finally {
            J.unmakeMove(board, m, cap);
          }
          iterScored.push({ m, score });
          if (score > iterScore) {
            iterScore = score;
            iterBest = m;
          }
          if (score > alpha && !exactRoot) alpha = score;
        }
      } catch (e) {
        if (e instanceof Timeout) break;
        throw e;
      }
      completedDepth = depth;
      bestMove = iterBest;
      bestScore = iterScore;
      scored = iterScored;
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

  const JanggiAI = { findBestMove, MATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = JanggiAI;
  global.JanggiAI = JanggiAI;
})(typeof self !== 'undefined' ? self : this);

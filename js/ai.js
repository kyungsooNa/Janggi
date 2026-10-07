/*
 * 장기 AI: 알파-베타 네가맥스 + 정지 탐색 + 반복 심화
 * 탐색 내부에서는 의사 합법수를 쓰고, 궁을 잡는 수가 있으면 즉시 승리로 본다.
 */
(function (global) {
  'use strict';

  const J = global.Janggi || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const MATE = 100000;
  const QUIESCE_MAX = 6;

  const LEVELS = {
    easy: { depth: 1, timeMs: 400, noise: 2.5 },
    normal: { depth: 3, timeMs: 1500, noise: 0.3 },
    hard: { depth: 5, timeMs: 3500, noise: 0 },
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

  function createSearch(deadline) {
    let nodes = 0;

    function tick() {
      if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Timeout();
    }

    function quiesce(board, side, alpha, beta, qdepth, ply) {
      tick();
      const moves = J.pseudoMoves(board, side);
      for (const m of moves) {
        const v = board[J.moveTo(m)];
        if (v && v[1] === 'K') return MATE - ply;
      }
      const standPat = scoreFor(board, side);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
      if (qdepth <= 0) return standPat;

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
      if (depth <= 0) return quiesce(board, side, alpha, beta, QUIESCE_MAX, ply);
      tick();
      const moves = J.pseudoMoves(board, side);
      for (const m of moves) {
        const v = board[J.moveTo(m)];
        if (v && v[1] === 'K') return MATE - ply;
      }
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
   * 가장 좋은 수를 찾는다. 둘 수 있는 합법수가 없으면 null (한수 쉼).
   * @returns {{move: number|null, score: number, depth: number, nodes: number}}
   */
  function findBestMove(boardIn, side, levelName) {
    const level = LEVELS[levelName] || LEVELS.normal;
    const board = boardIn.slice();
    const rootMoves = J.legalMoves(board, side);
    if (rootMoves.length === 0) return { move: null, score: 0, depth: 0, nodes: 0 };
    if (rootMoves.length === 1) return { move: rootMoves[0], score: 0, depth: 0, nodes: 0 };

    const deadline = Date.now() + level.timeMs;
    const search = createSearch(deadline);
    let bestMove = rootMoves[0];
    let bestScore = -Infinity;
    let completedDepth = 0;

    for (let depth = 1; depth <= level.depth; depth++) {
      let iterBest = null;
      let iterScore = -Infinity;
      const scored = [];
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
          scored.push({ m, score });
          if (score > iterScore) {
            iterScore = score;
            iterBest = m;
          }
          // 무작위성을 섞는 단계는 모든 수의 정확한 점수가 필요하므로 창을 좁히지 않는다
          if (score > alpha && level.noise === 0) alpha = score;
        }
      } catch (e) {
        if (e instanceof Timeout) break;
        throw e;
      }
      completedDepth = depth;
      bestMove = iterBest;
      bestScore = iterScore;

      // 쉬움 단계는 일부러 조금 흔들어서 사람 같은 실수를 하게 한다
      if (level.noise > 0 && depth === level.depth && Math.abs(bestScore) < MATE / 2) {
        let pick = null;
        let pickScore = -Infinity;
        for (const { m, score } of scored) {
          if (score < -MATE / 2) continue;
          const noisy = score + Math.random() * level.noise;
          if (noisy > pickScore) {
            pickScore = noisy;
            pick = m;
          }
        }
        if (pick !== null) bestMove = pick;
      }
      if (Math.abs(bestScore) > MATE / 2) break; // 외통수를 찾았다
    }

    return { move: bestMove, score: bestScore, depth: completedDepth, nodes: search.getNodes() };
  }

  const JanggiAI = { findBestMove, LEVELS, MATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = JanggiAI;
  global.JanggiAI = JanggiAI;
})(typeof self !== 'undefined' ? self : this);

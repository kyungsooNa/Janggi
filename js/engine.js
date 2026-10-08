/*
 * 장기 규칙 엔진
 *
 * 판은 9줄(x: 0~8) × 10줄(y: 0~9) = 90개의 교차점이며, 위쪽(y=0)이 한(漢),
 * 아래쪽(y=9)이 초(楚)의 진영이다. 각 칸은 null 또는 두 글자 문자열이다.
 *   첫 글자: 진영 ('c' = 초, 'h' = 한)
 *   둘째 글자: 기물 (K 궁, A 사, E 상, H 마, R 차, C 포, P 졸/병)
 * 수(move)는 정수 하나로 표현한다: (from << 7) | to
 */
(function (global) {
  'use strict';

  const COLS = 9;
  const ROWS = 10;
  const CHO = 'c';
  const HAN = 'h';
  const HAN_BONUS = 1.5; // 후수인 한에게 주는 덤
  const MIN_SCORE = 10;  // 남은 기물 점수가 이 점수 이하가 되면 패배

  const VALUE = { K: 0, R: 13, C: 7, H: 5, E: 3, A: 3, P: 2 };

  const NAME = {
    c: { K: '초', A: '사', E: '상', H: '마', R: '차', C: '포', P: '졸' },
    h: { K: '한', A: '사', E: '상', H: '마', R: '차', C: '포', P: '병' },
  };
  const HANJA = {
    c: { K: '楚', A: '士', E: '象', H: '馬', R: '車', C: '包', P: '卒' },
    h: { K: '漢', A: '士', E: '象', H: '馬', R: '車', C: '包', P: '兵' },
  };

  // 마·상 배치 (자기 진영에서 바라본 왼쪽부터 b, c, g, h 자리)
  const SETUPS = {
    '마상마상': 'HEHE',
    '상마상마': 'EHEH',
    '마상상마': 'HEEH',
    '상마마상': 'EHHE',
  };

  const ORTH = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  // [다리 dx, 다리 dy, 도착 dx, 도착 dy]
  const HORSE = [
    [0, -1, -1, -2], [0, -1, 1, -2], [0, 1, -1, 2], [0, 1, 1, 2],
    [-1, 0, -2, -1], [-1, 0, -2, 1], [1, 0, 2, -1], [1, 0, 2, 1],
  ];
  // [1단계 dx, dy, 2단계 dx, dy, 도착 dx, dy]
  const ELEPHANT = [
    [0, -1, -1, -2, -2, -3], [0, -1, 1, -2, 2, -3],
    [0, 1, -1, 2, -2, 3], [0, 1, 1, 2, 2, 3],
    [-1, 0, -2, -1, -3, -2], [-1, 0, -2, 1, -3, 2],
    [1, 0, 2, -1, 3, -2], [1, 0, 2, 1, 3, 2],
  ];

  const idx = (x, y) => y * COLS + x;
  const xOf = (i) => i % COLS;
  const yOf = (i) => (i / COLS) | 0;
  const inBoard = (x, y) => x >= 0 && x < COLS && y >= 0 && y < ROWS;
  const opponent = (side) => (side === CHO ? HAN : CHO);
  const moveFrom = (m) => m >> 7;
  const moveTo = (m) => m & 127;
  const makeMoveCode = (from, to) => (from << 7) | to;

  // 궁성 안이면 그 궁성의 주인('h' / 'c'), 아니면 null
  function palaceOf(x, y) {
    if (x < 3 || x > 5) return null;
    if (y <= 2) return HAN;
    if (y >= 7) return CHO;
    return null;
  }

  // 궁성 대각선이 지나는 점(중앙과 네 귀퉁이)인가
  function isDiagPoint(x, y) {
    const p = palaceOf(x, y);
    if (!p) return false;
    const cy = p === HAN ? 1 : 8;
    if (x === 4 && y === cy) return true;
    return (x === 3 || x === 5) && (y === cy - 1 || y === cy + 1);
  }

  // 궁성 대각선을 따라 한 칸 이동한 점의 인덱스, 불가능하면 -1
  function diagStep(x, y, dx, dy) {
    if (!isDiagPoint(x, y)) return -1;
    const nx = x + dx;
    const ny = y + dy;
    if (!inBoard(nx, ny) || !isDiagPoint(nx, ny)) return -1;
    if (palaceOf(nx, ny) !== palaceOf(x, y)) return -1;
    return idx(nx, ny);
  }

  function initialBoard(choSetup, hanSetup) {
    const b = new Array(COLS * ROWS).fill(null);
    const place = (side, backY, kingY, cannonY, pawnY, setup, slots) => {
      const s = side;
      b[idx(0, backY)] = s + 'R';
      b[idx(8, backY)] = s + 'R';
      b[idx(3, backY)] = s + 'A';
      b[idx(5, backY)] = s + 'A';
      const letters = SETUPS[setup] || SETUPS['마상마상'];
      for (let k = 0; k < 4; k++) b[idx(slots[k], backY)] = s + letters[k];
      b[idx(4, kingY)] = s + 'K';
      b[idx(1, cannonY)] = s + 'C';
      b[idx(7, cannonY)] = s + 'C';
      for (let x = 0; x < COLS; x += 2) b[idx(x, pawnY)] = s + 'P';
    };
    place(CHO, 9, 8, 7, 6, choSetup, [1, 2, 6, 7]);
    // 한은 판 위쪽에서 아래를 보므로 자기 왼쪽이 x=7 이다
    place(HAN, 0, 1, 2, 3, hanSetup, [7, 6, 2, 1]);
    return b;
  }

  function pushIfNotOwn(board, side, from, to, moves) {
    const t = board[to];
    if (!t || t[0] !== side) moves.push(makeMoveCode(from, to));
  }

  function genPieceMoves(board, from, moves) {
    const p = board[from];
    const side = p[0];
    const type = p[1];
    const x = xOf(from);
    const y = yOf(from);

    switch (type) {
      case 'K':
      case 'A': {
        for (const [dx, dy] of ORTH) {
          const nx = x + dx;
          const ny = y + dy;
          if (inBoard(nx, ny) && palaceOf(nx, ny) === side) {
            pushIfNotOwn(board, side, from, idx(nx, ny), moves);
          }
        }
        for (const [dx, dy] of DIAG) {
          const j = diagStep(x, y, dx, dy);
          if (j >= 0) pushIfNotOwn(board, side, from, j, moves);
        }
        break;
      }

      case 'H': {
        for (const [lx, ly, tx, ty] of HORSE) {
          const ax = x + lx;
          const ay = y + ly;
          const nx = x + tx;
          const ny = y + ty;
          if (!inBoard(nx, ny) || board[idx(ax, ay)]) continue;
          pushIfNotOwn(board, side, from, idx(nx, ny), moves);
        }
        break;
      }

      case 'E': {
        for (const [ax, ay, bx, by, tx, ty] of ELEPHANT) {
          const nx = x + tx;
          const ny = y + ty;
          if (!inBoard(nx, ny)) continue;
          if (board[idx(x + ax, y + ay)] || board[idx(x + bx, y + by)]) continue;
          pushIfNotOwn(board, side, from, idx(nx, ny), moves);
        }
        break;
      }

      case 'R': {
        for (const [dx, dy] of ORTH) {
          let nx = x + dx;
          let ny = y + dy;
          while (inBoard(nx, ny)) {
            const j = idx(nx, ny);
            const q = board[j];
            if (q) {
              if (q[0] !== side) moves.push(makeMoveCode(from, j));
              break;
            }
            moves.push(makeMoveCode(from, j));
            nx += dx;
            ny += dy;
          }
        }
        for (const [dx, dy] of DIAG) {
          let cx = x;
          let cy = y;
          for (;;) {
            const j = diagStep(cx, cy, dx, dy);
            if (j < 0) break;
            const q = board[j];
            if (q) {
              if (q[0] !== side) moves.push(makeMoveCode(from, j));
              break;
            }
            moves.push(makeMoveCode(from, j));
            cx = xOf(j);
            cy = yOf(j);
          }
        }
        break;
      }

      case 'C': {
        // 포는 반드시 포가 아닌 기물 하나를 넘어야 하고, 포는 잡을 수 없다
        for (const [dx, dy] of ORTH) {
          let nx = x + dx;
          let ny = y + dy;
          let jumped = false;
          while (inBoard(nx, ny)) {
            const j = idx(nx, ny);
            const q = board[j];
            if (!jumped) {
              if (q) {
                if (q[1] === 'C') break;
                jumped = true;
              }
            } else if (!q) {
              moves.push(makeMoveCode(from, j));
            } else {
              if (q[0] !== side && q[1] !== 'C') moves.push(makeMoveCode(from, j));
              break;
            }
            nx += dx;
            ny += dy;
          }
        }
        for (const [dx, dy] of DIAG) {
          const mid = diagStep(x, y, dx, dy);
          if (mid < 0) continue;
          const screen = board[mid];
          if (!screen || screen[1] === 'C') continue;
          const j = diagStep(xOf(mid), yOf(mid), dx, dy);
          if (j < 0) continue;
          const q = board[j];
          if (!q || (q[0] !== side && q[1] !== 'C')) moves.push(makeMoveCode(from, j));
        }
        break;
      }

      case 'P': {
        const f = side === CHO ? -1 : 1;
        for (const [dx, dy] of [[0, f], [-1, 0], [1, 0]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (inBoard(nx, ny)) pushIfNotOwn(board, side, from, idx(nx, ny), moves);
        }
        for (const dx of [-1, 1]) {
          const j = diagStep(x, y, dx, f);
          if (j >= 0) pushIfNotOwn(board, side, from, j, moves);
        }
        break;
      }

      default:
        break;
    }
  }

  // 자기 궁이 잡히는지는 따지지 않은 수 목록
  function pseudoMoves(board, side) {
    const moves = [];
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (p && p[0] === side) genPieceMoves(board, i, moves);
    }
    return moves;
  }

  function findKing(board, side) {
    const k = side + 'K';
    // 궁은 궁성 밖으로 나갈 수 없으므로 궁성만 찾아본다
    const ys = side === HAN ? [0, 1, 2] : [7, 8, 9];
    for (const y of ys) {
      for (let x = 3; x <= 5; x++) {
        if (board[idx(x, y)] === k) return idx(x, y);
      }
    }
    return -1;
  }

  function isAttacked(board, target, bySide) {
    const moves = pseudoMoves(board, bySide);
    for (let i = 0; i < moves.length; i++) {
      if (moveTo(moves[i]) === target) return true;
    }
    return false;
  }

  function inCheck(board, side) {
    const k = findKing(board, side);
    if (k < 0) return true;
    return isAttacked(board, k, opponent(side));
  }

  function makeMove(board, m) {
    const from = moveFrom(m);
    const to = moveTo(m);
    const captured = board[to];
    board[to] = board[from];
    board[from] = null;
    return captured;
  }

  function unmakeMove(board, m, captured) {
    const from = moveFrom(m);
    const to = moveTo(m);
    board[from] = board[to];
    board[to] = captured;
  }

  function legalMoves(board, side) {
    const result = [];
    for (const m of pseudoMoves(board, side)) {
      const cap = makeMove(board, m);
      if (!inCheck(board, side)) result.push(m);
      unmakeMove(board, m, cap);
    }
    return result;
  }

  function legalMovesFrom(board, from) {
    const p = board[from];
    if (!p) return [];
    const side = p[0];
    const moves = [];
    genPieceMoves(board, from, moves);
    return moves.filter((m) => {
      const cap = makeMove(board, m);
      const ok = !inCheck(board, side);
      unmakeMove(board, m, cap);
      return ok;
    });
  }

  // 국면 식별자: 판 모양 + 둘 차례
  function positionKey(board, sideToMove) {
    let k = '';
    for (let i = 0; i < board.length; i++) k += board[i] || '..';
    return k + sideToMove;
  }

  /*
   * 반복수 금지: 둔 뒤의 국면이 이미 limit 번(기본 2번) 나왔던 수는 뺀다.
   * 즉 같은 국면을 세 번째로 만드는 수는 둘 수 없다.
   * counts 는 positionKey → 나온 횟수 Map.
   */
  function nonRepeatingMoves(board, side, moves, counts, limit) {
    const max = limit || 2;
    const next = opponent(side);
    return moves.filter((m) => {
      const cap = makeMove(board, m);
      const n = counts.get(positionKey(board, next)) || 0;
      unmakeMove(board, m, cap);
      return n < max;
    });
  }

  // 반복수로 둘 수 없는 수 목록. 그것까지 빼면 둘 수가 없을 때는 아무것도 막지 않는다.
  function repetitionForbidden(board, side, legal, counts) {
    const ok = nonRepeatingMoves(board, side, legal, counts);
    if (ok.length === 0) return [];
    const okSet = new Set(ok);
    return legal.filter((m) => !okSet.has(m));
  }

  // 한수 쉼이 반복수가 되는가
  function passRepeats(board, side, counts, limit) {
    return (counts.get(positionKey(board, opponent(side))) || 0) >= (limit || 2);
  }

  // 남은 기물 점수가 패배 기준(10점) 이하인가
  function belowMinScore(board, side) {
    return materialScore(board, side) <= MIN_SCORE;
  }

  /*
   * 대국이 끝났는지 판정한다. side 는 이제 둘 차례인 쪽, legal 은 그 쪽의 합법수, plies 는 지금까지 둔 수.
   * 순서: 점수 미달(10점 이하) → 외통 → 수 한도 점수 판정. 끝나지 않았으면 null.
   */
  function gameOutcome(board, side, legal, plies, moveLimit) {
    if (belowMinScore(board, side)) return { winner: opponent(side), reason: '점수 미달' };
    if (legal.length === 0 && inCheck(board, side)) return { winner: opponent(side), reason: '외통' };
    if (plies >= moveLimit) {
      const cho = materialScore(board, CHO);
      const han = materialScore(board, HAN);
      return { winner: cho > han ? CHO : HAN, reason: `${moveLimit}수 점수 판정` };
    }
    return null;
  }

  // 남은 기물 점수 (한은 덤 포함)
  function materialScore(board, side) {
    let s = side === HAN ? HAN_BONUS : 0;
    for (const p of board) if (p && p[0] === side) s += VALUE[p[1]];
    return s;
  }

  // 위치 보너스: 기물별 간단한 가중치 (초 기준 좌표, 한은 위아래 뒤집어 적용)
  function positional(type, side, x, y) {
    const ry = side === CHO ? y : 9 - y; // 자기 진영 끝이 9
    const advance = 9 - ry; // 앞으로 나간 정도 (0 ~ 9)
    const center = 4 - Math.abs(4 - x);
    switch (type) {
      case 'P': {
        let v = 0;
        if (advance >= 4) v += 0.15 * (advance - 3);
        if (advance >= 7 && x >= 3 && x <= 5) v += 0.4; // 상대 궁성 진입
        if (advance === 9) v -= 0.3; // 맨 끝 줄 졸은 쓸모가 줄어든다
        return v;
      }
      case 'H':
        return 0.08 * center + (advance >= 2 && advance <= 5 ? 0.15 : 0);
      case 'C':
        return x === 4 ? 0.2 : 0;
      case 'R':
        return 0.05 * center;
      case 'E':
        return 0.04 * center;
      default:
        return 0;
    }
  }

  // 초 입장에서의 평가값 (양수면 초 유리)
  function evaluate(board) {
    let score = -HAN_BONUS;
    for (let i = 0; i < board.length; i++) {
      const p = board[i];
      if (!p) continue;
      const v = VALUE[p[1]] + positional(p[1], p[0], xOf(i), yOf(i));
      score += p[0] === CHO ? v : -v;
    }
    return score;
  }

  /*
   * 평가 v2 (초 입장, 양수면 초 유리). v1 에 더해:
   *  - 차: 움직일 수 있는 칸 수(활동성)
   *  - 마: 멱에 막히지 않은 갈 곳 수, 변두리 감점
   *  - 포: 기물이 줄어 넘을 기물이 없어질수록 가치가 떨어진다, 중앙 포 가산
   *  - 졸: 옆에 같은 편 졸이 붙어 있으면 가산
   *  - 궁 안전: 사가 없으면 감점, 상대 공격 기물이 내 궁성 근처에 오면 감점
   */
  const W2 = {
    rookMob: 0.05, horseMob: 0.12, horseEdge: 0.3, cannonEnd: 1.5, cannonCenter: 0.2,
    pawnLink: 0.12, noAdvisor: 0.9, oneAdvisor: 0.3, intruder: 0.3, pawnIntruder: 0.15,
  };

  // 마 이동 [다리, 도착] 을 칸 번호 차이로 미리 풀어 둔다 (평가에서 자주 쓰므로)
  const HORSE_D = HORSE.map(([lx, ly, tx, ty]) => [lx, ly, tx, ty]);

  function evaluateV2(board) {
    let score = -HAN_BONUS;
    let majors = 0; // 차·포·마·상 수 (국면 단계)
    let cannonSign = 0; // 초 포 수 - 한 포 수
    let advC = 0;
    let advH = 0;

    for (let i = 0; i < 90; i++) {
      const p = board[i];
      if (p === null) continue;
      const side = p[0];
      const t = p[1];
      const cho = side === CHO;
      const x = i % 9;
      const y = (i / 9) | 0;
      let v = VALUE[t] + positional(t, side, x, y);

      if (t === 'R') {
        majors++;
        let mob = 0;
        for (let nx = x - 1; nx >= 0; nx--) { const q = board[y * 9 + nx]; if (q !== null) { if (q[0] !== side) mob++; break; } mob++; }
        for (let nx = x + 1; nx < 9; nx++) { const q = board[y * 9 + nx]; if (q !== null) { if (q[0] !== side) mob++; break; } mob++; }
        for (let ny = y - 1; ny >= 0; ny--) { const q = board[ny * 9 + x]; if (q !== null) { if (q[0] !== side) mob++; break; } mob++; }
        for (let ny = y + 1; ny < 10; ny++) { const q = board[ny * 9 + x]; if (q !== null) { if (q[0] !== side) mob++; break; } mob++; }
        v += W2.rookMob * mob;
      } else if (t === 'H') {
        majors++;
        let mob = 0;
        for (let k = 0; k < 8; k++) {
          const d = HORSE_D[k];
          const nx = x + d[2];
          const ny = y + d[3];
          if (nx < 0 || nx > 8 || ny < 0 || ny > 9) continue;
          if (board[(y + d[1]) * 9 + x + d[0]] !== null) continue;
          const q = board[ny * 9 + nx];
          if (q === null || q[0] !== side) mob++;
        }
        v += W2.horseMob * mob;
        if (x === 0 || x === 8) v -= W2.horseEdge;
      } else if (t === 'C') {
        majors++;
        cannonSign += cho ? 1 : -1;
        if (x === 4) v += W2.cannonCenter;
      } else if (t === 'E') {
        majors++;
      } else if (t === 'P') {
        if (x > 0 && board[i - 1] === p) v += W2.pawnLink;
      } else if (t === 'A') {
        if (cho) advC++; else advH++;
      }

      // 상대 궁성 근처(상대 끝 줄에서 네 줄 안, 2~6열)에 들어간 공격 기물
      if (x >= 2 && x <= 6 && t !== 'K' && t !== 'A' && t !== 'E') {
        const depthIn = cho ? y : 9 - y;
        if (depthIn <= 3) v += t === 'P' ? W2.pawnIntruder : W2.intruder;
      }

      score += cho ? v : -v;
    }

    // 기물이 줄수록 포는 넘을 기물이 없어 약해진다
    const phase = majors >= 16 ? 1 : majors / 16;
    score -= cannonSign * W2.cannonEnd * (1 - phase);
    const advPen = (n) => (n === 0 ? W2.noAdvisor : n === 1 ? W2.oneAdvisor : 0);
    score += advPen(advH) - advPen(advC);
    return score;
  }

  // 기보 표기: 행(1~9, 0) + 열(1~9) + 기물 + 도착 행열. 예) 79졸78
  function squareName(i) {
    return String((yOf(i) + 1) % 10) + String(xOf(i) + 1);
  }

  function notation(piece, m) {
    return squareName(moveFrom(m)) + NAME[piece[0]][piece[1]] + squareName(moveTo(m));
  }

  const Janggi = {
    COLS, ROWS, CHO, HAN, VALUE, NAME, HANJA, SETUPS, HAN_BONUS, MIN_SCORE, belowMinScore,
    idx, xOf, yOf, inBoard, opponent, palaceOf, isDiagPoint,
    moveFrom, moveTo, makeMoveCode,
    initialBoard, pseudoMoves, legalMoves, legalMovesFrom,
    makeMove, unmakeMove, findKing, inCheck, isAttacked,
    positionKey, nonRepeatingMoves, repetitionForbidden, passRepeats, gameOutcome,
    materialScore, evaluate, evaluateV2, notation, squareName,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Janggi;
  global.Janggi = Janggi;
})(typeof self !== 'undefined' ? self : this);

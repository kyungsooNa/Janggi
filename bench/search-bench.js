// 탐색 속도 측정: 정해진 국면들에서 깊이 N까지 다 읽는 데 걸리는 시간과 노드 수.
//   node bench/search-bench.js [깊이=5]
const J = require('../js/engine.js');
const AI = require('../js/ai.js');

const depth = Number(process.argv[2] || 5);

// 시작 국면과, 시작에서 정해진 수순을 둔 중반 국면들
function positions() {
  const list = [];
  const b0 = J.initialBoard('마상마상', '상마상마');
  list.push(['시작', b0, 'c']);
  // 같은 결과가 나오도록 고정된 AI(깊이 2, 무작위 없음)로 수를 진행해 중반 국면을 만든다
  const b = b0.slice();
  let side = 'c';
  for (let ply = 1; ply <= 40; ply++) {
    const r = AI.findBestMove(b, side, { depth: 2, timeMs: 1e9, quiesce: 4 });
    if (r.move === null) break;
    J.makeMove(b, r.move);
    side = J.opponent(side);
    if (ply === 20 || ply === 40) list.push([`${ply}수 뒤`, b.slice(), side]);
  }
  return list;
}

let totalMs = 0;
let totalNodes = 0;
for (const [name, board, side] of positions()) {
  const t = Date.now();
  const r = AI.findBestMove(board, side, { depth, timeMs: 1e9, quiesce: 6 });
  const ms = Date.now() - t;
  totalMs += ms;
  totalNodes += r.nodes;
  console.log(`${name.padEnd(8)} 깊이 ${r.depth}  ${String(ms).padStart(6)}ms  노드 ${String(r.nodes).padStart(9)}  ${Math.round(r.nodes / Math.max(1, ms))}k/s  수 ${J.notation(board[J.moveFrom(r.move)], r.move)}  점수 ${r.score.toFixed(2)}`);
}
console.log(`합계 ${totalMs}ms, 노드 ${totalNodes}`);

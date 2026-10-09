// 급수별 AI끼리 대국시켜 실제로 위 급수가 더 잘 두는지 잰다.
//   node scripts/tournament.js                 기본: 8개 급수, 이웃 급수끼리 8판씩
//   node scripts/tournament.js --games 4 --ranks 0,8,16,26 --workers 4 --out result.json
// 게임 규칙은 화면과 같다(카카오장기 방식): 반복수 금지(궁·사 제외), 둘 수 없으면 한수 쉼,
// 10점 이하 + 연속 한수 쉼이면 기물 판정, 200수 기물 판정(잡기·장군이면 연장).
const { Worker, isMainThread, parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const J = require('../js/engine.js');
const AI = require('../js/ai.js');
const R = require('../js/ranks.js');

const MOVE_LIMIT = 200;
const SETUPS = Object.keys(J.SETUPS);

// 한 판을 끝까지 둔다. choParams / hanParams 는 findBestMove 에 넘길 AI 설정.
// 승패 판정은 화면(main.js)과 같은 J.gameOutcome · J.repetitionForbidden 을 쓴다.
// randomPlies: 처음 몇 수를 무작위로 둬서 같은 설정끼리도 매번 다른 판이 되게 한다.
function playGame({ choParams, hanParams, choSetup, hanSetup, randomPlies = 0 }) {
  const board = J.initialBoard(choSetup, hanSetup);
  const counts = new Map();
  const seen = (side) => {
    const k = J.positionKey(board, side);
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  let turn = J.CHO;
  seen(turn);
  let plies = 0;
  let passes = 0; // 연속 한수 쉼 수
  let lastCapture = false;
  const started = Date.now();
  for (;;) {
    const legal = J.legalMoves(board, turn);
    const ctx = {
      bothPassed: passes >= 2,
      lastPassBy: passes > 0 ? J.opponent(turn) : null,
      lastActive: lastCapture || J.inCheck(board, turn),
      noMate: AI.noMatePossible(board),
    };
    const outcome = J.gameOutcome(board, turn, legal, plies, MOVE_LIMIT, ctx);
    if (outcome) {
      return { ...outcome, plies, ms: Date.now() - started, score: [J.materialScore(board, J.CHO), J.materialScore(board, J.HAN)] };
    }
    const forbidden = J.repetitionForbidden(board, turn, legal, counts);
    const params = turn === J.CHO ? choParams : hanParams;
    let res;
    // 화면과 같이: 한쪽이 10점 이하이고 둘 차례인 쪽이 앞서면 한수 쉼으로 기물승을 가져간다
    const claim = (J.belowMinScore(board, J.CHO) || J.belowMinScore(board, J.HAN)) && J.scoreLeader(board) === turn
      && !J.inCheck(board, turn) && !J.passRepeats(board, turn, counts);
    if (!legal.length || claim) res = { move: null };
    else if (plies < randomPlies) res = { move: legal[Math.floor(Math.random() * legal.length)] };
    else res = AI.findBestMove(board, turn, { ...params, forbidden });
    if (res.move !== null) {
      lastCapture = !!J.makeMove(board, res.move);
      passes = 0;
    } else {
      lastCapture = false;
      passes++;
    }
    turn = J.opponent(turn);
    plies++;
    seen(turn);
  }
}

module.exports = { playGame };

if (!isMainThread) {
  parentPort.on('message', (job) => parentPort.postMessage({ ...job, ...playGame(job) }));
  return;
}
if (require.main !== module) return;

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ranks = arg('ranks', '0,4,8,12,16,19,22,26').split(',').map(Number);
const games = Number(arg('games', 8));
const workers = Number(arg('workers', require('os').cpus().length));
const out = arg('out', null);

// 이웃 급수끼리, 초·한을 번갈아 맡는다
const jobs = [];
for (let k = 0; k + 1 < ranks.length; k++) {
  for (let n = 0; n < games; n++) {
    const low = ranks[k];
    const high = ranks[k + 1];
    const highIsCho = n % 2 === 0;
    jobs.push({
      pair: `${R.rankName(low)} vs ${R.rankName(high)}`,
      low, high,
      choRank: highIsCho ? high : low,
      hanRank: highIsCho ? low : high,
      choParams: R.aiParams(highIsCho ? high : low),
      hanParams: R.aiParams(highIsCho ? low : high),
      choSetup: SETUPS[Math.floor(Math.random() * 4)],
      hanSetup: SETUPS[Math.floor(Math.random() * 4)],
    });
  }
}
// 오래 걸리는 높은 급수 대국부터 돌려 전체 시간을 줄인다
jobs.sort((a, b) => b.high - a.high);

const results = [];
let next = 0;
const t0 = Date.now();
function report() {
  const pairs = new Map();
  for (const r of results) {
    const p = pairs.get(r.pair) || { low: r.low, high: r.high, highWins: 0, n: 0, plies: 0, reasons: {} };
    const highSide = r.choRank === r.high ? J.CHO : J.HAN;
    if (r.winner === highSide) p.highWins++;
    p.n++;
    p.plies += r.plies;
    p.reasons[r.reason] = (p.reasons[r.reason] || 0) + 1;
    pairs.set(r.pair, p);
  }
  const rows = [...pairs.entries()].sort((a, b) => a[1].low - b[1].low);
  console.log(`\n${results.length}/${jobs.length}판 완료 (${((Date.now() - t0) / 60000).toFixed(1)}분)`);
  for (const [name, p] of rows) {
    const reasons = Object.entries(p.reasons).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`${name.padEnd(14)} 위 급수 ${p.highWins}/${p.n}승 (${Math.round((100 * p.highWins) / p.n)}%) · 평균 ${Math.round(p.plies / p.n)}수 · ${reasons}`);
  }
}

for (let w = 0; w < Math.min(workers, jobs.length); w++) {
  const worker = new Worker(__filename);
  const feed = () => {
    if (next >= jobs.length) {
      worker.terminate();
      return;
    }
    worker.postMessage(jobs[next++]);
  };
  worker.on('message', (r) => {
    results.push(r);
    report();
    if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(results, null, 1));
    feed();
  });
  feed();
}

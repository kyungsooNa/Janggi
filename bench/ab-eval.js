// 평가 방식 A/B 대국: 같은 탐색 깊이에서 evalVersion 1 과 2 를 맞붙여 2 의 승률을 잰다.
//   node bench/ab-eval.js [--games 40] [--depth 4] [--a 1] [--b 2] [--workers 4]
//   node bench/ab-eval.js --time 300   깊이 대신 한 수 0.3초로 같은 생각 시간을 준다
// 초·한과 상차림을 번갈아 바꾸고, 처음 2수는 무작위로 둬서 판이 매번 달라지게 한다.
const { Worker } = require('worker_threads');
const path = require('path');
const J = require('../js/engine.js');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const games = Number(arg('games', 40));
const depth = Number(arg('depth', 4));
// --a / --b: 숫자면 평가 버전, JSON 이면 그대로 설정에 덮어쓴다. 예) --a '{"evalVersion":2}' --b '{"evalVersion":2,"checkExt":true}'
const asParams = (v) => (/^\d+$/.test(v) ? { evalVersion: Number(v) } : JSON.parse(v));
const A = asParams(arg('a', '1'));
const B = asParams(arg('b', '2'));
const label = (o) => JSON.stringify(o);
const workers = Number(arg('workers', require('os').cpus().length));
const SETUPS = Object.keys(J.SETUPS);

const time = Number(arg('time', 0));
const base = time
  ? { depth: 30, timeMs: time, noise: 0, mistakeRate: 0, quiesce: 6 }
  : { depth, timeMs: 60000, noise: 0, mistakeRate: 0, quiesce: 6 };
const jobs = [];
for (let n = 0; n < games; n++) {
  const bIsCho = n % 2 === 0;
  jobs.push({
    bIsCho,
    choParams: { ...base, ...(bIsCho ? B : A) },
    hanParams: { ...base, ...(bIsCho ? A : B) },
    choSetup: SETUPS[Math.floor(n / 2) % 4],
    hanSetup: SETUPS[Math.floor(n / 8) % 4],
    randomPlies: 2,
  });
}

let next = 0;
let bWins = 0;
let done = 0;
const reasons = {};
const t0 = Date.now();
for (let w = 0; w < Math.min(workers, jobs.length); w++) {
  const worker = new Worker(path.join(__dirname, '..', 'scripts', 'tournament.js'));
  const feed = () => (next < jobs.length ? worker.postMessage(jobs[next++]) : worker.terminate());
  worker.on('message', (r) => {
    done++;
    const bSide = r.bIsCho ? J.CHO : J.HAN;
    if (r.winner === bSide) bWins++;
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    process.stdout.write(`\r${done}/${jobs.length}판  B ${bWins}승 ${done - bWins}패`);
    if (done === jobs.length) {
      const rate = bWins / done;
      // 승률의 대략적인 95% 구간 (정규 근사)
      const half = 1.96 * Math.sqrt((rate * (1 - rate)) / done);
      console.log(`\n${time ? `한 수 ${time}ms` : `깊이 ${depth}`}: B ${label(B)} vs A ${label(A)} → B 승률 ${(rate * 100).toFixed(0)}% (±${(half * 100).toFixed(0)}%) · ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ')} · ${((Date.now() - t0) / 60000).toFixed(1)}분`);
    }
    feed();
  });
  feed();
}

const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../js/engine.js');
const AI = require('../js/ai.js');
const R = require('../js/ranks.js');

const sq = (x, y) => J.idx(x, y);
const empty = () => new Array(90).fill(null);
const targets = (board, x, y) => J.legalMovesFrom(board, sq(x, y)).map(J.moveTo).sort((a, b) => a - b);
const list = (...pts) => pts.map(([x, y]) => sq(x, y)).sort((a, b) => a - b);

// 궁만 있는 기본 판에 기물을 올린다
function boardWith(pieces) {
  const b = empty();
  b[sq(4, 8)] = 'cK';
  b[sq(4, 1)] = 'hK';
  for (const [p, x, y] of pieces) b[sq(x, y)] = p;
  return b;
}

test('시작 점수: 초 72점, 한 73.5점 (덤 1.5)', () => {
  for (const setup of Object.keys(J.SETUPS)) {
    const b = J.initialBoard(setup, setup);
    assert.equal(J.materialScore(b, 'c'), 72);
    assert.equal(J.materialScore(b, 'h'), 73.5);
  }
});

test('상차림이 자기 쪽에서 본 왼쪽부터 놓인다', () => {
  const b = J.initialBoard('상마상마', '마상마상');
  assert.deepEqual([1, 2, 6, 7].map((x) => b[sq(x, 9)]), ['cE', 'cH', 'cE', 'cH']);
  // 한은 화면 오른쪽(x=7)이 자기 왼쪽
  assert.deepEqual([7, 6, 2, 1].map((x) => b[sq(x, 0)]), ['hH', 'hE', 'hH', 'hE']);
});

test('첫 수에서 초가 둘 수 있는 수는 31가지 (마상마상 대 마상마상)', () => {
  const b = J.initialBoard('마상마상', '마상마상');
  assert.equal(J.legalMoves(b, 'c').length, 31);
});

test('마는 앞길이 막히면 못 간다 (멱)', () => {
  const b = boardWith([['cH', 4, 5], ['cP', 4, 4]]);
  assert.deepEqual(targets(b, 4, 5), list([2, 4], [2, 6], [6, 4], [6, 6], [3, 7], [5, 7]));
});

test('상은 두 칸 모두 비어야 간다', () => {
  const b = boardWith([['cE', 4, 5]]);
  assert.equal(targets(b, 4, 5).length, 8);
  b[sq(5, 3)] = 'hP'; // 대각 첫 칸을 막으면 (6,2) 방향이 막힌다
  assert.ok(!targets(b, 4, 5).includes(sq(6, 2)));
});

test('포는 포를 넘거나 잡을 수 없다', () => {
  const b = boardWith([['cC', 0, 9], ['hC', 0, 5], ['hR', 0, 2]]);
  assert.deepEqual(targets(b, 0, 9).filter((t) => J.xOf(t) === 0), []);
  b[sq(0, 5)] = 'cP';
  b[sq(0, 3)] = 'hC';
  // 졸을 넘어 (0,4)까지 가고, 포는 잡지 못한다
  assert.deepEqual(targets(b, 0, 9).filter((t) => J.xOf(t) === 0), list([0, 4]));
});

test('포는 궁성 대각선으로 중앙을 넘을 수 있다', () => {
  const b = boardWith([['cC', 3, 9], ['cA', 4, 8]]);
  b[sq(4, 8)] = 'cA';
  b[sq(5, 8)] = 'cK';
  assert.ok(targets(b, 3, 9).includes(sq(5, 7)));
});

test('차는 궁성 대각선을 따라 움직인다', () => {
  const b = boardWith([['cR', 3, 0]]);
  b[sq(4, 1)] = null;
  b[sq(5, 1)] = 'hK';
  const t = targets(b, 3, 0);
  assert.ok(t.includes(sq(4, 1)));
  assert.ok(t.includes(sq(5, 2)));
});

test('졸은 상대 궁성 안에서 앞쪽 대각선으로 갈 수 있지만 뒤로는 못 간다', () => {
  const b = boardWith([['cP', 3, 2]]);
  b[sq(4, 1)] = null;
  b[sq(5, 0)] = 'hK';
  const t = targets(b, 3, 2);
  assert.ok(t.includes(sq(4, 1)));
  assert.ok(!t.includes(sq(3, 3)));
});

test('궁과 사는 궁성 밖으로 나가지 못한다', () => {
  const b = boardWith([]);
  for (const t of targets(b, 4, 8)) assert.equal(J.palaceOf(J.xOf(t), J.yOf(t)), 'c');
});

test('장군을 피하지 못하는 수는 둘 수 없다', () => {
  const b = boardWith([['hR', 4, 4], ['cA', 3, 9]]);
  assert.ok(J.inCheck(b, 'c'));
  for (const m of J.legalMoves(b, 'c')) {
    const cap = J.makeMove(b, m);
    assert.ok(!J.inCheck(b, 'c'));
    J.unmakeMove(b, m, cap);
  }
});

test('외통: 합법수가 없고 장군 상태', () => {
  const b = empty();
  b[sq(4, 9)] = 'cK';
  b[sq(4, 1)] = 'hK';
  b[sq(3, 7)] = 'hR';
  b[sq(5, 7)] = 'hR';
  b[sq(4, 6)] = 'hR';
  assert.ok(J.inCheck(b, 'c'));
  assert.equal(J.legalMoves(b, 'c').length, 0);
});

test('AI는 공짜 차를 잡는다', () => {
  const b = boardWith([['cR', 0, 9], ['hR', 0, 3]]);
  const res = AI.findBestMove(b, 'c', R.aiParams(20));
  assert.equal(J.moveTo(res.move), sq(0, 3));
});

test('AI는 한 수 외통을 놓치지 않는다 (9단)', () => {
  const b = empty();
  b[sq(4, 9)] = 'cK';
  b[sq(3, 9)] = 'cA';
  b[sq(5, 9)] = 'cA';
  b[sq(4, 1)] = 'hK';
  b[sq(3, 7)] = 'hR';
  b[sq(5, 7)] = 'hR';
  b[sq(4, 3)] = 'hR';
  const res = AI.findBestMove(b, 'h', R.aiParams(26));
  const after = b.slice();
  J.makeMove(after, res.move);
  assert.ok(J.inCheck(after, 'c'));
  assert.equal(J.legalMoves(after, 'c').length, 0);
});

test('급수: 18급~9단 27단계, 3승 승급 / 3패 강급', () => {
  assert.equal(R.RANKS.length, 27);
  assert.equal(R.rankName(0), '18급');
  assert.equal(R.rankName(26), '9단');
  let p = { rank: 8, points: 2 };
  let r = R.applyResult(p, true);
  assert.equal(r.change, 1);
  assert.deepEqual([r.profile.rank, r.profile.points], [9, 0]);
  p = { rank: 0, points: -2 };
  r = R.applyResult(p, false);
  assert.equal(r.profile.rank, 0); // 18급 아래로는 내려가지 않는다
  assert.ok(R.aiParams(26).depth > R.aiParams(0).depth);
});

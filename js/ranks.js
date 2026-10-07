/*
 * 급수 체계: 18급(가장 약함) ~ 1급, 1단 ~ 9단(가장 강함) 총 27단계
 * 승강급 대국에서 이기면 승급 포인트 +1, 지면 -1.
 * +PROMOTE_AT 이 되면 한 단계 승급, -PROMOTE_AT 이 되면 한 단계 강급한다.
 */
(function (global) {
  'use strict';

  const RANKS = [];
  for (let k = 18; k >= 1; k--) RANKS.push(k + '급');
  for (let d = 1; d <= 9; d++) RANKS.push(d + '단');

  const PROMOTE_AT = 3;

  function rankName(index) {
    return RANKS[Math.max(0, Math.min(RANKS.length - 1, index))];
  }

  /*
   * 급수별 AI 실력.
   *   depth        : 최대 탐색 깊이 (반복 심화)
   *   timeMs       : 한 수에 쓰는 최대 시간
   *   noise        : 후보 수 점수에 더하는 무작위 값의 폭 (클수록 엉뚱한 수)
   *   mistakeRate  : 최선이 아닌 수를 일부러 고를 확률
   *   mistakeMargin: 실수할 때 최선 수 대비 허용하는 점수 손해
   *   quiesce      : 정지 탐색 깊이 (0이면 수읽기 끝에서 맞교환을 보지 못한다)
   */
  function aiParams(index) {
    const s = Math.max(0, Math.min(RANKS.length - 1, index)); // 0 = 18급, 26 = 9단
    let depth;
    if (s < 4) depth = 1;
    else if (s < 9) depth = 2;
    else if (s < 15) depth = 3;
    else if (s < 21) depth = 4;
    else depth = 6;
    return {
      depth,
      timeMs: Math.round(250 + s * 140),
      noise: Math.max(0, 3.2 - s * 0.16),
      mistakeRate: Math.max(0, 0.4 - s * 0.022),
      mistakeMargin: Math.max(0.5, 7 - s * 0.3),
      quiesce: s < 2 ? 0 : s < 6 ? 2 : s < 12 ? 4 : 6,
    };
  }

  // 결과를 반영한 새 프로필을 돌려준다
  function applyResult(profile, won) {
    let rank = profile.rank;
    let points = profile.points + (won ? 1 : -1);
    let change = 0;
    if (points >= PROMOTE_AT) {
      if (rank < RANKS.length - 1) {
        rank += 1;
        change = 1;
      }
      points = 0;
    } else if (points <= -PROMOTE_AT) {
      if (rank > 0) {
        rank -= 1;
        change = -1;
      }
      points = 0;
    }
    return { profile: { ...profile, rank, points }, change };
  }

  const JanggiRanks = { RANKS, PROMOTE_AT, rankName, aiParams, applyResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = JanggiRanks;
  global.JanggiRanks = JanggiRanks;
})(typeof self !== 'undefined' ? self : this);

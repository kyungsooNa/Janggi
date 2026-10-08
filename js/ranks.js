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
   *   evalVersion  : 국면 평가 방식 (js/engine.js 의 evaluate / evaluateV2)
   */
  // 급수별 최대 탐색 깊이 (18급 → 9단). 구간마다 한 수씩 더 깊이 읽는다.
  const DEPTH = [
    2, 2, 2, 2, //  18급 ~ 15급
    3, 3, 3, 3, 3, // 14급 ~ 10급
    4, 4, 4, 4, 4, //  9급 ~ 5급
    5, 5, 5, 5, //  4급 ~ 1급
    6, 6, 6, //  1단 ~ 3단
    7, 7, 7, //  4단 ~ 6단
    8, 8, //  7단 ~ 8단
    9, //  9단
  ];

  function aiParams(index) {
    const s = Math.max(0, Math.min(RANKS.length - 1, index)); // 0 = 18급, 26 = 9단
    // 실수는 급이 낮을수록 잦지만, 실수해도 최선 수보다 조금만 나쁜 수를 고른다.
    // 9급부터는 손해 폭이 1점 안팎이라 기물(상·사 3점 이상)을 거저 내주지 않는다.
    let noise;
    let margin;
    if (s < 4) { noise = 1.5; margin = 3; } //      18~15급: 초보
    else if (s < 9) { noise = 0.8; margin = 1.8; } // 14~10급
    else if (s < 14) { noise = 0.4; margin = 1.0; } // 9~5급
    else if (s < 18) { noise = 0.2; margin = 0.6; } // 4~1급
    else { noise = 0; margin = 0; } //               단: 실수하지 않는다
    return {
      depth: DEPTH[s],
      timeMs: Math.round(400 + s * 200),
      noise,
      mistakeRate: s < 18 ? Math.max(0.02, 0.3 - s * 0.0165) : 0,
      mistakeMargin: margin,
      quiesce: s < 2 ? 2 : 6,
      // 평가 v2(활동성·궁 안전 포함)는 같은 생각 시간에서 v1 을 67~73% 이겼다 (bench/ab-eval.js)
      evalVersion: 2,
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

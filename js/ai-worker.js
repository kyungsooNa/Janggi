/* AI 계산을 화면과 분리해서 돌리는 Web Worker */
/* global importScripts, JanggiAI */
if (typeof JanggiAI === 'undefined') importScripts('engine.js', 'ai.js');

self.onmessage = (e) => {
  const { id, board, side, params } = e.data;
  self.postMessage({ id, result: JanggiAI.findBestMove(board, side, params) });
};

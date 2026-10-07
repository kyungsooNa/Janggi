// index.html + css + js 를 파일 하나(dist/janggi.html)로 묶는다.
// --fragment 를 주면 <html>/<head>/<body> 없이 본문만 출력한다 (호스팅 환경이 문서 뼈대를 붙여 주는 경우).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const fragment = process.argv.includes('--fragment');

const html = read('index.html');
const app = html.slice(html.indexOf('<!--APP-->'), html.indexOf('<!--/APP-->') + '<!--/APP-->'.length);
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];
const engine = read('js/engine.js');
const ai = read('js/ai.js');
const worker = engine + '\n' + ai + '\n' + read('js/ai-worker.js');
const js = (s) => s.replace(/<\/script/gi, '<\\/script');

const body = `<title>승강급 장기</title>
${fonts}
<style>
${read('css/style.css')}
</style>
${app}
<script>window.__JANGGI_WORKER_SRC__ = ${JSON.stringify(worker).replace(/<\//g, '<\\/')};</script>
<script>
${js(engine)}
${js(ai)}
${js(read('js/ranks.js'))}
${js(read('js/main.js'))}
</script>
`;

const out = fragment
  ? body
  : `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
${body}</body>
</html>
`;

const file = path.join(root, 'dist', fragment ? 'janggi.fragment.html' : 'janggi.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log('wrote', path.relative(root, file), (out.length / 1024).toFixed(1) + 'KB');

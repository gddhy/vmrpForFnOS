/* 飞牛集成自检脚本 — 校验 fnos.js 关键调用与 ?path= 参数解析逻辑 */
const fs = require('fs');
const base = __dirname + '/../app/www/';
const fnSrc = fs.readFileSync(base + 'fnos.js', 'utf8');
const html = fs.readFileSync(base + 'index.html', 'utf8');

console.log('=== fnos.js 关键调用检查 ===');
[
  ['sdk.ready() 等待', /sdk\.ready\(\)/],
  ['pickUserFile 调用', /sdk\.pickUserFile\(/],
  ['pickUserFile 目录模式', /directory:\s*true/],
  ['返回值归一化 (兼容移动端裸数组)', /function normalizePickResultList/],
  ['保存流程使用归一化', /normalizePickResult\(result, '选择目录失败'\)/],
  ['导入流程使用归一化', /normalizePickResultList\(result, '选择文件失败'\)/],
  ['new Ctor 实例化', /new Ctor\(\)/],
  ['isStandaloneWeb 判定', /sdk\.isStandaloneWeb/],
  ['close 调用', /sdk\.close\(\)/],
  ['SDK 加载状态诊断', /sdkLoaded/],
].forEach(function (p) {
  console.log('  ' + (p[1].test(fnSrc) ? 'OK   ' : '缺失  ') + p[0]);
});

console.log('  旧版 window.trimApp 实例探测残留: ' +
  (/window\.trimApp\s*&&/.test(fnSrc) ? '仍存在' : '已清除'));

console.log('\n=== index.html 引入检查 ===');
[['飞牛 SDK (vendor)', 'vendor/trimjs-web-app.js'],
 ['fnos.js 集成层', './fnos.js'],
 ['fs.js', './fs.js']].forEach(function (p) {
  console.log('  ' + (html.indexOf(p[1]) !== -1 ? 'OK   ' : '缺失  ') + p[0] + '  (' + p[1] + ')');
});

console.log('\n=== 文件管理按钮检查 ===');
console.log('  ' + (/id="fmSaveToFnos"/.test(html) ? 'OK   ' : '缺失  ') + '「保存到飞牛」按钮存在');
console.log('  ' + (/fmDownloadZipToFnos/.test(html) ? 'OK   ' : '缺失  ') + '打包->保存到 NAS 分支存在');
console.log('  ' + (/fmDownloadZipLocal/.test(html) ? 'OK   ' : '缺失  ') + '打包->本地下载 分支存在');
console.log('  ' + (/syncFnosButtons/.test(html) ? 'OK   ' : '缺失  ') + '按钮显隐同步逻辑存在');

console.log('\n=== 来源选择弹窗 (导入/上传 二选一) ===');
console.log('  ' + (/id="srcPickDialog"/.test(html) ? 'OK   ' : '缺失  ') + '弹窗 DOM 存在');
console.log('  ' + (/function showSrcPickDialog/.test(html) ? 'OK   ' : '缺失  ') + 'showSrcPickDialog 实现存在');
console.log('  ' + (/if \(!inFnOS\) \{\s*\n\s*if \(opts\.onLocal\) opts\.onLocal\(\);/.test(html)
  ? 'OK   ' : '缺失  ') + '非飞牛环境直接走本地(不弹窗)');
console.log('  ' + (/importBtn\.addEventListener[\s\S]{0,400}showSrcPickDialog/.test(html)
  ? 'OK   ' : '缺失  ') + '导入按钮接入来源弹窗');
console.log('  ' + (/getElementById\('fmUpload'\)\.addEventListener[\s\S]{0,600}showSrcPickDialog/.test(html)
  ? 'OK   ' : '缺失  ') + '文件管理上传接入来源弹窗');
console.log('  ' + (/destDir: targetDir/.test(html) ? 'OK   ' : '缺失  ') + '上传支持指定目标目录');

console.log('\n=== 截屏保存双选项 ===');
console.log('  ' + (/id="screenshotSaveFnos"/.test(html) ? 'OK   ' : '缺失  ') + '「保存到飞牛」按钮存在');
console.log('  ' + (/screenshotDownload[\s\S]{0,200}保存到本地|value="保存到本地"|>保存到本地</.test(html)
  ? 'OK   ' : '缺失  ') + '「保存到本地」文案已更新');
console.log('  ' + (/screenshotSaveFnos\.addEventListener/.test(html) ? 'OK   ' : '缺失  ') + '保存到飞牛 事件已绑定');

console.log('\n=== 退出二次确认开关 ===');
console.log('  ' + (/id="toggleExitConfirm"/.test(html) ? 'OK   ' : '缺失  ') + '按钮 DOM 存在');
console.log('  ' + (/EXIT_CONFIRM_KEY = 'vmrp_exit_confirm'/.test(html) ? 'OK   ' : '缺失  ') + 'localStorage key 已定义');
console.log('  ' + (/function isExitConfirmOn/.test(html) ? 'OK   ' : '缺失  ') + 'isExitConfirmOn 读取函数存在');
console.log('  ' + (/if \(saved === null\) return true;/.test(html) ? 'OK   ' : '缺失  ') + '默认值 = 开启(是)');
console.log('  ' + (/localStorage\.setItem\(EXIT_CONFIRM_KEY/.test(html) ? 'OK   ' : '缺失  ') + '状态持久化写入');
console.log('  ' + (/!isExitConfirmOn\(\)[\s\S]{0,320}closeApp\(\)/.test(html)
  ? 'OK   ' : '缺失  ') + '关闭二次确认时直接关窗口');
console.log('  ' + (/#toggleExitConfirm \{[\s\S]{0,140}purple/.test(html)
  ? 'OK   ' : '缺失  ') + '按钮样式(紫色, 区别于抗锯齿)');
console.log('  ' + (!/#toggleExitConfirm\.off/.test(html) && !/className = on \? '' : 'off'/.test(html)
  ? 'OK   ' : '缺失  ') + '开/关状态配色一致 (无 .off 差异化样式)');
console.log('  ' + (/id="toggleExitConfirm"[^>]*style="display:none"/.test(html)
  ? 'OK   ' : '缺失  ') + '按钮默认隐藏 (display:none)');
console.log('  ' + (/function refreshExitConfirmVisible/.test(html)
  ? 'OK   ' : '缺失  ') + '可见性刷新函数存在');
console.log('  ' + (/isInFnOSWindow/.test(html) && /refreshHostDetection/.test(html)
  ? 'OK   ' : '缺失  ') + '仅飞牛窗口内显示 (isInFnOSWindow)');
console.log('  ' + (/addEventListener\('load'[\s\S]{0,80}refreshExitConfirmVisible/.test(html)
  ? 'OK   ' : '缺失  ') + 'load 后延迟复核');

console.log('\n=== 打包卫生 (无日志残留) ===');
const serverJs = (function () {
  try { return require('fs').readFileSync(__dirname + '/../app/server/server.js', 'utf8'); }
  catch (e) { return ''; }
})();
const logExists = (function () {
  try { return require('fs').existsSync(__dirname + '/../app/server.log'); }
  catch (e) { return false; }
})();
const buildSh = (function () {
  try { return require('fs').readFileSync(__dirname + '/../build.sh', 'utf8'); }
  catch (e) { return ''; }
})();
console.log('  ' + (!logExists ? 'OK   ' : '残留  ') + 'app/server.log 未残留');
console.log('  ' + (/rm -f app\/server\.log/.test(buildSh) ? 'OK   ' : '缺失  ') + 'build.sh 打包前清理日志');
console.log('  ' + (!/appendFileSync\(LOG_FILE/.test(serverJs) ? 'OK   ' : '残留  ') + 'server.js 不再自写日志文件');

// --- GetQueryString + safeDecode 独立验证 (按行号切分, 最可靠) ---
const lines = html.split('\n');
const startIdx = lines.findIndex(function (l) { return /function safeDecode\(v\)/.test(l); });
const retIdx = lines.findIndex(function (l, i) { return i > startIdx && /^\s+return null;\s*$/.test(l); });
// 闭合大括号在 return null; 的下一行
const endIdx = retIdx !== -1 ? retIdx + 1 : -1;
const gqsBody = (startIdx !== -1 && endIdx !== -1) ? lines.slice(startIdx, endIdx + 1).join('\n') : null;

console.log('\n=== GetQueryString 参数解析 ===');
if (!gqsBody) {
  console.log('  提取失败 (start=' + startIdx + ', end=' + endIdx + ')');
  process.exit(1);
}

function mk(selfSearch, parentSearch, crossOrigin) {
  const win = { location: { href: 'http://nas:8099/' + selfSearch, search: selfSearch } };
  win.self = win;
  win.top = win;
  if (crossOrigin) {
    win.parent = { get location() { throw new Error('cross-origin'); } };
  } else {
    win.parent = { location: { search: parentSearch } };
  }
  return win;
}

const cases = [
  ['自身 URL 带 ?path=', mk('?path=%2Fvol1%2Fa.mrp', '', false), '/vol1/a.mrp'],
  ['父窗口 URL 带 ?path=', mk('', '?path=%2Fvol1%2Fb.mrp', false), '/vol1/b.mrp'],
  ['跨域父窗口 (应安全降级)', mk('', '', true), null],
  ['两处均无参数', mk('', '', false), null],
];

let allPass = true;
cases.forEach(function (c) {
  const fn = new Function('window', gqsBody + '\nreturn GetQueryString;');
  let got;
  try { got = fn(c[1])('path'); } catch (e) { got = 'ERR:' + e.message; }
  const pass = String(got) === String(c[2]);
  if (!pass) allPass = false;
  console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + c[0] +
    ' -> ' + JSON.stringify(got) + '  (期望 ' + JSON.stringify(c[2]) + ')');
});

console.log('\n结果: ' + (allPass ? '全部通过' : '存在失败项'));
process.exit(allPass ? 0 : 1);

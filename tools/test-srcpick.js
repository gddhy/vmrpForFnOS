/* 来源选择弹窗 & 截屏按钮显隐 — 交互逻辑模拟测试
 * 用最小 DOM 模拟验证 showSrcPickDialog 的分支行为:
 *   飞牛环境 -> 弹窗, 本地/飞牛各自触发对应回调
 *   浏览器环境 -> 不弹窗, 直接走本地回调
 */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/www/index.html', 'utf8');
const lines = html.split('\n');

const s = lines.findIndex(function (l) { return /var srcPickState = null;/.test(l); });
const e = lines.findIndex(function (l, i) { return i > s && /^\s*\/\/ ---- Toast 提示 ----/.test(l); });
const srcBody = (s !== -1 && e !== -1) ? lines.slice(s, e).join('\n') : null;

if (!srcBody) { console.log('提取失败 s=' + s + ' e=' + e); process.exit(1); }

let pass = 0, fail = 0;
function t(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}

function makeEnv(inFnOS) {
  const els = {};
  ['srcPickDialog', 'srcPickTitle', 'srcPickLocal', 'srcPickFnos', 'srcPickCancel'].forEach(function (id) {
    els[id] = {
      id: id, style: {}, onclick: null, textContent: '',
      querySelector: function () { return { textContent: '' }; },
      focus: function () {},
      addEventListener: function () {},
    };
  });
  const doc = { getElementById: function (id) { return els[id] || null; } };
  const win = { vmrpFnos: { inFnOS: inFnOS } };
  return { win, doc, els };
}

function load(env) {
  return new Function('window', 'document', srcBody +
    '\nreturn {showSrcPickDialog: showSrcPickDialog, closeSrcPick: closeSrcPick};'
  )(env.win, env.doc);
}

console.log('\n【飞牛环境】应弹窗, 两个选项各自可点');
{
  const env = makeEnv(true);
  const api = load(env);
  let local = 0, fnos = 0;
  api.showSrcPickDialog({
    title: '导入文件',
    onLocal: function () { local++; },
    onFnos: function () { fnos++; }
  });
  t('弹窗已显示 (display=flex)', env.els.srcPickDialog.style.display === 'flex');
  t('标题已写入', env.els.srcPickTitle.textContent === '导入文件');
  t('此时回调尚未触发', local === 0 && fnos === 0);

  env.els.srcPickLocal.onclick();
  t('点"本地文件" -> onLocal 触发 1 次', local === 1 && fnos === 0);
  t('弹窗已关闭', env.els.srcPickDialog.style.display === 'none');
}
{
  const env = makeEnv(true);
  const api = load(env);
  let local = 0, fnos = 0;
  api.showSrcPickDialog({
    onLocal: function () { local++; },
    onFnos: function () { fnos++; }
  });
  env.els.srcPickFnos.onclick();
  t('点"飞牛文件" -> onFnos 触发 1 次', fnos === 1 && local === 0);
}
{
  const env = makeEnv(true);
  const api = load(env);
  let local = 0, fnos = 0;
  api.showSrcPickDialog({
    onLocal: function () { local++; },
    onFnos: function () { fnos++; }
  });
  env.els.srcPickCancel.onclick();
  t('点"取消" -> 两个回调都不触发', local === 0 && fnos === 0);
  t('弹窗已关闭', env.els.srcPickDialog.style.display === 'none');
}
{
  const env = makeEnv(true);
  const api = load(env);
  let local = 0;
  api.showSrcPickDialog({ onLocal: function () { local++; } });
  env.els.srcPickDialog.onclick({ target: env.els.srcPickDialog });
  t('点遮罩 -> 关闭且不触发回调', env.els.srcPickDialog.style.display === 'none' && local === 0);
}

console.log('\n【浏览器环境】不应弹窗, 直接走本地');
{
  const env = makeEnv(false);
  const api = load(env);
  let local = 0, fnos = 0;
  api.showSrcPickDialog({
    onLocal: function () { local++; },
    onFnos: function () { fnos++; }
  });
  t('未显示弹窗', env.els.srcPickDialog.style.display !== 'flex');
  t('onLocal 直接触发 1 次', local === 1 && fnos === 0);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

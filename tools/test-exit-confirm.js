/* 退出二次确认开关 — 行为逻辑模拟测试
 * 从 index.html 提取真实源码, 在受控环境中验证:
 *   1) 默认值 = 开启
 *   2) 持久化读写正确
 *   3) 关闭后 MRP 退出 -> 调 closeApp 且不弹窗
 *   4) 开启后 MRP 退出 -> 弹窗且不调 closeApp
 */
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../app/www/index.html', 'utf8');
const lines = html.split('\n');

function slice(fromRe, toRe) {
  const s = lines.findIndex(function (l) { return fromRe.test(l); });
  const e = lines.findIndex(function (l, i) { return i > s && toRe.test(l); });
  return (s !== -1 && e !== -1) ? lines.slice(s, e + 1).join('\n') : null;
}

// 提取开关实现
// 注意: 现在从 EXIT_CONFIRM_KEY 一直取到"可见性监听器"结束 (含 refresh/watch)
const toggleBody = slice(/var EXIT_CONFIRM_KEY/, /^\s*\/\/ ---- 网页内确认弹窗/);
// 提取 showMrpExitDialog 的"关闭二次确认"分支 (到该分支的 return; + 结束括号)
const startLine = lines.findIndex(function (l) { return /function showMrpExitDialog\(message, title\) \{/.test(l); });
const branchEnd = lines.findIndex(function (l, i) {
  return i > startLine && /^\s*if \(!overlay \|\| mrpExitDialogShown\) return;/.test(l);
});
// 取到 if 块闭合 (branchEnd 前一行是 '}' 结束关闭分支... 实际 branchEnd 前两行为 } 和空行)
let endLine = -1;
for (let i = branchEnd - 1; i > startLine; i--) {
  if (/^\s*\}\s*$/.test(lines[i])) { endLine = i; break; }
}
// 需要包含关闭分支的完整 if 块: 从 startLine 到 branchEnd-1 更稳妥
const exitBody = startLine !== -1 ? lines.slice(startLine, branchEnd).join('\n') + '\n        }' : null;

if (!toggleBody || !exitBody) {
  console.log('提取失败 toggle=' + !!toggleBody + ' exit=' + !!exitBody +
    ' (start=' + startLine + ', branchEnd=' + branchEnd + ')');
  process.exit(1);
}

let pass = 0, fail = 0;
function t(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}

function makeEnv(stored, inFnOS) {
  const store = {};
  if (stored !== undefined) store['vmrp_exit_confirm'] = stored;

  let closeCalled = 0;
  const listeners = {};
  const timers = [];
  const clearTimers = [];
  // 记录 setInterval / setTimeout 回调, 便于手动触发
  const win = {
    localStorage: {
      getItem: function (k) { return k in store ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); }
    },
    vmrpFnos: {
      inFnOS: inFnOS,
      sdk: null,
      refreshHostDetection: function () { return inFnOS; },
      isInFnOSWindow: function () { return inFnOS; },
      closeApp: function () { closeCalled++; return Promise.resolve(true); }
    },
    console: { log: function () {}, warn: function () {} },
    addEventListener: function (ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    dispatch: function (ev, payload) {
      (listeners[ev] || []).forEach(function (fn) { fn(payload); });
    },
    setInterval: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearInterval: function (id) { clearTimers.push(id); },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; }
  };
  const btn = { value: '', className: '', title: '', style: {}, addEventListener: function () {} };
  const doc = { getElementById: function (id) { return id === 'toggleExitConfirm' ? btn : null; } };
  return {
    win: win, doc: doc, btn: btn, store: store,
    closeCount: function () { return closeCalled; },
    timers: timers, clearTimers: clearTimers, listeners: listeners
  };
}

function loadToggle(env) {
  return new Function('window', 'document', 'showToast', 'localStorage', 'setInterval', 'clearInterval', 'setTimeout',
    'var showToast=arguments[2];' + toggleBody + '\nreturn {isExitConfirmOn:isExitConfirmOn,setExitConfirm:setExitConfirm,refreshExitConfirmVisible:refreshExitConfirmVisible};'
  )(env.win, env.doc, function () {}, env.win.localStorage,
    env.win.setInterval, env.win.clearInterval, env.win.setTimeout);
}

function loadExit(env) {
  // 需要 isExitConfirmOn / showMrpExitDialog 及最小依赖
  return new Function('window', 'document', 'console', 'localStorage',
    toggleBody + '\n' + exitBody + '\nreturn showMrpExitDialog;'
  )(env.win, env.doc, env.win.console, env.win.localStorage);
}

console.log('\n【1】默认值 = 开启');
{
  const env = makeEnv(undefined, true);
  const api = loadToggle(env);
  t('无本地存储时 isExitConfirmOn() === true', api.isExitConfirmOn() === true);
}
console.log('\n【2】持久化读写');
{
  const env = makeEnv(undefined, true);
  const api = loadToggle(env);
  api.setExitConfirm(false);
  t("setExitConfirm(false) 写入 '0'", env.store['vmrp_exit_confirm'] === '0');
  t('重新读取为 false', api.isExitConfirmOn() === false);
  api.setExitConfirm(true);
  t("setExitConfirm(true) 写入 '1'", env.store['vmrp_exit_confirm'] === '1');
  t('重新读取为 true', api.isExitConfirmOn() === true);
  t('按钮文案同步为 (开)', env.btn.value === '退出确认(开)');
  // 开/关 配色一致: 不再通过 className 切换样式
  api.setExitConfirm(false);
  t('关闭后文案为 (关)', env.btn.value === '退出确认(关)');
  t('开关状态不改 className (配色一致)', !/\boff\b/.test(String(env.btn.className || '')));
}
console.log('\n【2b】按钮可见性: 默认隐藏, 仅飞牛宿主内显示');
{
  // 浏览器环境: 保持 hidden
  const envBrowser = makeEnv(undefined, false);
  const apiBrowser = loadToggle(envBrowser);
  apiBrowser.refreshExitConfirmVisible();
  t('浏览器环境 -> display=none', envBrowser.btn.style.display === 'none');

  // 飞牛环境: 立即可见
  const envFn = makeEnv(undefined, true);
  const apiFn = loadToggle(envFn);
  const shown = apiFn.refreshExitConfirmVisible();
  t('飞牛环境 -> 立即显示 (display 清空)', shown === true && envFn.btn.style.display === '');

  // 初始不可见但随后变可见 (模拟 fnos.js 延迟加载 + SDK 异步握手)
  const envLate = makeEnv(undefined, false);
  envLate.win.vmrpFnos.inFnOS = false;
  envLate.win.vmrpFnos.isInFnOSWindow = function () { return false; };
  const apiLate = loadToggle(envLate);
  apiLate.refreshExitConfirmVisible();
  t('握手前 -> 隐藏', envLate.btn.style.display === 'none');
  // 握手完成, 宿主确认
  envLate.win.vmrpFnos.inFnOS = true;
  envLate.win.vmrpFnos.isInFnOSWindow = function () { return true; };
  apiLate.refreshExitConfirmVisible();
  t('握手后 -> 显示', envLate.btn.style.display === '');

  // 已注册 load 事件监听 (延迟复核)
  const hasLoad = (envLate.listeners['load'] || []).length > 0;
  t('已注册 load 复核监听', hasLoad);
  const hasReadyEvt = (envLate.listeners['vmrpfnosready'] || []).length > 0;
  t('已注册 vmrpfnosready 监听', hasReadyEvt);
  // 轮询定时器已启动
  t('已启动轮询定时器', envLate.timers.length > 0);
}
console.log('\n【3】关闭二次确认 -> MRP 退出直接关窗口 (不弹窗)');
{
  const env = makeEnv('0', true);   // 已关闭
  const showExit = loadExit(env);
  showExit(undefined, undefined);
  // closeApp 是异步 promise, 等待微任务
  return Promise.resolve().then(function () {
    t('closeApp() 被调用 1 次', env.closeCount() === 1);

    console.log('\n【4】开启二次确认 -> MRP 退出弹窗 (不关窗口)');
    const env2 = makeEnv('1', true);
    const showExit2 = loadExit(env2);
    // 弹窗需要 overlay DOM, 这里只验证不触发 closeApp
    showExit2(undefined, undefined);
    return Promise.resolve().then(function () {
      t('closeApp() 未被调用', env2.closeCount() === 0);

      console.log('\n【5】非飞牛环境 -> 不触发 closeApp');
      const env3 = makeEnv('0', false);   // 已关闭但在浏览器
      const showExit3 = loadExit(env3);
      showExit3(undefined, undefined);
      return Promise.resolve().then(function () {
        t('浏览器环境 closeApp() 未被调用', env3.closeCount() === 0);
        console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
        process.exit(fail ? 1 : 0);
      });
    });
  });
}

/**
 * 缓存 / 版本自检 / CPU 占用防护 测试
 *
 * 覆盖三个真实问题:
 *   1) 移动端 WebView 缓存旧页面 -> 升级后仍是旧代码
 *      修复: 静态资源 no-store + HTML 注入 __VMRP_WWW_STAMP + 页面自检强刷
 *   2) 抖动动画 setInterval(...,1) 每毫秒写样式 -> 合成线程满负荷
 *      修复: requestAnimationFrame + 帧节流
 *   3) 页面切后台模拟器主循环仍满速空转 -> 短暂高 CPU 告警
 *      修复: visibilitychange -> Module.pauseMainLoop()/resumeMainLoop()
 *
 * 用法: node tools/test-cache-cpu.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'app', 'server', 'server.js'), 'utf8');
const fnosSrc = fs.readFileSync(path.join(ROOT, 'app', 'www', 'fnos.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'app', 'www', 'index.html'), 'utf8');
let readme = '';
try { readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'); } catch (e) { /* 下面断言会失败 */ }

let pass = 0, fail = 0;
function t(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); }
}

/* ---------------- 1. 服务端缓存头 ---------------- */
console.log('\n【1】静态资源禁用缓存');
t('使用 no-store', /'Cache-Control': 'no-store[^']*'/.test(serverSrc));
t('附带 Pragma: no-cache', /'Pragma': 'no-cache'/.test(serverSrc));
t('附带 Expires: 0', /'Expires': '0'/.test(serverSrc));
t('带 ETag (内容指纹)', /headers\['ETag'\]/.test(serverSrc));
t('不再只有裸 no-cache', !/'Cache-Control': 'no-cache'\s*\n\s*\};/.test(serverSrc));

/* ---------------- 2. www 指纹与 HTML 注入 ---------------- */
console.log('\n【2】www 指纹与注入');
t('定义 WWW_STAMP', /const WWW_STAMP =/.test(serverSrc));
t('指纹覆盖核心文件', /'index\.html', 'fnos\.js', 'fs\.js', 'vmrp\.js', 'vmrp\.wasm'/.test(serverSrc));
t('FNV-1a 哈希实现', /0x811c9dc5/.test(serverSrc));
t('health 返回 wwwStamp', /wwwStamp: WWW_STAMP/.test(serverSrc));
t('health 返回 build', /build: BUILD_ID/.test(serverSrc));
t('HTML 注入 __VMRP_WWW_STAMP', /__VMRP_WWW_STAMP/.test(serverSrc));
t('注入位置在 </head> 前', /replace\('<\/head>', inject \+ '\\n<\/head>'\)/.test(serverSrc));
t('仅对 HTML 注入 (isHtml 判定)', /const isHtml = \/\^text\\\/html\//.test(serverSrc));
t('注入后重算 Content-Length', /headers\['Content-Length'\] = buf\.length/.test(serverSrc));

/* ---------------- 3. 页面版本自检 ---------------- */
console.log('\n【3】页面版本自检 (旧页面强制刷新)');
t('fnos.js 定义 checkStalePage', /function checkStalePage\(\)/.test(fnosSrc));
t('读取 window.__VMRP_WWW_STAMP', /window\.__VMRP_WWW_STAMP/.test(fnosSrc));
t('对比服务端 wwwStamp', /serverStamp === localStamp/.test(fnosSrc));
t('启动时调用 checkStalePage()', /\n\s*checkStalePage\(\);/.test(fnosSrc));
t('用 no-store 拉 health', /apiUrl\('\/api\/health'\), \{ cache: 'no-store' \}/.test(fnosSrc));
t('有防死循环节流 (60s)', /now - last < 60000/.test(fnosSrc));
t('强刷使用 location.replace', /window\.location\.replace\(u\.toString\(\)\)/.test(fnosSrc));
t('刷新带 _v 版本参数', /searchParams\.set\('_v', serverStamp\)/.test(fnosSrc));
t('取不到本地指纹时跳过 (兼容旧页面)', /if \(!localStamp\) return;/.test(fnosSrc));

/* ---------------- 4. 抖动动画 (CPU) ---------------- */
// 去掉注释再断言, 避免匹配到说明文字本身
const htmlCode = htmlSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

console.log('\n【4】抖动动画改用 rAF (CPU)');
t('不再有 setInterval(..., 1)', !/setInterval\([^)]*,\s*1\s*\)/.test(htmlCode));
t('js_startShake 使用 requestAnimationFrame', /shakeRAF = requestAnimationFrame\(step\)/.test(htmlSrc));
t('js_stopShake 使用 cancelAnimationFrame', /cancelAnimationFrame\(shakeRAF\)/.test(htmlSrc));
t('有帧节流常量 FLIP_MS', /var FLIP_MS = 32;/.test(htmlSrc));
t('按时间判断是否翻转', /now - shakeLastFlip >= FLIP_MS/.test(htmlSrc));
t('保持原语义 shakef 非 0 即运行', /shakef = 1;\s*\/\/ 标记运行中/.test(htmlSrc));
t('达到时长自动停止', /now - shakeStartTime >= ms/.test(htmlSrc));

/* ---------------- 5. 页面不可见时暂停主循环 (CPU) ---------------- */
console.log('\n【5】后台暂停主循环 (CPU)');
t('定义 setupVisibilityPause', /function setupVisibilityPause\(\)/.test(htmlSrc));
t('postRun 中调用', /setupVisibilityPause\(\);/.test(htmlSrc));
t('调用 Module.pauseMainLoop', /Module\.pauseMainLoop\(\)/.test(htmlSrc));
t('调用 Module.resumeMainLoop', /Module\.resumeMainLoop\(\)/.test(htmlSrc));
t('监听 visibilitychange', /addEventListener\('visibilitychange'/.test(htmlSrc));
t('按 document.hidden 分支', /if \(document\.hidden\) doPause\(\); else doResume\(\);/.test(htmlSrc));
t('监听 focus 恢复', /addEventListener\('focus', doResume\)/.test(htmlSrc));
t('暂停状态可查 (调试)', /window\.__vmrpLoopPaused/.test(htmlSrc));
t('有 _loopPaused 幂等保护', /if \(_loopPaused\) return;/.test(htmlSrc));
t('pauseMainLoop 可用性预检', /typeof Module\.pauseMainLoop !== 'function'/.test(htmlSrc));

/* ---------------- 6. 主循环确实是 setTimeout(0) 驱动 (背景说明校验) ---------------- */
console.log('\n【6】确认 Emscripten 主循环未节流 (暂停策略的前提)');
const vmrpJs = fs.readFileSync(path.join(ROOT, 'app', 'www', 'vmrp.js'), 'utf8');
t('vmrp.js 由 setTimeout(runner, 0) 驱动', /setTimeout\(Browser\.mainLoop\.runner,0\)/.test(vmrpJs));
t('导出 pauseMainLoop', /Module\["pauseMainLoop"\]/.test(vmrpJs));
t('导出 resumeMainLoop', /Module\["resumeMainLoop"\]/.test(vmrpJs));

/* ---------------- 7. 版本与诊断能力 (内部保留, UI 不暴露) ---------------- */
console.log('\n【7】版本与诊断 (API 保留, 页面不暴露调试 UI)');
t('fnos.js 暴露 version 字段', /version: '1\.6\.0'/.test(fnosSrc));
t('diagnose 返回 moduleVersion', /moduleVersion: '1\.6\.0'/.test(fnosSrc));
t('diagnose 返回 wwwStamp', /wwwStamp: window\.__VMRP_WWW_STAMP/.test(fnosSrc));
t('暴露 report() 一次性诊断', /report: function \(\)/.test(fnosSrc));
t('暴露 forceReload() 强制刷新', /forceReload: function \(\)/.test(fnosSrc));
t('forceReload 带时间戳参数', /searchParams\.set\('_v', String\(Date\.now\(\)\)\)/.test(fnosSrc));

console.log('\n【7b】调试 UI 已移除 (面向终端用户收敛)');
t('页面无 versionLine', !/id="versionLine"/.test(htmlSrc));
t('页面无 强制刷新 按钮', !/id="forceReloadBtn"/.test(htmlSrc));
t('页面无 诊断弹窗', !/id="diagDialog"/.test(htmlSrc));
t('页面无 diagText textarea', !/id="diagText"/.test(htmlSrc));
t('页面无 显示诊断信息 按钮', !/id="diagBtn"/.test(htmlSrc));
t('页面无 diagCopy 按钮', !/id="diagCopy"/.test(htmlSrc));
t('无残留 execCommand copy 调试逻辑', !/document\.execCommand\('copy'\)/.test(htmlSrc));
t('保留 重新申请目录授权 按钮 (用户功能)', /id="reAuthBtn"/.test(htmlSrc));
t('保留 reauthorize 调用', /window\.vmrpFnos\.reauthorize\(\)/.test(htmlSrc));
t('保留授权回调消息监听', /vmrp:auth-result/.test(htmlSrc));

/* ---------------- 8. bridge 原始报文探针 ---------------- */
console.log('\n【8】bridge 报文探针 (诊断 API 保留, 供 report() 使用)');
t('定义 bridgeLog 缓冲', /var bridgeLog = \[\];/.test(fnosSrc));
t('缓冲有上限 BRIDGE_LOG_MAX', /var BRIDGE_LOG_MAX = 12;/.test(fnosSrc));
t('定义 recordBridge', /function recordBridge\(method, raw, parsed, err\)/.test(fnosSrc));
t('定义 instrumentBridge', /function instrumentBridge\(\)/.test(fnosSrc));
t('包装 flutter_inappwebview.callHandler', /fb\.callHandler = function \(name\)/.test(fnosSrc));
t('探针幂等 (__vmrpProbed)', /fb\.__vmrpProbed = true;/.test(fnosSrc));
t('探针解析第二层 .result', /typeof one\.result === 'string'/.test(fnosSrc));
t('初始化时挂载探针', /\n\s*instrumentBridge\(\);/.test(fnosSrc));
t('平台就绪事件里再挂一次', /addEventListener\('flutterInAppWebViewPlatformReady', function \(\) \{\s*\n\s*instrumentBridge\(\);/.test(fnosSrc));
t('有重试挂载 (前 10 秒)', /function retryInstrument\(\)/.test(fnosSrc));
t('report() 输出 bridge 记录', /最近 ' \+ bridgeLog\.length \+ ' 次 bridge 调用/.test(fnosSrc));
t('暴露 getBridgeLog()', /getBridgeLog: function \(\)/.test(fnosSrc));
t('目录被拒时打出错误码日志', /目录选择被拒绝: code=/.test(fnosSrc));
t('能区分"真取消"与"鉴权失败"', /目录选择: 用户取消/.test(fnosSrc));
t('鉴权失败走四通道兜底链', /tryAuthorizeFallback/.test(fnosSrc));

console.log('\n【9】开源与许可合规');
t('存在 LICENSE 文件', fs.existsSync(path.join(ROOT, 'LICENSE')));
let licText = '';
try { licText = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'); } catch (e) { /* 下面会失败 */ }
t('LICENSE 是 GPL-3.0 全文', /GNU GENERAL PUBLIC LICENSE/.test(licText) && /Version 3, 29 June 2007/.test(licText));
t('README 标注上游仓库', /github\.com\/vmrp\/vmrp/.test(readme));
t('README 声明 GPL-3.0', /GPL-3\.0/.test(readme) || /GNU General Public License v3\.0/.test(readme));
t('README 含致谢上游作者', /zengming00/.test(readme));
t('server.js 带 SPDX 标识', /SPDX-License-Identifier: GPL-3\.0-or-later/.test(serverSrc));
t('fnos.js 带 SPDX 标识', /SPDX-License-Identifier: GPL-3\.0-or-later/.test(fnosSrc));

console.log('\n【9b】manifest 归属信息');
const manifestSrc = fs.readFileSync(path.join(ROOT, 'manifest'), 'utf8');
t('maintainer = zengming00 (开发者)', /^maintainer\s*=\s*zengming00$/m.test(manifestSrc));
t('maintainer_url = github.com/vmrp/', /^maintainer_url\s*=\s*https:\/\/github\.com\/vmrp\/$/m.test(manifestSrc));
t('distributor = gddhy (发布者)', /^distributor\s*=\s*gddhy$/m.test(manifestSrc));
t('distributor_url = gddhy.net', /^distributor_url\s*=\s*https:\/\/gddhy\.net\/$/m.test(manifestSrc));
t('README 说明开发者与发布者分属两者', /开发者.*发布者/.test(readme));

console.log('\n【9c】存储不受缓存策略影响 (no-store 只管 HTTP 缓存)');
const fsSrc = fs.readFileSync(path.join(ROOT, 'app', 'www', 'fs.js'), 'utf8');
t('服务端未设置 Clear-Site-Data 头', !/Clear-Site-Data/i.test(serverSrc));
t('服务端未调用存储清理 API', !/localStorage\.clear|sessionStorage\.clear|deleteDatabase/.test(serverSrc));
t('fs.js 存档走 IndexedDB', /indexedDB\.open\(IDB_SAVE_DB/.test(fsSrc));
t('无 deleteDatabase 调用 (不会清空存档库)', !/deleteDatabase/.test(fsSrc));
t('清档仅由 clearAllSaves 主动触发', /async function clearAllSaves\(\)/.test(fsSrc));
t('fnos.js 用 localStorage 记住保存目录', /localStorage\.setItem\('vmrp\.lastSaveDir'/.test(fnosSrc));
t('缓存头仅作用于 HTTP 层 (no-store 在静态资源处理里)', /'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'/.test(serverSrc));

console.log('\n【10】选择器错误码识别 (v1.6.0)');
t('定义 PICK_ERROR_TEXT 表', /var PICK_ERROR_TEXT = \{/.test(fnosSrc));
t('含 1003103 应用权限校验失败', /'1003103': '应用权限校验失败/.test(fnosSrc));
t('含 1003201 管理员已关闭', /'1003201': '管理员已关闭/.test(fnosSrc));
t('定义 lastPickError 记录', /var lastPickError = null;/.test(fnosSrc));
t('定义 describePickError', /function describePickError\(/.test(fnosSrc));
t('定义 isUserCancel', /function isUserCancel\(\)/.test(fnosSrc));
t('暴露 lastPickError()', /lastPickError: function \(\)/.test(fnosSrc));
t('暴露 probeOpenApi()', /probeOpenApi: function \(\)/.test(fnosSrc));
t('暴露 queryUserFolders()', /queryUserFolders: function \(\)/.test(fnosSrc));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

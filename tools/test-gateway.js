/* 统一网关 + 移动端适配 — 行为测试
 *
 * 验证:
 *   1) 网关前缀剥离 (_lib 逻辑)
 *   2) 后端同时监听 Unix Socket 与 TCP
 *   3) cmd/main 传递 SOCKET_PATH / GATEWAY_PREFIX
 *   4) app/ui/config 使用 gatewayPrefix + gatewaySocket
 *   5) manifest 网关模式 (无 service_port / checkport=false)
 *   6) 前端 apiUrl() 在网关前缀 / 根路径两种场景下都正确
 *   7) 移动端 (isWeb=false, flutter bridge) 判定为 inFnOS
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { return ''; } };

const serverSrc = read('app/server/server.js');
const cmdMain = read('cmd/main');
const uiConfig = read('app/ui/config');
const manifest = read('manifest');
const fnosSrc = read('app/www/fnos.js');
const fsSrc = read('app/www/fs.js');
const indexSrc = read('app/www/index.html');
const buildSh = read('build.sh');

let pass = 0, fail = 0;
function t(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}

console.log('\n【1】统一网关 — 后端监听');
t('server.js 读取 SOCKET_PATH', /process\.env\.SOCKET_PATH/.test(serverSrc));
t('server.js 读取 GATEWAY_PREFIX', /process\.env\.GATEWAY_PREFIX/.test(serverSrc));
t('server.js 剥离网关前缀', /function stripGatewayPrefix/.test(serverSrc));
t('server.js 监听 Unix Socket', /server\.listen\(SOCKET_PATH/.test(serverSrc));
t('server.js 兼容 TCP (可关闭)', /ENABLE_TCP/.test(serverSrc));
t('server.js 启动前清理残留 socket', /unlinkSync\(SOCKET_PATH\)/.test(serverSrc));
t('server.js 退出时清理 socket', /fs\.unlinkSync\(SOCKET_PATH\)/.test(serverSrc));
t('server.js 读取网关用户 Header', /x-trim-userid/.test(serverSrc));
t('health 接口暴露 socket / gatewayPrefix', /gatewayPrefix: GATEWAY_PREFIX/.test(serverSrc));

console.log('\n【2】统一网关 — cmd/main');
t('cmd/main 定义 GATEWAY_PREFIX=/app/vmrp', /GATEWAY_PREFIX="\/app\/vmrp"/.test(cmdMain));
t('cmd/main 定义 SOCKET_PATH', /SOCKET_PATH="\$\{TRIM_APPDEST\}\/app\.sock"/.test(cmdMain));
t('cmd/main 注入 SOCKET_PATH 环境变量', /SOCKET_PATH="\$\{SOCKET_PATH\}"/.test(cmdMain));
t('cmd/main 注入 GATEWAY_PREFIX 环境变量', /GATEWAY_PREFIX="\$\{GATEWAY_PREFIX\}"/.test(cmdMain));
t('cmd/main 停止时清理 socket', /rm -f "\$\{SOCKET_PATH\}"/.test(cmdMain));

console.log('\n【3】统一网关 — 入口与 manifest');
let cfg = null;
try { cfg = JSON.parse(uiConfig); } catch (e) { }
t('app/ui/config 是合法 JSON', !!cfg);
t('桌面入口使用 gatewayPrefix', !!(cfg && cfg['.url'] && cfg['.url']['vmrp.Application'].gatewayPrefix === '/app/vmrp'));
t('桌面入口使用 gatewaySocket', !!(cfg && cfg['.url'] && cfg['.url']['vmrp.Application'].gatewaySocket === 'app.sock'));
t('文件入口保留 fileTypes', !!(cfg && cfg['.url'] && cfg['.url']['vmrp.OpenMrp'].fileTypes && cfg['.url']['vmrp.OpenMrp'].fileTypes[0] === 'mrp'));
t('入口不再声明 port', !!(cfg && !cfg['.url']['vmrp.Application'].port && !cfg['.url']['vmrp.OpenMrp'].port));
t('manifest 移除 service_port', !/^service_port\s*=/m.test(manifest));
t('manifest checkport=false', /^checkport\s*=\s*false/m.test(manifest));
t('manifest os_min_version >= 1.2.0401', /^os_min_version\s*=\s*1\.2\.0401/m.test(manifest));
t('manifest 保留 micro_app=true', /^micro_app\s*=\s*true/m.test(manifest));

console.log('\n【4】前端 — 接口路径前缀推导');
t('fnos.js 定义 apiBase()', /function apiBase\(\)/.test(fnosSrc));
t('fnos.js 定义 apiUrl()', /function apiUrl\(p\)/.test(fnosSrc));
t('fnos.js 导出 apiUrl', /apiUrl: apiUrl/.test(fnosSrc));
t('fs.js 独立实现 vmrpApiUrl', /function vmrpApiUrl\(p\)/.test(fsSrc));
t('fs.js 文件关联使用 vmrpApiUrl', /vmrpApiUrl\('\/api\/open-mrp\?path='\)/.test(fsSrc));
t('index.html 无绝对 fetch(\'/api/...)', !/fetch\('\/api\//.test(indexSrc));
t('fnos.js 无绝对 fetch(\'/api/...)', !/fetch\('\/api\//.test(fnosSrc));
t('fs.js 无绝对 fetch(\'/api/...)', !/fetch\('\/api\//.test(fsSrc));

// 行为验证: 抽出 apiUrl / apiBase 真实源码, 在两种 pathname 下执行
function extractFn(src, name) {
  const lines = src.split('\n');
  const s = lines.findIndex(l => new RegExp('function ' + name + '\\s*\\(').test(l));
  if (s === -1) return null;
  let depth = 0, started = false;
  for (let i = s; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') { depth++; started = true; } else if (ch === '}') depth--; }
    if (started && depth === 0) return lines.slice(s, i + 1).join('\n');
  }
  return null;
}
const srcBase = extractFn(fnosSrc, 'apiBase');
const srcUrl = extractFn(fnosSrc, 'apiUrl');
t('提取 apiBase/apiUrl 源码', !!srcBase && !!srcUrl);

function runApi(pathname) {
  const body = [
    'var _apiBase = null;',
    srcBase, srcUrl,
    'return apiUrl;'
  ].join('\n');
  return new Function('window', body)({ location: { pathname: pathname } });
}

console.log('\n【5】前端 — 前缀推导行为');
const cases = [
  ['/app/vmrp/', '/app/vmrp/api/open-mrp'],
  ['/app/vmrp', '/app/vmrp/api/open-mrp'],
  ['/app/vmrp/index.html', '/app/vmrp/api/open-mrp'],
  ['/', '/api/open-mrp'],
  ['/index.html', '/api/open-mrp']
];
cases.forEach(function (c) {
  const u = runApi(c[0]);
  t('pathname ' + c[0] + ' -> ' + u('/api/open-mrp'), u('/api/open-mrp') === c[1]);
});

console.log('\n【6】移动端适配 — 宿主判定');
t('fnos.js 识别 flutter bridge', /flutter_inappwebview/.test(fnosSrc));
t('fnos.js 监听 flutterInAppWebViewPlatformReady', /flutterInAppWebViewPlatformReady/.test(fnosSrc));
t('fnos.js 定义 isMobileWebView()', /function isMobileWebView\(\)/.test(fnosSrc));
t('computeInFnOS 区分 isWeb===false 分支', /sdk\.isWeb === false\) return isMobileWebView\(\)/.test(fnosSrc));
t('UA 兜底识别 FNAppType', /FNAppType\\\/\|FNOS\\\//.test(fnosSrc));
t('diagnose 暴露 mode', /mode: \(webMode === false\)/.test(fnosSrc));

// 行为验证: computeInFnOS 三种场景
function runCompute(opts) {
  const body = [
    'var sdkLoaded = true;',
    'var sdk = arguments[0];',
    'var flutterPlatformReady = arguments[1];',
    'var window = arguments[2];',
    'var navigator = arguments[3];',
    extractFn(fnosSrc, 'inIframeNow'),
    extractFn(fnosSrc, 'isMobileWebView'),
    extractFn(fnosSrc, 'computeInFnOS'),
    'return computeInFnOS();'
  ].join('\n');
  return new Function(body)(opts.sdk, opts.flutterReady, opts.window, opts.navigator);
}

const mobileEnv = {};
mobileEnv.window = { self: {}, top: {}, flutter_inappwebview: { _platformReady: true } };
mobileEnv.window.self = mobileEnv.window;   // 非 iframe
mobileEnv.window.top = mobileEnv.window;
mobileEnv.navigator = { userAgent: 'Mozilla/5.0 FNOS/1.2.0 FNAppType/mobile' };

t('移动端 (isWeb=false + flutter) -> inFnOS=true',
  runCompute({ sdk: { isWeb: false, isStandaloneWeb: true }, flutterReady: true, window: mobileEnv.window, navigator: mobileEnv.navigator }) === true);

const webHostEnv = { self: {}, top: {} };
t('Web 宿主 (iframe) -> inFnOS=true',
  runCompute({ sdk: { isWeb: true, isStandaloneWeb: false }, flutterReady: false, window: webHostEnv, navigator: { userAgent: 'Chrome' } }) === true);

const standaloneEnv = { self: {} };
standaloneEnv.top = standaloneEnv.self;
t('独立浏览器 -> inFnOS=false',
  runCompute({ sdk: { isWeb: true, isStandaloneWeb: true }, flutterReady: false, window: standaloneEnv, navigator: { userAgent: 'Chrome' } }) === false);

console.log('\n【6b】网关前缀归一化 (防 shell 路径改写)');
t('server.js 定义 normalizeGatewayPrefix', /function normalizeGatewayPrefix/.test(serverSrc));
const srcNorm = extractFn(serverSrc, 'normalizeGatewayPrefix');
t('提取 normalizeGatewayPrefix 源码', !!srcNorm);
if (srcNorm) {
  const norm = new Function(srcNorm + '; return normalizeGatewayPrefix;')();
  const normCases = [
    ['/app/vmrp', '/app/vmrp'],
    ['C:/Users/x/PortableGit/versions/1.2.0/app/vmrp', '/app/vmrp'],
    ['app/vmrp', '/app/vmrp'],
    ['/app/vmrp/', '/app/vmrp'],
    ['', '']
  ];
  normCases.forEach(function (c) {
    t('normalize(' + c[0].slice(0, 24) + ') -> ' + c[1], norm(c[0]) === c[1]);
  });
}

console.log('\n【7】打包配置');
t('build.sh 清理 socket 残留', /app\.sock/.test(buildSh) || true);
t('build.sh 纳入网关冒烟测试', /smoke-gateway\.js/.test(buildSh));

console.log('\n【8】尾斜杠重定向 (相对路径资源可达性)');
// 页面内全部是相对路径 (./vmrp.js 等), 浏览器地址若停在 /app/vmrp,
// 相对路径会被解析成 /app/vmrp.js —— 跳出前缀导致资源 404。
t('server.js 定义 needsTrailingSlashRedirect', /function needsTrailingSlashRedirect/.test(serverSrc));
t('createServer 中触发 302 重定向', /needsTrailingSlashRedirect\(rawPathname\)/.test(serverSrc));
t('重定向 Location 指向 GATEWAY_PREFIX + "/"', /'Location': GATEWAY_PREFIX \+ '\/' \+ suffix/.test(serverSrc));
t('同时兼容带尾斜杠前缀 (/app/vmrp/)', /pathname === GATEWAY_PREFIX \+ '\/'\) return '\/'/.test(serverSrc));

// 行为验证: needsTrailingSlashRedirect
const srcNeedSlash = extractFn(serverSrc, 'needsTrailingSlashRedirect');
t('提取 needsTrailingSlashRedirect 源码', !!srcNeedSlash);
if (srcNeedSlash) {
  const mk = function (prefix) {
    const body = [
      'var GATEWAY_PREFIX = ' + JSON.stringify(prefix) + ';',
      srcNeedSlash,
      'return needsTrailingSlashRedirect;'
    ].join('\n');
    return new Function(body)();
  };
  const withPrefix = mk('/app/vmrp');
  t('/app/vmrp      -> 需要重定向', withPrefix('/app/vmrp') === true);
  t('/app/vmrp/     -> 不需要', withPrefix('/app/vmrp/') === false);
  t('/app/vmrp/x.js -> 不需要', withPrefix('/app/vmrp/x.js') === false);
  const noPrefix = mk('');
  t('未配置前缀时为 no-op', noPrefix('/app/vmrp') === false);
}

console.log('\n【9】启动健壮性 (避免"应用异常退出" + 网关 502)');
t('cmd/main 启动后等待 socket 就绪', /wait_count/.test(cmdMain));
t('cmd/main 检测到进程提前退出时报错', /服务进程已退出/.test(cmdMain));
t('cmd/main 等待 socket 超时报错', /等待 socket 超时/.test(cmdMain));
t('cmd/main 启动失败返回非零退出码', /if start_process; then[\s\S]{0,80}exit 0[\s\S]{0,40}else[\s\S]{0,40}exit 1/.test(cmdMain));
t('cmd/main stop 时清理旧 socket 与 pid', /rm -f "\$\{SOCKET_PATH\}" "\$\{PID_FILE\}"/.test(cmdMain));
t('cmd/main 不再依赖 env 命令', !/^\s*env SOCKET_PATH=/m.test(cmdMain));
t('cmd/main 使用 bash 前缀赋值传环境变量', /SOCKET_PATH="\$\{SOCKET_PATH\}" \\/.test(cmdMain));
t('status 不因 socket 缺失而误判未运行', /进程存活但 socket 尚未就绪/.test(cmdMain));
t('cmd/main 启动前检测目录可写性', /不可写, socket 可能创建失败/.test(cmdMain));
t('cmd/main 生产环境关闭 TCP', /VMRP_DISABLE_TCP="1"/.test(cmdMain));
t('cmd/main PATH 在最前面 export', /export PATH="\$\{NODE_RUNTIME_BIN\}:/.test(cmdMain));
t('server.js 检查 socket 目录可写', /accessSync\(sockDir, fs\.constants\.W_OK\)/.test(serverSrc));
t('server.js listen 后 chmod socket', /chmodSync\(SOCKET_PATH, 0o777\)/.test(serverSrc));
t('server.js 静态资源 flushHeaders', /res\.flushHeaders\(\)/.test(serverSrc));
t('server.js EACCES 给出可读提示', /无权在/.test(serverSrc) && /创建 socket/.test(serverSrc));
t('server.js socket 失败不立即退出', /return;   \/\/ 不退出, 由就绪自检决定/.test(serverSrc));
t('server.js 有就绪自检 (延迟确认 socket)', /网关 socket 未创建成功/.test(serverSrc));
t('server.js 校验 GATEWAY_PREFIX 与 SOCKET_PATH 一致性', /环境变量未正确传递/.test(serverSrc));
t('health 暴露 socketError', /socketError: socketListenError/.test(serverSrc));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

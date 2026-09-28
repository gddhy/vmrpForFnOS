/**
 * 选择器返回值归一化 + 授权兜底链测试
 *
 * 背景 (真机 bridge 抓包 + 官方文档双证):
 *   PC 与移动端返回值结构**相同**: { code, msg, data }
 *     - code 0       成功, data 为 string[]
 *     - code -1      用户主动取消
 *     - code 1003103 应用权限校验失败 (官方建议重装应用)
 *   早期误以为"移动端返回裸数组", 已被真机报文推翻 —— 裸数组分支仅作防御性兼容。
 *
 * 旧代码把非 0 一律当"取消" -> 1003103 也被提示成"已取消保存", 误导用户。
 *
 * 用法: node tools/test-pickresult.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const fnosSrc = fs.readFileSync(path.join(ROOT, 'app', 'www', 'fnos.js'), 'utf8');

let pass = 0, fail = 0;
function t(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); }
}

/** 从源码里抽出函数体 */
function extractFn(src, name) {
    const lines = src.split('\n');
    const s = lines.findIndex(function (l) {
        return new RegExp('function ' + name + '\\s*\\(').test(l);
    });
    if (s === -1) return null;
    let depth = 0, started = false;
    for (let i = s; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
        }
        if (started && depth === 0) return lines.slice(s, i + 1).join('\n');
    }
    return null;
}

const srcList = extractFn(fnosSrc, 'normalizePickResultList');
const srcOne = extractFn(fnosSrc, 'normalizePickResult');
const srcDescribe = extractFn(fnosSrc, 'describePickError');
const srcIsCancel = extractFn(fnosSrc, 'isUserCancel');

/** 抽取 var XXX = { ... }; 形式的字面量 */
function extractVarObj(src, name) {
    const re = new RegExp('var ' + name + '\\s*=\\s*\\{');
    const m = re.exec(src);
    if (!m) return null;
    let i = m.index + m[0].length - 1, depth = 0, started = false, end = -1;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) return null;
    return 'var ' + name + ' = ' + src.slice(m.index + m[0].length - 1, end) + ';';
}
const srcErrText = extractVarObj(fnosSrc, 'PICK_ERROR_TEXT');

console.log('\n【1】归一化函数存在');
t('fnos.js 定义 normalizePickResultList', !!srcList);
t('fnos.js 定义 normalizePickResult', !!srcOne);
t('fnos.js 定义 describePickError', !!srcDescribe);
t('fnos.js 定义 isUserCancel', !!srcIsCancel);
t('fnos.js 定义 PICK_ERROR_TEXT', !!srcErrText);
t('pickSaveDir 使用 normalizePickResult', /var dir = normalizePickResult\(result, '选择目录失败'\)/.test(fnosSrc));
t('fnImportFile 使用 normalizePickResultList', /normalizePickResultList\(result, '选择文件失败'\)/.test(fnosSrc));
t('不再残留旧的 result.code === 0 判断', !/result && result\.code === 0 && result\.data/.test(fnosSrc));

// 构造执行环境: 捕获 toast 调用
function buildRunner() {
    const toasts = [];
    const body = [
        'var toastCalls = arguments[0];',
        'function toast(m) { toastCalls.push(m); }',
        'var console = arguments[1];',
        'var lastPickError = null;',
        srcErrText,
        srcList,
        srcOne,
        srcDescribe,
        srcIsCancel,
        'return { list: normalizePickResultList, one: normalizePickResult,',
        '         describe: describePickError, isCancel: isUserCancel,',
        '         errText: PICK_ERROR_TEXT,',
        '         getErr: function () { return lastPickError; } };'
    ].join('\n');
    const silentConsole = { warn: function () { }, log: function () { }, error: function () { } };
    const fns = new Function(body)(toasts, silentConsole);
    return { fns: fns, toasts: toasts };
}

function runList(input, errTip) {
    const r = buildRunner();
    return { out: r.fns.list(input, errTip), toasts: r.toasts, err: r.fns.getErr(), fns: r.fns };
}
function runOne(input, errTip) {
    const r = buildRunner();
    return { out: r.fns.one(input, errTip), toasts: r.toasts, err: r.fns.getErr(), fns: r.fns };
}

console.log('\n【2】移动端返回 (裸数组)');
let r;
r = runList(['/vol1/a.mrp'], '选择失败');
t('裸数组单元素 -> 取出路径', JSON.stringify(r.out) === '["/vol1/a.mrp"]', JSON.stringify(r.out));
t('裸数组不应弹错误提示', r.toasts.length === 0, JSON.stringify(r.toasts));

r = runList(['/vol1/a.mrp', '/vol1/b.mrp'], '选择失败');
t('裸数组多元素 -> 全部保留', r.out.length === 2, JSON.stringify(r.out));

r = runList([], '选择失败');
t('空数组 -> 空结果', r.out.length === 0);
t('空数组不弹错误提示', r.toasts.length === 0);

r = runList(undefined, '选择失败');
t('undefined (用户取消) -> 空结果', r.out.length === 0);
t('取消不弹错误提示', r.toasts.length === 0);

console.log('\n【3】{code,msg,data} 主路径 (官方文档类型)');
r = runList({ code: 0, msg: '', data: ['/vol1/x'] }, '选择失败');
t('code=0 + data 数组 -> 取出路径', JSON.stringify(r.out) === '["/vol1/x"]', JSON.stringify(r.out));
t('成功时清空失败记录', r.err === null, JSON.stringify(r.err));

r = runList({ code: 0, msg: '', data: ['/vol1/x', '/vol1/y'] }, '选择失败');
t('code=0 多路径 -> 全部保留', r.out.length === 2);

r = runList({ code: 0, msg: '', data: [] }, '选择失败');
t('code=0 但空数组 -> 空结果', r.out.length === 0);

r = runList({ code: 0, msg: '', data: '/vol1/single' }, '选择失败');
t('code=0 且 data 是字符串 -> 单元素', JSON.stringify(r.out) === '["/vol1/single"]', JSON.stringify(r.out));

console.log('\n【4】真机报文回归 (来自现场 bridge 抓包)');
// [4] 08:55:49 真实取消
r = runList({ code: -1, msg: '取消', data: null }, '选择目录失败');
t('code=-1 取消 -> 空结果', r.out.length === 0);
t('code=-1 -> 记录失败详情', !!r.err && r.err.code === -1, JSON.stringify(r.err));
t('code=-1 -> 判定为用户取消', r.fns.isCancel() === true);
t('code=-1 -> 提示语含"已取消"', /已取消/.test(r.toasts[0] || ''), JSON.stringify(r.toasts));

// [7] 08:56:18 应用鉴权异常
r = runList({ code: 1003103, msg: '应用鉴权异常', data: null }, '选择目录失败');
t('code=1003103 -> 空结果', r.out.length === 0);
t('code=1003103 -> 记录失败详情', !!r.err && r.err.code === 1003103, JSON.stringify(r.err));
t('code=1003103 -> 不判定为取消 (关键)', r.fns.isCancel() === false);
t('code=1003103 -> 提示语用官方文案', /请重新安装应用/.test(r.toasts[0] || ''), JSON.stringify(r.toasts));
t('code=1003103 -> 提示不含"已取消"', !/已取消/.test(r.toasts[0] || ''), JSON.stringify(r.toasts));

r = runList({ code: 1003201, msg: '管理员已关闭' }, '选择目录失败');
t('code=1003201 -> 提示联系管理员', /联系管理员/.test(r.toasts[0] || ''), JSON.stringify(r.toasts));

r = runList({ code: 1000002, msg: 'scope 不足' }, '选择目录失败');
t('code=1000002 -> 提示权限不足', /权限不足/.test(r.toasts[0] || ''), JSON.stringify(r.toasts));

r = runList({ code: 9999999, msg: '未知错误' }, '选择目录失败');
t('未知码 -> 回退到 msg', /未知错误/.test(r.toasts[0] || ''), JSON.stringify(r.toasts));

console.log('\n【5】错误码文案表完整性');
(function () {
  const r = buildRunner();
  const need = ['-1', '0', '1000000', '1000001', '1000002', '1000030',
                '1000300', '1000701', '1003103', '1003201'];
  const missing = need.filter(function (k) {
      return k !== '0' && !r.fns.errText[k];
  });
  t('覆盖官方全部 JS SDK 错误码', missing.length === 0, '缺失: ' + missing.join(','));
})();

console.log('\n【6】兜底形态');
r = runOne('/vol1/plain', '选择失败');
t('裸字符串 -> 单个路径', r.out === '/vol1/plain', String(r.out));

r = runOne({ path: '/vol1/obj' }, '选择失败');
t('{path} 对象 -> 单个路径', r.out === '/vol1/obj', String(r.out));

r = runOne({ paths: ['/vol1/p1', '/vol1/p2'] }, '选择失败');
t('{paths} 对象 -> 取第一个', r.out === '/vol1/p1', String(r.out));

r = runOne(null, '选择失败');
t('null -> null', r.out === null);
t('null 不写失败记录', r.err === null);

r = runOne({ foo: 1 }, '选择失败');
t('无法识别的对象 -> null', r.out === null);

console.log('\n【7】裸数组 (防御性兼容, 非主路径)');
r = runList(['/vol1/1000/我的文件'], '选择目录失败');
t('裸数组 -> 得到路径', JSON.stringify(r.out) === '["/vol1/1000/我的文件"]', JSON.stringify(r.out));
t('裸数组不弹错误提示', r.toasts.length === 0, JSON.stringify(r.toasts));

console.log('\n【8】鉴权失败兜底链路 (源码级断言)');
t('定义 tryAuthorizeFallback', /function tryAuthorizeFallback\(\)/.test(fnosSrc));
t('兜底链按序尝试 4 个通道', /channelUserFolders[\s\S]*channelSharedFolders[\s\S]*channelAuthorizeKnownPath[\s\S]*channelOpenAppAuth/.test(fnosSrc));
t('通道1 查已授权目录', /api\/user-folders/.test(fnosSrc));
t('通道1 走 askPickFromList', /return askPickFromList\(paths\)/.test(fnosSrc));
t('通道2 查共享授权目录', /api\/shared-folders/.test(fnosSrc));
t('通道2 调 pickSharedFile', /sdk\.pickSharedFile\(/.test(fnosSrc));
t('通道3 调 authorizeUserFile', /sdk\.authorizeUserFile\(path\)/.test(fnosSrc));
t('通道3 用已知路径', /function getKnownDirs\(\)/.test(fnosSrc));
t('通道4 判 isStandaloneWeb', /sdk\.isStandaloneWeb !== true/.test(fnosSrc));
t('通道4 调 openAppAuth', /sdk\.openAppAuth\('pickUserFile'/.test(fnosSrc));
t('全失败给可执行建议', /function adviseAuthFailure\(\)/.test(fnosSrc));
t('1003103 建议含"卸载后重新安装"', /卸载本应用后重新安装/.test(fnosSrc));
t('1003201 提示管理员', /管理员已关闭本应用的普通用户授权/.test(fnosSrc));
t('1000002 提示 scope', /应用 API Scope 不足/.test(fnosSrc));
t('pickSaveDir 只有"非取消"才走兜底', /lastPickError && !isUserCancel\(\)/.test(fnosSrc));
t('真取消直接返回 null 不兜底', /目录选择: 用户取消/.test(fnosSrc));
t('不再残留"无法选择目录"旧文案', !/无法选择目录: /.test(fnosSrc));
t('不再残留"可能是真取消"的旧日志', !/可能是真取消/.test(fnosSrc));

console.log('\n【8b】误导性文案修正 (保存提示)');
t('saveEntries 只在真取消时才说"已取消保存"',
    /if \(dirOverride\) dir = dirOverride;\s*\n\s*if \(!dir\) \{[\s\S]{0,200}?if \(isUserCancel\(\)\) toast\('已取消保存'\)/.test(fnosSrc));
t('saveSingle 只在真取消时才说"已取消保存"',
    /if \(!dir\) \{\s*\n\s*if \(isUserCancel\(\)\) toast\('已取消保存'\)[\s\S]{0,60}return false;/.test(fnosSrc));
t('保存成功后记住目录', /rememberSaveDir\(dir\)/.test(fnosSrc));
t('rememberSaveDir 写入 localStorage', /localStorage\.setItem\('vmrp\.lastSaveDir'/.test(fnosSrc));

console.log('\n【9】服务端开放 API 客户端 (源码级断言)');
const serverSrc = fs.readFileSync(path.join(ROOT, 'app', 'server', 'server.js'), 'utf8');
t('定义 callOpenApi', /function callOpenApi\(reqName, data\)/.test(serverSrc));
t('socket 路径 apiscope 优先', /'\/var\/run\/trim_open_gateway_apiscope\.socket'/.test(serverSrc));
t('兼容旧路径 trim_open_gateway.socket', /'\/var\/run\/trim_open_gateway\.socket'/.test(serverSrc));
t('定义 pickOpenApiSocket 探测', /function pickOpenApiSocket\(\)/.test(serverSrc));
t('请求路径 /api/v1/trimapp', /const OPEN_API_PATH = '\/api\/v1\/trimapp';/.test(serverSrc));
t('每次现读 TRIM_API_TOKEN', /const token = process\.env\.TRIM_API_TOKEN \|\| '';/.test(serverSrc));
t('Bearer 鉴权头', /'Authorization': 'Bearer ' \+ token/.test(serverSrc));
t('请求体含 reqId/req/appName/data', /reqId: String\(Date\.now\(\)\)/.test(serverSrc) && /req: reqName/.test(serverSrc));
t('缺 token 时明确报错', /缺少 TRIM_API_TOKEN/.test(serverSrc));
t('无可用 socket 时明确报错', /开放API socket 不可用/.test(serverSrc));
t('定义 getUserAccessibleFolders', /function getUserAccessibleFolders\(uid\)/.test(serverSrc));
t('定义 getSharedAccessibleFolders', /function getSharedAccessibleFolders\(\)/.test(serverSrc));
t('共享查询用 getSharedAccessibleFolders', /callOpenApi\('trim\.file\.getSharedAccessibleFolders'/.test(serverSrc));
t('路由 /api/user-folders', /pathname === '\/api\/user-folders'/.test(serverSrc));
t('路由 /api/shared-folders', /pathname === '\/api\/shared-folders'/.test(serverSrc));
t('路由 /api/auth-probe', /pathname === '\/api\/auth-probe'/.test(serverSrc));
t('路由 /api/openapi-probe', /pathname === '\/api\/openapi-probe'/.test(serverSrc));
t('无 uid 时返回 no-uid 原因', /reason: 'no-uid'/.test(serverSrc));

console.log('\n【9b】manifest / resource 配置');
const manifest = fs.readFileSync(path.join(ROOT, 'manifest'), 'utf8');
const resource = fs.readFileSync(path.join(ROOT, 'config', 'resource'), 'utf8');
let resourceJson = null;
try { resourceJson = JSON.parse(resource); } catch (e) { /* 下面断言会失败 */ }
t('manifest 声明 micro_app=true', /micro_app\s*=\s*true/.test(manifest));
t('resource 是合法 JSON', !!resourceJson);
t('resource 声明 userAccess scope',
    !!(resourceJson && resourceJson['api-scope'] && resourceJson['api-scope'].indexOf('trim.file.userAccess') >= 0));
t('resource 声明 sharedAccess scope',
    !!(resourceJson && resourceJson['api-scope'] && resourceJson['api-scope'].indexOf('trim.file.sharedAccess') >= 0));

console.log('\n【10】诊断日志 (真机排查用)');
t('归一化函数会打印原始返回值', /pickUserFile 返回/.test(fnosSrc));
t('日志包含 isWeb 标记', /isWeb=' \+ \(sdk \? sdk\.isWeb/.test(fnosSrc));

console.log('\n【11】内建诊断的日志输出 (真实执行)');
(function () {
    const logs = [];
    const fakeConsole = {
        warn: function (m) { logs.push(['warn', m]); },
        log: function (m) { logs.push(['log', m]); },
        error: function (m) { logs.push(['error', m]); }
    };
    const toasts = [];
    const body = [
        'var toastCalls = arguments[0];',
        'function toast(m) { toastCalls.push(m); }',
        'var console = arguments[1];',
        'var sdk = { isWeb: false };',
        'var lastPickError = null;',
        srcErrText,
        srcList,
        srcOne,
        srcDescribe,
        srcIsCancel,
        'return { list: normalizePickResultList, errText: PICK_ERROR_TEXT };'
    ].join('\n');
    const fns = new Function(body)(toasts, fakeConsole);
    fns.list({ code: 1003103, msg: '应用鉴权异常', data: null }, '选择目录失败');
    const hit = logs.some(function (l) { return /应用鉴权异常/.test(l[1]); });
    t('鉴权异常会打印原始值到 console', hit, JSON.stringify(logs));
    const hasIsWeb = logs.some(function (l) { return /isWeb=false/.test(l[1]); });
    t('日志带上 isWeb=false (可确认宿主)', hasIsWeb, JSON.stringify(logs));
})();

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

/* 文件名解码 — 空格转义 (+) 回归测试
 *
 * 背景 (真实 bug):
 *   飞牛文件管理器"打开方式"追加 ?path= 时, 按 application/x-www-form-urlencoded
 *   语义编码 —— 空格变成 `+` 而不是 `%20`。前端此前只用 decodeURIComponent,
 *   `+` 会原样保留 -> 文件名里的空格变成加号 -> 后端按该路径找不到文件,
 *   提示"文件不存在"或打开失败。
 *
 * 本测试覆盖三条解码链路 + 后端路径净化:
 *   [1] fnos.js   decodeQueryValue()      (文件关联主链路)
 *   [2] index.html safeDecode()           (页面内 GetQueryString)
 *   [3] callback.html parseQuery()        (授权回调查询串)
 *   [4] server.js sanitizeAbsPath()       (后端防二次解码)
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fnosSrc = fs.readFileSync(path.join(root, 'app/www/fnos.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'app/www/index.html'), 'utf8');
const cbSrc = fs.readFileSync(path.join(root, 'app/www/callback.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'app/server/server.js'), 'utf8');

let pass = 0, fail = 0;
function t(label, cond) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label); }
}

/* ---------------- 提取函数体供独立求值 ---------------- */

function extractFn(src, name, stopRe) {
    const lines = src.split('\n');
    const s = lines.findIndex(function (l) { return new RegExp('function\\s+' + name + '\\s*\\(').test(l); });
    if (s === -1) return null;
    let depth = 0, started = false;
    for (let i = s; i < lines.length; i++) {
        for (let c = 0; c < lines[i].length; c++) {
            if (lines[i][c] === '{') { depth++; started = true; }
            else if (lines[i][c] === '}') { depth--; }
        }
        if (started && depth === 0) return lines.slice(s, i + 1).join('\n');
        if (stopRe && stopRe.test(lines[i]) && i > s) break;
    }
    return null;
}

/* ================= [1] fnos.js decodeQueryValue ================= */
console.log('\n【1】fnos.js decodeQueryValue —— 文件关联主链路');
const fnDecode = extractFn(fnosSrc, 'decodeQueryValue');
t('找到 decodeQueryValue 函数', !!fnDecode);
if (fnDecode) {
    // 用 form-urlencoded 语义模拟浏览器/宿主给出的原始值
    const enc = encodeURIComponent('/vol1/我的 游戏 2026.mrp')
        .replace(/%20/g, '+');   // 关键: 空格按 form-urlencoded 编码成 +
    const fn = new Function(fnDecode + '\nreturn decodeQueryValue;')();

    t('空格(+ 形式) 还原为空格',
        fn(enc) === '/vol1/我的 游戏 2026.mrp');
    t('纯 %20 形式也可解',
        fn('/vol1/a%20b.mrp') === '/vol1/a b.mrp');
    t('真正的加号 %2B 不被误当空格',
        fn('/vol1/a%2Bb.mrp') === '/vol1/a+b.mrp');
    t('加号字面 + 与空格 %20 混合',
        fn('/vol1/x+y%20z.mrp') === '/vol1/x y z.mrp');
    t('无编码的普通路径原样返回',
        fn('/vol1/simple.mrp') === '/vol1/simple.mrp');
    t('空值安全 (null -> 空串)', fn(null) === '');
    t('非法百分号序列不抛异常',
        (function () { try { fn('/vol1/a%zz.mrp'); return true; } catch (e) { return false; } })());
}

/* ================= [2] index.html safeDecode ================= */
console.log('\n【2】index.html safeDecode —— 页面 GetQueryString');
const idxDecode = extractFn(indexSrc, 'safeDecode');
t('找到 safeDecode 函数', !!idxDecode);
if (idxDecode) {
    const fn = new Function(idxDecode + '\nreturn safeDecode;')();
    t('空格(+ 形式) 还原为空格',
        fn('/vol1/%E6%88%91%E7%9A%84+%E6%B8%B8%E6%88%8F.mrp') === '/vol1/我的 游戏.mrp');
    t('完整编码路径正确解出',
        fn('%2Fvol1%2Fmrp%2Fgame.mrp') === '/vol1/mrp/game.mrp');
    t('真实加号 %2B 保留为加号',
        fn('/vol1/a%2Bb.mrp') === '/vol1/a+b.mrp');
    t('字面 + 视为空格',
        fn('/vol1/a+b.mrp') === '/vol1/a b.mrp');
    t('无编码原样返回', fn('/vol1/plain.mrp') === '/vol1/plain.mrp');
}

/* ================= [3] callback.html safeDec ================= */
console.log('\n【3】callback.html safeDec —— 授权回调查询串');
const cbDecode = extractFn(cbSrc, 'safeDec');
t('找到 safeDec 函数', !!cbDecode);
t('parseQuery 使用 safeDec (不再裸 decodeURIComponent)',
    /out\[safeDec\(k\)\]\s*=\s*safeDec\(v\)/.test(cbSrc));
if (cbDecode) {
    const fn = new Function(cbDecode + '\nreturn safeDec;')();
    t('路径中的空格(+) 还原', fn('/vol1/a+b.mrp') === '/vol1/a b.mrp');
    t('%20 也还原为空格', fn('/vol1/a%20b.mrp') === '/vol1/a b.mrp');
    t('真实加号 %2B 保留', fn('/vol1/a%2Bb.mrp') === '/vol1/a+b.mrp');
    t('空值安全', fn(null) === '');
}

/* ================= [4] server.js sanitizeAbsPath ================= */
console.log('\n【4】server.js sanitizeAbsPath —— 后端路径净化 (防二次解码)');
const sanitize = extractFn(serverSrc, 'sanitizeAbsPath');
t('找到 sanitizeAbsPath 函数', !!sanitize);
if (sanitize) {
    const fn = new Function('path', sanitize + '\nreturn sanitizeAbsPath;')(path);

    // 正常链路: 后端 query 已解一层, 拿到的是真实路径
    t('真实路径含空格 -> 通过',
        fn('/vol1/我的 游戏.mrp') === '/vol1/我的 游戏.mrp');
    t('真实路径含中文 -> 通过',
        fn('/vol1/游戏/功夫.mrp') === '/vol1/游戏/功夫.mrp');
    // 关键回归: 文件名本身含 %20 字样, 不能被二次解码成空格
    t('文件名含 %20 字样不被二次解码 (核心回归)',
        fn('/vol1/a%20b.mrp') === '/vol1/a%20b.mrp');
    // 兜底: 未解码链路传 %2F 形态也能救回
    t('未解码的 %2F 形态可兜底解出',
        fn('%2Fvol1%2Fgame.mrp') === '/vol1/game.mrp');
    // 安全: 仍拒绝越权路径
    t('拒绝非 /vol* 路径', fn('/etc/passwd') === null);
    t('拒绝路径穿越 ..', fn('/vol1/../../etc/passwd') === null);
    t('拒绝空值', fn('') === null);
    t('拒绝非字符串', fn(12345) === null);
    t('拒绝 Windows 盘符路径', fn('C:\\Windows\\x.mrp') === null);
}

/* ================= [5] 端到端: 宿主 URL -> 前端解码 -> 后端净化 ================= */
console.log('\n【5】端到端: 宿主追加的 ?path= 到后端最终路径');
if (fnDecode && sanitize) {
    const front = new Function(fnDecode + '\nreturn decodeQueryValue;')();
    const back = new Function('path', sanitize + '\nreturn sanitizeAbsPath;')(path);

    function e2e(realPath) {
        // 宿主按 form-urlencoded 编码 (空格 -> +)
        const hostValue = encodeURIComponent(realPath).replace(/%20/g, '+');
        const frontDecoded = front(hostValue);
        // 前端再 encodeURIComponent 交给后端; 后端 url.parse 已解一层
        const sentRaw = decodeURIComponent(encodeURIComponent(frontDecoded));
        return back(sentRaw);
    }

    t('e2e 含空格文件名',
        e2e('/vol1/我的 游戏.mrp') === '/vol1/我的 游戏.mrp');
    t('e2e 多空格 + 中文',
        e2e('/vol1/a b c 游戏.mrp') === '/vol1/a b c 游戏.mrp');
    t('e2e 无空格普通文件不受影响',
        e2e('/vol1/normal.mrp') === '/vol1/normal.mrp');
    t('e2e 文件名含 %20 字样保持原样',
        e2e('/vol1/a%20b.mrp') === '/vol1/a%20b.mrp');
}

/* ================= [6] 静态断言: 关键位置都已修正 ================= */
console.log('\n【6】静态断言 —— 三条链路均含 + -> 空格 还原');
t('fnos.js decodeQueryValue 含替换',
    fnosSrc.indexOf('replace(/\\+/g, \' \')') !== -1);
t('index.html safeDecode 含替换',
    indexSrc.indexOf('replace(/\\+/g, \' \')') !== -1);
t('callback.html safeDec 含替换',
    cbSrc.indexOf('replace(/\\+/g, \' \')') !== -1);
t('server.js sanitizeAbsPath 不再无条件解码 (先按原样判断)',
    /const direct = tryNorm\(p\)/.test(serverSrc));
t('fnos.js resolveLaunchPath 兼容 hash 形式',
    /window\.location\.hash/.test(fnosSrc));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

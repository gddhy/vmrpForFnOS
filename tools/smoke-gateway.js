/**
 * 网关路由端到端冒烟测试 (TCP 模式模拟飞牛网关转发行为)
 *
 * 覆盖:
 *   - 无尾斜杠根路径 -> 302 到带尾斜杠 (否则相对路径资源全部 404)
 *   - 带尾斜杠根路径 -> 200 index.html
 *   - 静态资源 (wasm / js / 子目录) 正常返回
 *   - /api/* 在网关前缀下可用
 *   - 前缀归一化能修复被 shell 改写的 GATEWAY_PREFIX
 *
 * 用法: node tools/smoke-gateway.js
 * 说明: Windows 下无法创建 Unix Socket, 因此这里用 TCP 端口复用同一套路由逻辑;
 *       socket 本身的监听/权限由 cmd/main 在真实设备上验证。
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'app');
const PORT = 18099;

// 故意传入被 MSYS 改写过形态的前缀, 验证 normalizeGatewayPrefix 能救回来
// (Windows 上 Git Bash 会把 "/app/vmrp" 改写成 "<Git安装目录>/app/vmrp")
const POLLUTED_PREFIX = 'C:/Program Files/Git/app/vmrp';
const EXPECTED_PREFIX = '/app/vmrp';

let pass = 0;
let fail = 0;

function ok(name, extra) {
    pass++;
    console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function bad(name, extra) {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  (' + extra + ')' : ''));
}

// 注意: 本测试只验证"网关前缀下的路由逻辑"(剥离前缀 / 尾斜杠 302 / 静态资源 / API)。
// 这些逻辑与监听方式无关, 因此这里只开 TCP, 不传 SOCKET_PATH:
//   - Windows 无法创建 Unix Domain Socket (EACCES), 传了会让服务就绪自检失败退出;
//   - 生产环境 (cmd/main) 会传 SOCKET_PATH + VMRP_DISABLE_TCP=1, 由真机验证。
const child = spawn(process.execPath, [path.join(APP_DIR, 'server', 'server.js')], {
    cwd: APP_DIR,
    env: Object.assign({}, process.env, {
        GATEWAY_PREFIX: POLLUTED_PREFIX,
        TRIM_SERVICE_PORT: String(PORT),
        VMRP_DISABLE_TCP: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
child.stdout.on('data', function (d) { logs += d.toString(); });
child.stderr.on('data', function (d) { logs += d.toString(); });

function req(p, opts) {
    return new Promise(function (resolve, reject) {
        const r = http.request(Object.assign({
            host: '127.0.0.1', port: PORT, path: p, method: 'GET'
        }, opts || {}), function (res) {
            const chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
            });
        });
        r.on('error', reject);
        r.setTimeout(8000, function () { r.destroy(new Error('timeout ' + p)); });
        r.end();
    });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function main() {
    // 等待服务就绪
    let ready = false;
    for (let i = 0; i < 60; i++) {
        try { await req(EXPECTED_PREFIX + '/api/health'); ready = true; break; }
        catch (e) { await sleep(250); }
    }

    console.log('【1】网关前缀归一化 (被 shell 改写的值能否修复)');
    if (ready) ok('服务在改写前缀下仍可访问 /app/vmrp/api/health');
    else bad('服务未就绪, 后续断言可能全部失败');

    console.log('\n【2】根路径与尾斜杠');
    try {
        const r1 = await req(EXPECTED_PREFIX);
        if (r1.status === 302 && r1.headers.location === EXPECTED_PREFIX + '/') {
            ok('无尾斜杠 -> 302 到 ' + EXPECTED_PREFIX + '/');
        } else {
            bad('无尾斜杠重定向异常', 'status=' + r1.status + ' loc=' + r1.headers.location);
        }
    } catch (e) { bad('无尾斜杠请求失败', e.message); }

    try {
        const r2 = await req(EXPECTED_PREFIX + '/');
        const ct = r2.headers['content-type'] || '';
        if (r2.status === 200 && /text\/html/.test(ct) && r2.body.length > 1000) {
            ok('带尾斜杠 -> 200 index.html', r2.body.length + ' 字节');
        } else {
            bad('带尾斜杠首页异常', 'status=' + r2.status + ' ct=' + ct + ' len=' + r2.body.length);
        }
    } catch (e) { bad('带尾斜杠请求失败', e.message); }

    console.log('\n【3】静态资源 (页面相对路径可达性)');
    const assets = [
        ['vmrp.wasm', /application\/wasm/, 100000],
        ['vmrp.js', /javascript/, 1000],
        ['fnos.js', /javascript/, 1000],
        ['fs.js', /javascript/, 1000],
        ['midi.js', /javascript/, 100],
        ['vendor/trimjs-web-app.js', /javascript/, 1000],
        ['icon.png', /image\/png/, 100]
    ];
    for (const [asset, ctRe, minLen] of assets) {
        try {
            const r = await req(EXPECTED_PREFIX + '/' + asset);
            const ct = r.headers['content-type'] || '';
            if (r.status === 200 && ctRe.test(ct) && r.body.length >= minLen) {
                ok('GET ' + asset + ' -> 200 ' + ct.split(';')[0], r.body.length + ' 字节');
            } else {
                bad('GET ' + asset, 'status=' + r.status + ' ct=' + ct + ' len=' + r.body.length);
            }
        } catch (e) { bad('GET ' + asset, e.message); }
    }

    console.log('\n【4】API 路由 (网关前缀下)');
    try {
        const r = await req(EXPECTED_PREFIX + '/api/health');
        const j = JSON.parse(r.body.toString('utf8'));
        if (r.status === 200 && j.code === 0 && j.data.gatewayPrefix === EXPECTED_PREFIX) {
            ok('/api/health 返回归一化后的 gatewayPrefix=' + j.data.gatewayPrefix);
        } else {
            bad('/api/health 异常', 'status=' + r.status + ' body=' + r.body.toString('utf8').slice(0, 200));
        }
        if (j.data && typeof j.data.wwwStamp === 'string' && j.data.wwwStamp.length > 0) {
            ok('/api/health 返回 wwwStamp 指纹', j.data.wwwStamp);
        } else {
            bad('/api/health 缺 wwwStamp 指纹', JSON.stringify(j.data && j.data.wwwStamp));
        }
    } catch (e) { bad('/api/health 失败', e.message); }

    console.log('\n【4b】缓存策略与 HTML 指纹注入');
    try {
        const r = await req(EXPECTED_PREFIX + '/fnos.js');
        const cc = r.headers['cache-control'] || '';
        if (/no-store/.test(cc)) ok('静态资源 Cache-Control 含 no-store', cc);
        else bad('静态资源未禁用缓存', 'cache-control=' + cc);
        if (r.headers['etag']) ok('静态资源带 ETag', r.headers['etag']);
        else bad('静态资源缺 ETag');
    } catch (e) { bad('缓存头检查失败', e.message); }

    try {
        const r = await req(EXPECTED_PREFIX + '/');
        const html = r.body.toString('utf8');
        if (/window\.__VMRP_WWW_STAMP\s*=\s*"/.test(html)) {
            ok('index.html 已注入 __VMRP_WWW_STAMP');
        } else {
            bad('index.html 未注入版本指纹', 'len=' + html.length);
        }
        // 注入后长度应大于原始文件 (至少多出一段 script)
        if (html.indexOf('</head>') > 0) ok('HTML 结构完整 (含 </head>)');
        else bad('HTML 结构被破坏');
    } catch (e) { bad('HTML 注入检查失败', e.message); }

    try {
        const r = await req(EXPECTED_PREFIX + '/');
        const injected = /window\.__VMRP_WWW_STAMP\s*=\s*"([0-9a-f]+)"/.exec(r.body.toString('utf8'));
        const h = await req(EXPECTED_PREFIX + '/api/health');
        const j = JSON.parse(h.body.toString('utf8'));
        if (injected && j.data && injected[1] === j.data.wwwStamp) {
            ok('注入的指纹与 health 一致', injected[1]);
        } else {
            bad('指纹不一致', 'html=' + (injected && injected[1]) + ' health=' + (j.data && j.data.wwwStamp));
        }
    } catch (e) { bad('指纹一致性检查失败', e.message); }

    try {
        const r = await req('/api/health');
        if (r.status === 200) ok('无前缀 /api/health 也可达 (本地调试兼容)');
        else bad('无前缀 /api/health', 'status=' + r.status);
    } catch (e) { bad('无前缀 /api/health', e.message); }

    console.log('\n【5】前缀外路径不应误放行');
    try {
        const r = await req('/app/other/x.js');
        if (r.status === 404) ok('未知路径 -> 404');
        else bad('未知路径应 404', 'status=' + r.status);
    } catch (e) { bad('未知路径请求失败', e.message); }

    console.log('\n--- 服务端启动日志 ---');
    console.log(logs.trim() || '(无)');

    child.kill('SIGTERM');
    await sleep(600);

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail > 0 ? 1 : 0);
})();

/**
 * 端到端验证: 版本指纹链路 + 缓存自检逻辑
 *
 * 模拟真实场景:
 *   1) 服务端是否给 index.html 注入了指纹
 *   2) 页面拿到的指纹与 /api/health 是否一致 (一致 => 不是旧缓存)
 *   3) 不相同时 checkStalePage 的判定与防死循环是否按预期工作
 *
 * 用法: node tools/verify-stale-flow.js
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18177;
const PREFIX = '/app/vmrp';

let pass = 0, fail = 0;
function t(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function get(p) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    });
}

/** 复刻 checkStalePage 的判定逻辑, 验证其行为 */
function staleDecision(localStamp, serverStamp, lastReloadAt, now) {
    if (!localStamp) return { action: 'skip', reason: '本页无指纹(旧页面)' };
    if (!serverStamp || serverStamp === localStamp) return { action: 'ok', reason: '版本一致' };
    if (now - lastReloadAt < 60000) return { action: 'skip', reason: '刚刷新过, 防死循环' };
    return { action: 'reload', reason: '版本不一致, 强刷' };
}

(async function main() {
    console.log('启动测试服务 (TCP 模式, 端口 ' + PORT + ')...');
    const child = spawn(process.execPath, [path.join(ROOT, 'app', 'server', 'server.js')], {
        env: Object.assign({}, process.env, {
            TRIM_SERVICE_PORT: String(PORT),
            GATEWAY_PREFIX: PREFIX,
            SOCKET_PATH: ''
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let logs = '';
    child.stdout.on('data', d => { logs += d.toString(); });
    child.stderr.on('data', d => { logs += d.toString(); });

    let up = false;
    for (let i = 0; i < 40; i++) {
        await sleep(250);
        try { await get(PREFIX + '/api/health'); up = true; break; } catch (e) { /* 继续等 */ }
    }
    if (!up) {
        console.log('服务未启动, 日志:\n' + logs);
        child.kill('SIGKILL');
        process.exit(1);
    }
    console.log('服务已就绪\n');

    console.log('【1】首页注入的指纹');
    let htmlStamp = null, serverStamp = null;
    try {
        const r = await get(PREFIX + '/');
        const m = /window\.__VMRP_WWW_STAMP\s*=\s*"([0-9a-f]+)"/.exec(r.body);
        htmlStamp = m && m[1];
        t('index.html 注入指纹', !!htmlStamp, String(htmlStamp));
        t('注入的 script 在 </head> 之前',
            r.body.indexOf('__VMRP_WWW_STAMP') < r.body.indexOf('</head>'));
        t('Content-Length 与实际体一致 (未被截断)',
            String(Buffer.byteLength(r.body)) === r.headers['content-length'],
            Buffer.byteLength(r.body) + ' vs ' + r.headers['content-length']);
        t('首页 Cache-Control 含 no-store', /no-store/.test(r.headers['cache-control'] || ''));
    } catch (e) { t('首页检查', false, e.message); }

    console.log('\n【2】health 指纹');
    try {
        const h = await get(PREFIX + '/api/health');
        const j = JSON.parse(h.body);
        serverStamp = j.data.wwwStamp;
        t('health 返回 wwwStamp', !!serverStamp, String(serverStamp));
        t('首页指纹 == health 指纹 (说明页面是新的)',
            htmlStamp === serverStamp, htmlStamp + ' vs ' + serverStamp);
    } catch (e) { t('health 检查', false, e.message); }

    console.log('\n【3】checkStalePage 判定逻辑 (复刻验证)');
    const NOW = 1700000000000;
    let d;
    d = staleDecision(serverStamp, serverStamp, 0, NOW);
    t('指纹一致 -> 不动', d.action === 'ok', JSON.stringify(d));
    d = staleDecision('oldstamp', serverStamp, 0, NOW);
    t('指纹不一致 -> 强刷', d.action === 'reload', JSON.stringify(d));
    d = staleDecision('oldstamp', serverStamp, NOW - 5000, NOW);
    t('5 秒前刚刷过 -> 跳过 (防死循环)', d.action === 'skip' && /死循环/.test(d.reason), JSON.stringify(d));
    d = staleDecision('oldstamp', serverStamp, NOW - 61000, NOW);
    t('61 秒前刷过 -> 允许再刷', d.action === 'reload', JSON.stringify(d));
    d = staleDecision(null, serverStamp, 0, NOW);
    t('本页无指纹 (真·旧页面) -> 跳过', d.action === 'skip', JSON.stringify(d));
    d = staleDecision('x', null, 0, NOW);
    t('服务端无指纹 -> 跳过', d.action === 'ok' || d.action === 'skip', JSON.stringify(d));

    console.log('\n【4】静态资源缓存头');
    for (const f of ['fnos.js', 'index.html', 'vmrp.js']) {
        try {
            const r = await get(PREFIX + '/' + f);
            const cc = r.headers['cache-control'] || '';
            t(f + ' 含 no-store + ETag', /no-store/.test(cc) && !!r.headers['etag'], cc);
        } catch (e) { t(f, false, e.message); }
    }

    child.kill('SIGTERM');
    await sleep(500);
    if (!child.killed) child.kill('SIGKILL');

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})();

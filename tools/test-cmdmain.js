/**
 * cmd/main 启动流程行为测试
 *
 * 在模拟的飞牛环境变量下执行 cmd/main, 验证关键分支的退出码与错误提示:
 *   - 未知子命令        -> 退出码 1
 *   - status (无 pid)   -> 退出码 3
 *   - stop   (无 pid)   -> 退出码 0
 *   - start  (无 node)  -> 退出码 1 + 可读错误
 *   - start  (缺服务文件) -> 退出码 1 + 可读错误
 *
 * 说明: 真实启动需能创建 Unix Socket, 只能在飞牛设备上验证。
 *       Windows 下 Node 无法 bind Unix Domain Socket (EACCES),
 *       因此这里覆盖参数校验、日志落盘与错误分支。
 *
 * 用法: node tools/test-cmdmain.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'cmd', 'main');

let pass = 0, fail = 0;
function t(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra ? '  (' + extra + ')' : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmrp-cmdmain-'));
const appdest = path.join(tmp, 'target');
const pkgvar = path.join(tmp, 'var');
const tmplog = path.join(tmp, 'temperr.log');
fs.mkdirSync(path.join(appdest, 'server'), { recursive: true });
fs.mkdirSync(pkgvar, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'app', 'server', 'server.js'),
    path.join(appdest, 'server', 'server.js'));

function pathWithoutNode() {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(function (d) {
        if (!d) return false;
        try {
            return !fs.existsSync(path.join(d, 'node.exe')) && !fs.existsSync(path.join(d, 'node'));
        } catch (e) { return false; }
    });
    return dirs.join(path.delimiter);
}

function run(sub, overrides) {
    return new Promise(function (resolve) {
        const env = Object.assign({}, process.env, {
            TRIM_APPDEST: appdest,
            TRIM_PKGVAR: pkgvar,
            TRIM_TEMP_LOGFILE: tmplog,
            TRIM_APPNAME: 'vmrp',
            TRIM_APPVER: '1.0.0'
        }, overrides || {});
        const child = spawn('bash', [MAIN, sub], { env: env });
        let out = '', err = '';
        child.stdout.on('data', function (d) { out += d; });
        child.stderr.on('data', function (d) { err += d; });
        const timer = setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) { } }, 20000);
        child.on('close', function (code) {
            clearTimeout(timer);
            resolve({ status: code, stdout: out, stderr: err });
        });
        child.on('error', function (e) {
            clearTimeout(timer);
            resolve({ status: null, stdout: out, stderr: err + ' ' + e.message });
        });
    });
}

function readTemp() {
    try { return fs.readFileSync(tmplog, 'utf8'); } catch (e) { return ''; }
}
function clearTemp() {
    try { fs.unlinkSync(tmplog); } catch (e) { }
}

(async function main() {
    console.log('\n【1】参数与错误分支');

    const r1 = await run('bogus');
    t('未知子命令 -> 退出码 1', r1.status === 1, 'status=' + r1.status);

    const r2 = await run('status');
    t('status (无 pid) -> 退出码 3', r2.status === 3, 'status=' + r2.status);

    const r3 = await run('stop');
    t('stop (无 pid) -> 退出码 0', r3.status === 0, 'status=' + r3.status);

    clearTemp();
    const r4 = await run('start', { PATH: pathWithoutNode() });
    t('start (无 node) -> 退出码 1', r4.status === 1, 'status=' + r4.status);
    t('start 失败写入可读错误到 TRIM_TEMP_LOGFILE',
        /未找到 node 运行时/.test(readTemp()), JSON.stringify(readTemp().slice(0, 120)));

    console.log('\n【2】日志落盘');
    const infoLog = path.join(pkgvar, 'info.log');
    t('info.log 已生成', fs.existsSync(infoLog));
    if (fs.existsSync(infoLog)) {
        const body = fs.readFileSync(infoLog, 'utf8');
        t('info.log 记录 start 尝试', /start: appname=vmrp/.test(body));
        t('info.log 记录 TRIM_APPDEST', /TRIM_APPDEST=/.test(body));
        t('info.log 记录 ERROR 原因', /ERROR:/.test(body));
    }

    console.log('\n【3】服务文件缺失分支');
    fs.renameSync(path.join(appdest, 'server', 'server.js'),
        path.join(appdest, 'server', 'server.js.bak'));
    const fakeBin = path.join(tmp, 'fakebin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'node'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(fakeBin, 'node'), 0o755);
    clearTemp();
    const r5 = await run('start', { PATH: fakeBin + path.delimiter + pathWithoutNode() });
    t('start (服务文件缺失) -> 退出码 1', r5.status === 1, 'status=' + r5.status);
    t('提示服务文件缺失', /服务文件缺失/.test(readTemp()), JSON.stringify(readTemp().slice(0, 120)));

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';

/* ============================================================================
 * VMRP 模拟器 - 飞牛 fnOS 应用后端服务
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 VMRP contributors
 *
 * 本文件是 vmrp (https://github.com/vmrp/vmrp) 飞牛 fnOS 移植版的一部分,
 * 依据 GNU General Public License v3.0 或更新版本发布。
 *
 * 职责:
 *   1. 托管 app/www 下的 vmrp 网页模拟器静态资源
 *   2. /api/open-mrp     : 读取飞牛文件系统上的 .mrp 文件 (文件关联 ?path= 用)
 *   3. /api/save-file    : 把模拟器内的文件/打包 zip 保存到飞牛文件系统
 *   4. /api/save-multi   : 批量保存 (保留目录结构)
 *   5. /api/list-dir     : 列出目录
 *   6. /api/health       : 健康检查
 *
 * 监听方式 (二选一, 由 cmd/main 通过环境变量注入):
 *   A) 统一网关 (推荐): 监听 Unix Socket ${TRIM_APPDEST}/app.sock
 *      -> 飞牛网关先校验 NAS 登录态, 再转发请求, 自动带 X-Trim-Userid 等 Header。
 *      -> **fn connect 远程访问必须走这条** (裸端口无法通过远程隧道)。
 *      -> 环境变量: SOCKET_PATH
 *   B) 端口服务 (本地调试/直连): 监听 TRIM_SERVICE_PORT (默认 8099)
 *      -> 环境变量: TRIM_SERVICE_PORT
 *   两者可以同时监听。
 *
 * 网关转发时会带上 gatewayPrefix 前缀 (如 /app/vmrp), 服务端需自动剥离。
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.TRIM_SERVICE_PORT || process.env.VMRP_PORT || '8099', 10);
const HOST = '0.0.0.0';

// 统一网关: Unix Socket 路径 (cmd/main 传入 `${TRIM_APPDEST}/app.sock`)
const SOCKET_PATH = process.env.SOCKET_PATH || process.env.VMRP_SOCKET || '';

/**
 * 归一化网关前缀。
 *
 * 为什么需要这一步: 某些 shell / 运行环境会对以 '/' 开头的环境变量做"路径转换"
 * (典型是 MSYS/Git-Bash 会把 /app/vmrp 变成 C:/.../PortableGit/.../app/vmrp),
 * 导致前缀完全对不上, 所有请求 404。
 * 这里只认 URL 里真正出现的那一段: 取末段 "app/<name>" 的形状重建。
 *
 * /app/vmrp                                  -> /app/vmrp
 * C:/xxx/PortableGit/versions/1.2.0/app/vmrp -> /app/vmrp   (修复被转换的值)
 * app/vmrp                                   -> /app/vmrp
 */
function normalizeGatewayPrefix(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    if (!s) return '';
    // 去掉 Windows 盘符与中间目录, 只保留形如 /app/<name> 的尾部
    const m = s.match(/(\/app\/[A-Za-z0-9_\-]+)\/?$/);
    if (m) return m[1];
    // 兜底: 无 /app 形状则按原值处理 (补上前导斜杠, 去尾斜杠)
    if (s.charAt(0) !== '/') s = '/' + s;
    return s.replace(/\/+$/, '');
}

const GATEWAY_PREFIX = normalizeGatewayPrefix(process.env.GATEWAY_PREFIX);

// 是否同时监听 TCP 端口 (网关模式下可关闭; 默认开启便于调试)
const ENABLE_TCP = process.env.VMRP_DISABLE_TCP !== '1';

// 监听失败原因 (供 /api/health 与日志排查)
let socketListenError = null;

// 静态资源根目录: 优先用 TRIM_APPDEST (已安装的 target 目录), 回退到脚本同级/www
const APP_DEST = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const WWW_ROOT = fs.existsSync(path.join(APP_DEST, 'www'))
    ? path.join(APP_DEST, 'www')
    : path.resolve(__dirname, '../www');

/* ------------------------------------------------------------------
 * 飞牛开放 API (后端) 客户端
 *
 * 与 JS SDK 完全不同的一套东西:
 *   - 只能由应用服务端调用, 不能在前端浏览器里调 (token 不能暴露)
 *   - 走 Unix Socket: /var/run/trim_open_gateway_apiscope.socket
 *   - HTTP: POST /api/v1/trimapp
 *   - 鉴权: Authorization: Bearer ${TRIM_API_TOKEN}
 *     token 由系统在启动 cmd/main 时注入, **每次都要从环境变量现读**,
 *     不要缓存/持久化 (重装或环境变化后会更新)
 *   - 请求体: { reqId, req, appName, data }
 * ------------------------------------------------------------------ */

const OPEN_API_PATH = '/api/v1/trimapp';
const APP_NAME = process.env.TRIM_APPNAME || 'vmrp';

/**
 * 开放 API 的 socket 路径在不同系统版本上不一致:
 *   - 官方「调用方式」文档写 /var/run/trim_open_gateway_apiscope.socket
 *   - 部分版本 / 早期文档写 /var/run/trim_open_gateway.socket
 * 这里按优先级依次探测, 取第一个真实存在的。
 */
const OPEN_API_SOCKETS = [
    '/var/run/trim_open_gateway_apiscope.socket',
    '/var/run/trim_open_gateway.socket',
    '/run/trim_open_gateway_apiscope.socket',
    '/run/trim_open_gateway.socket'
];

function pickOpenApiSocket() {
    for (let i = 0; i < OPEN_API_SOCKETS.length; i++) {
        try { if (fs.existsSync(OPEN_API_SOCKETS[i])) return OPEN_API_SOCKETS[i]; } catch (e) { /* 忽略 */ }
    }
    return '';
}

/**
 * 调用一个后端开放 API。
 * @param {string} reqName 形如 trim.file.getUserAccessibleFolders
 * @param {object} data    接口参数
 * @returns {Promise<{ok:boolean, code:number, msg:string, data:any, raw?:string}>}
 */
function callOpenApi(reqName, data) {
    return new Promise(function (resolve) {
        const token = process.env.TRIM_API_TOKEN || '';
        if (!token) {
            log('开放API ' + reqName + ': 缺少 TRIM_API_TOKEN, 无法调用');
            return resolve({ ok: false, code: -1, msg: '缺少 TRIM_API_TOKEN', data: null });
        }
        const sock = pickOpenApiSocket();
        if (!sock) {
            log('开放API ' + reqName + ': 未找到可用 socket, 已探测: ' + OPEN_API_SOCKETS.join(', '));
            return resolve({ ok: false, code: -1, msg: '开放API socket 不可用', data: null });
        }
        const payload = JSON.stringify({
            reqId: String(Date.now()),
            req: reqName,
            appName: APP_NAME,
            data: data || {}
        });
        const req = http.request({
            socketPath: sock,
            path: OPEN_API_PATH,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'Authorization': 'Bearer ' + token
            }
        }, function (r) {
            const chunks = [];
            r.on('data', function (c) { chunks.push(c); });
            r.on('end', function () {
                const body = Buffer.concat(chunks).toString('utf8');
                let j = null;
                try { j = JSON.parse(body); } catch (e) { /* 非 JSON */ }
                if (!j) {
                    log('开放API ' + reqName + ' 返回非 JSON (HTTP ' + r.statusCode + '): ' + body.slice(0, 200));
                    return resolve({ ok: false, code: -1, msg: 'HTTP ' + r.statusCode, data: null, raw: body });
                }
                const ok = (r.statusCode === 200 || r.statusCode === 400) && j.code === 0;
                if (!ok) {
                    log('开放API ' + reqName + ' 失败: HTTP ' + r.statusCode +
                        ' code=' + j.code + ' msg=' + j.msg + ' (socket=' + sock + ')');
                }
                resolve({ ok: ok, code: j.code, msg: j.msg || '', data: j.data, raw: body, socket: sock });
            });
        });
        req.on('error', function (e) {
            log('开放API ' + reqName + ' 请求异常 (' + sock + '): ' + (e && e.message));
            resolve({ ok: false, code: -1, msg: (e && e.message) || '请求异常', data: null });
        });
        req.setTimeout(8000, function () {
            try { req.destroy(new Error('timeout')); } catch (e) { /* 忽略 */ }
        });
        req.write(payload);
        req.end();
    });
}

/**
 * 查询当前用户已授权给本应用的目录。
 * 走官方 trim.file.getUserAccessibleFolders, scope: trim.file.userAccess
 * @param {number|string} uid 统一网关注入的 X-Trim-Userid
 */
function getUserAccessibleFolders(uid) {
    return callOpenApi('trim.file.getUserAccessibleFolders', { uid: Number(uid) || 0 })
        .then(function (r) {
            if (!r.ok) return [];
            var paths = (r.data && r.data.paths) || [];
            return Array.isArray(paths) ? paths.filter(function (p) {
                return typeof p === 'string' && p;
            }) : [];
        });
}

/**
 * 查询管理员授权给本应用的共享目录。
 * 走官方 trim.file.getSharedAccessibleFolders, scope: trim.file.sharedAccess
 * 不需要 uid —— 共享授权是应用维度的, 由管理员设置。
 */
function getSharedAccessibleFolders() {
    return callOpenApi('trim.file.getSharedAccessibleFolders', {})
        .then(function (r) {
            if (!r.ok) return [];
            var paths = (r.data && r.data.paths) || [];
            return Array.isArray(paths) ? paths.filter(function (p) {
                return typeof p === 'string' && p;
            }) : [];
        });
}

/**
 * 构建指纹: 用于让客户端识别"服务端已升级, 我手里的页面是旧的"。
 * 取 www 目录下核心文件的 mtime+size 组合, 每次重新打包安装必然变化。
 */
const BUILD_ID = process.env.VMRP_BUILD_ID || '';
const WWW_STAMP = (function () {
    try {
        const names = ['index.html', 'fnos.js', 'fs.js', 'vmrp.js', 'vmrp.wasm'];
        let acc = '';
        for (const n of names) {
            const f = path.join(WWW_ROOT, n);
            try {
                const st = fs.statSync(f);
                acc += n + ':' + st.size.toString(16) + ':' + Math.floor(st.mtimeMs).toString(16) + ';';
            } catch (e) { acc += n + ':missing;'; }
        }
        // 简易 FNV-1a, 无需 crypto 依赖
        let h = 0x811c9dc5;
        for (let i = 0; i < acc.length; i++) {
            h ^= acc.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16);
    } catch (e) { return 'unknown'; }
})();

// 日志: 直接走 stdout/stderr。
// cmd/main 启动时已把输出重定向到 ${TRIM_PKGVAR}/info.log,
// 因此应用自己不再写文件日志 —— 避免在源码目录留下 server.log 被打进安装包。
function log(msg) {
    console.log('[' + new Date().toISOString() + '] ' + msg);
}

/* ---------------------------- MIME 类型表 ---------------------------- */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mrp': 'application/octet-stream',
    '.ext': 'application/octet-stream',
    '.uc2': 'application/octet-stream',
    '.mp3': 'audio/mpeg',
    '.mid': 'audio/midi',
    '.zip': 'application/zip',
    '.txt': 'text/plain; charset=utf-8'
};

function mimeOf(file) {
    return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/* ---------------------------- 工具函数 ---------------------------- */

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

// 读取请求体 (限制 512MB, 防止恶意超大请求)
function readBody(req, limit) {
    return new Promise(function (resolve, reject) {
        const chunks = [];
        let total = 0;
        req.on('data', function (c) {
            total += c.length;
            if (total > limit) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', function () { resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
    });
}

/**
 * 安全校验用户传入的绝对路径。
 * 只允许 /vol* 开头的路径 (飞牛的存储空间路径), 拒绝路径穿越。
 *
 * ⚠️ 这里**不做** percent 解码。原因:
 *   前端一律用 encodeURIComponent 传出, `url.parse(req.url, true)` 已经把
 *   query 解码过一层, 所以到这里拿到的已经是"真实路径"。
 *   若再解码一次, 文件名里本身就含 `%2F` 形态字符的文件 (如真的叫 `a%20b.mrp`)
 *   会被二次解码成 `a b.mrp`, 反而指向错误的文件。
 *
 * 兼容: 若某条链路漏了编码(直接传了 %20 形态), 首次解码探测一次即可命中,
 *   做法是先按原样判断, 失败再尝试解码一次 —— 而不是无条件解码。
 */
function sanitizeAbsPath(p) {
    if (!p || typeof p !== 'string') return null;

    function tryNorm(s) {
        s = String(s).trim();
        if (!s.startsWith('/')) return null;
        const norm = path.posix.normalize(s);
        if (norm.indexOf('..') !== -1) return null;
        if (!/^\/vol\d+\//.test(norm)) return null;
        return norm;
    }

    // 1) 优先按"已是真实路径"处理 (正常链路)
    const direct = tryNorm(p);
    if (direct) return direct;

    // 2) 兜底: 该值可能是未解码的百分号形态, 解一次再试
    let decoded = p;
    try { decoded = decodeURIComponent(p); } catch (e) { return null; }
    return tryNorm(decoded);
}

// 把绝对路径安全地映射到静态根目录下 (防目录穿越)
function safeJoin(root, rel) {
    const target = path.normalize(path.join(root, rel));
    if (!target.startsWith(root)) return null;
    return target;
}

/* ---------------------------- API 处理 ---------------------------- */

// GET /api/open-mrp?path=/vol1/xxx/yyy.mrp
// 读取飞牛文件系统上的 .mrp 文件, 返回二进制内容 (供前端 ?f= 机制直接运行)
async function handleOpenMrp(req, res, qs) {
    const abs = sanitizeAbsPath(qs.path);
    if (!abs) {
        return sendJson(res, 400, { code: 1, msg: '路径参数非法或不在允许范围内(/vol*)' });
    }
    if (!/\.mrp$/i.test(abs)) {
        return sendJson(res, 400, { code: 1, msg: '仅支持 .mrp 文件' });
    }
    fs.stat(abs, function (err, st) {
        if (err || !st.isFile()) {
            log('open-mrp 失败: ' + abs + ' -> ' + (err ? err.message : '不是文件'));
            return sendJson(res, 404, { code: 1, msg: '文件不存在或无法访问: ' + abs });
        }
        fs.readFile(abs, function (err2, buf) {
            if (err2) {
                log('open-mrp 读取失败: ' + abs + ' -> ' + err2.message);
                return sendJson(res, 500, { code: 1, msg: '读取失败: ' + err2.message });
            }
            log('open-mrp 成功: ' + abs + ' (' + buf.length + ' 字节)');
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': buf.length,
                'Cache-Control': 'no-store',
                'X-File-Name': encodeURIComponent(path.posix.basename(abs))
            });
            res.end(buf);
        });
    });
}

// POST /api/save-file
// body: { dir: "/vol1/xxx", name: "mythroad_2026-09-28.zip", data: "<base64>" }
//       dir 省略时, 需要 dir 由用户已授权目录提供
async function handleSaveFile(req, res) {
    let payload;
    try {
        const raw = await readBody(req, 512 * 1024 * 1024);
        payload = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        return sendJson(res, 400, { code: 1, msg: '请求体解析失败: ' + e.message });
    }

    const dir = sanitizeAbsPath(payload.dir);
    if (!dir) {
        return sendJson(res, 400, { code: 1, msg: '目标目录非法或不在允许范围内(/vol*)' });
    }
    // 文件名仅取 basename, 防止穿越
    const rawName = String(payload.name || '');
    const name = path.posix.basename(rawName);
    if (!name || name === '.' || name === '..') {
        return sendJson(res, 400, { code: 1, msg: '文件名非法' });
    }
    // 清理文件名中的危险字符
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');

    if (typeof payload.data !== 'string' || !payload.data) {
        return sendJson(res, 400, { code: 1, msg: '缺少文件数据' });
    }

    let buf;
    try {
        buf = Buffer.from(payload.data, 'base64');
    } catch (e) {
        return sendJson(res, 400, { code: 1, msg: '文件数据 base64 解码失败' });
    }

    const target = path.posix.join(dir, safeName);

    // 校验目标目录存在且是目录
    fs.stat(dir, function (err, st) {
        if (err || !st.isDirectory()) {
            return sendJson(res, 404, { code: 1, msg: '目标目录不存在: ' + dir });
        }
        // 若同名文件已存在, 自动加序号避免覆盖
        let finalPath = target;
        let counter = 1;
        const ext = path.posix.extname(safeName);
        const base = safeName.slice(0, safeName.length - ext.length);
        while (fs.existsSync(finalPath) && counter < 1000) {
            finalPath = path.posix.join(dir, base + '_' + counter + ext);
            counter++;
        }

        fs.writeFile(finalPath, buf, function (err2) {
            if (err2) {
                log('save-file 写入失败: ' + finalPath + ' -> ' + err2.message);
                return sendJson(res, 500, { code: 1, msg: '写入失败: ' + err2.message });
            }
            log('save-file 成功: ' + finalPath + ' (' + buf.length + ' 字节)');
            sendJson(res, 200, {
                code: 0,
                msg: '保存成功',
                data: { path: finalPath, size: buf.length }
            });
        });
    });
}

// POST /api/save-multi
// body: { dir, files: [{ name, data(base64) }] }  —— 一次保存多个文件
async function handleSaveMulti(req, res) {
    let payload;
    try {
        const raw = await readBody(req, 512 * 1024 * 1024);
        payload = JSON.parse(raw.toString('utf8'));
    } catch (e) {
        return sendJson(res, 400, { code: 1, msg: '请求体解析失败: ' + e.message });
    }

    const dir = sanitizeAbsPath(payload.dir);
    if (!dir) {
        return sendJson(res, 400, { code: 1, msg: '目标目录非法或不在允许范围内(/vol*)' });
    }
    if (!Array.isArray(payload.files) || payload.files.length === 0) {
        return sendJson(res, 400, { code: 1, msg: '缺少文件列表' });
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return sendJson(res, 404, { code: 1, msg: '目标目录不存在: ' + dir });
    }

    const saved = [];
    const failed = [];
    for (let i = 0; i < payload.files.length; i++) {
        const f = payload.files[i];
        try {
            // 支持子路径 (打包时保留目录结构), 但必须防穿越
            let rel = String(f.name || '').replace(/\\/g, '/');
            rel = path.posix.normalize(rel).replace(/^\/+/, '');
            if (!rel || rel.indexOf('..') !== -1) { failed.push(f.name); continue; }
            const target = path.posix.join(dir, rel);
            if (!target.startsWith(dir)) { failed.push(f.name); continue; }

            fs.mkdirSync(path.posix.dirname(target), { recursive: true });
            const buf = Buffer.from(String(f.data || ''), 'base64');
            fs.writeFileSync(target, buf);
            saved.push({ name: rel, path: target, size: buf.length });
        } catch (e) {
            failed.push(f.name);
        }
    }

    log('save-multi: 成功 ' + saved.length + ' 个, 失败 ' + failed.length + ' 个 -> ' + dir);
    sendJson(res, 200, {
        code: failed.length > 0 && saved.length === 0 ? 1 : 0,
        msg: '已保存 ' + saved.length + ' 个文件' + (failed.length ? ', 失败 ' + failed.length + ' 个' : ''),
        data: { saved: saved, failed: failed, dir: dir }
    });
}

// GET /api/list-dir?path=/vol1/xxx  —— 列出目录 (调试/校验用)
function handleListDir(req, res, qs) {
    const abs = sanitizeAbsPath(qs.path);
    if (!abs) return sendJson(res, 400, { code: 1, msg: '路径非法' });
    fs.readdir(abs, { withFileTypes: true }, function (err, list) {
        if (err) return sendJson(res, 404, { code: 1, msg: '读取目录失败: ' + err.message });
        const items = list.map(function (d) {
            let size = 0;
            try { size = fs.statSync(path.posix.join(abs, d.name)).size; } catch (e) { }
            return { name: d.name, dir: d.isDirectory(), size: size };
        });
        sendJson(res, 200, { code: 0, msg: '', data: { path: abs, items: items } });
    });
}

/* ---------------------------- 静态资源服务 ---------------------------- */

/**
 * GET /api/user-folders
 * 返回当前用户已授权给本应用的目录 (给前端"目录选择兜底"用)。
 * 需要统一网关注入 X-Trim-Userid 才能定位用户。
 */
function handleUserFolders(req, res, gwUser) {
    if (!gwUser || !gwUser.uid) {
        return sendJson(res, 200, {
            code: 1, msg: '缺少用户身份 (需经统一网关访问)',
            data: { paths: [], reason: 'no-uid' }
        });
    }
    getUserAccessibleFolders(gwUser.uid).then(function (paths) {
        sendJson(res, 200, { code: 0, msg: '', data: { paths: paths, uid: gwUser.uid } });
    }).catch(function (e) {
        sendJson(res, 200, {
            code: 1, msg: (e && e.message) || '查询失败',
            data: { paths: [], reason: 'error' }
        });
    });
}

/**
 * GET /api/openapi-probe
 * 诊断用: 报告开放 API 的可用性 (token / socket / scope) 与一次真实调用结果。
 */
function handleOpenApiProbe(req, res, gwUser) {
    const token = process.env.TRIM_API_TOKEN || '';
    const probe = {
        hasToken: !!token,
        tokenLen: token.length,
        candidates: OPEN_API_SOCKETS,
        socketPath: pickOpenApiSocket() || null,
        appName: APP_NAME,
        uid: (gwUser && gwUser.uid) || null
    };
    probe.socketExists = !!probe.socketPath;

    if (!gwUser || !gwUser.uid) {
        probe.note = '未经统一网关访问, 无 uid, 跳过实际调用';
        return sendJson(res, 200, { code: 0, msg: '', data: probe });
    }
    callOpenApi('trim.file.getUserAccessibleFolders', { uid: Number(gwUser.uid) || 0 })
        .then(function (r) {
            probe.call = { ok: r.ok, code: r.code, msg: r.msg, data: r.data };
            sendJson(res, 200, { code: 0, msg: '', data: probe });
        });
}

/**
 * GET /api/shared-folders
 * 返回管理员授权给本应用的共享目录 (scope: trim.file.sharedAccess)。
 * 不依赖 uid —— 共享授权是应用维度的。
 */
function handleSharedFolders(req, res) {
    getSharedAccessibleFolders().then(function (paths) {
        sendJson(res, 200, { code: 0, msg: '', data: { paths: paths } });
    }).catch(function (e) {
        sendJson(res, 200, {
            code: 1, msg: (e && e.message) || '查询失败',
            data: { paths: [], reason: 'error' }
        });
    });
}

/**
 * GET /api/auth-probe
 * 一次性把"授权相关"的所有后端信息打包返回, 便于定位 1003103。
 */
function handleAuthProbe(req, res, gwUser) {
    const out = {
        uid: (gwUser && gwUser.uid) || null,
        user: (gwUser && gwUser.username) || null,
        isAdmin: (gwUser && gwUser.isAdmin) || false,
        hasToken: !!process.env.TRIM_API_TOKEN,
        socketPath: pickOpenApiSocket() || null
    };
    const jobs = [
        getUserAccessibleFolders((gwUser && gwUser.uid) || 0).then(function (p) {
            out.userFolders = p;
        }).catch(function () { out.userFolders = null; }),
        getSharedAccessibleFolders().then(function (p) {
            out.sharedFolders = p;
        }).catch(function () { out.sharedFolders = null; })
    ];
    Promise.all(jobs).then(function () {
        sendJson(res, 200, { code: 0, msg: '', data: out });
    });
}

function serveStatic(req, res, pathname) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch (e) {
        rel = pathname;
    }
    if (rel === '/' || rel === '') rel = '/index.html';

    const target = safeJoin(WWW_ROOT, rel.replace(/^\/+/, ''));
    if (!target) {
        res.writeHead(403); return res.end('Forbidden');
    }

    fs.stat(target, function (err, st) {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 Not Found: ' + rel);
        }
        const headers = {
            'Content-Type': mimeOf(target),
            'Content-Length': st.size,
            // no-cache 只表示"可缓存但需回源校验"; 移动端 WebView 常忽略校验直接复用缓存,
            // 导致升级 fpk 后页面里仍是旧的 fnos.js / index.html。
            // 微应用体积小、走本机 socket, 直接用 no-store 彻底禁缓存, 保证每次升级即时生效。
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0'
        };
        // 版本指纹: 让 ETag 随文件内容变化, 配合客户端强刷
        try {
            headers['ETag'] = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"';
        } catch (e) { /* 忽略 */ }

        // HTML: 注入 www 指纹, 供页面自检"我是不是缓存的旧版"
        const isHtml = /^text\/html/.test(headers['Content-Type']);
        if (isHtml) {
            let html;
            try {
                html = fs.readFileSync(target, 'utf8');
            } catch (e) {
                res.writeHead(500); return res.end('read error');
            }
            const inject = '<script>window.__VMRP_WWW_STAMP=' +
                JSON.stringify(WWW_STAMP) + ';</script>';
            if (html.indexOf('</head>') >= 0) {
                html = html.replace('</head>', inject + '\n</head>');
            } else {
                html = inject + html;
            }
            const buf = Buffer.from(html, 'utf8');
            headers['Content-Length'] = buf.length;
            res.writeHead(200, headers);
            return res.end(buf);
        }

        res.writeHead(200, headers);
        // 立即把响应头刷出去。
        // 网关 (nginx) 在 socket 转发下有读取超时, 若头一直缓冲在 Node 侧,
        // wasm (约 2MB) 这类大文件容易出现长时间无响应乃至 502。
        if (typeof res.flushHeaders === 'function') {
            try { res.flushHeaders(); } catch (e) { /* 忽略 */ }
        }
        const stream = fs.createReadStream(target);
        stream.on('error', function () {
            try { res.destroy(); } catch (e) { /* 忽略 */ }
        });
        stream.pipe(res);
    });
}

/* ---------------------------- 主服务 ---------------------------- */

/**
 * 剥离统一网关前缀。
 * 网关把 /app/vmrp/xxx 转发给本服务时, req.url 仍是带前缀的完整路径,
 * 需要在路由前去掉, 否则所有静态资源都会 404。
 */
function stripGatewayPrefix(pathname) {
    if (!GATEWAY_PREFIX) return pathname;
    // 精确命中前缀本身 (无尾斜杠) -> 视为访问根路径
    if (pathname === GATEWAY_PREFIX) return '/';
    // 带尾斜杠的变体 (/app/vmrp/) 同样归一化到根路径
    if (pathname === GATEWAY_PREFIX + '/') return '/';
    if (pathname.indexOf(GATEWAY_PREFIX + '/') === 0) {
        return pathname.slice(GATEWAY_PREFIX.length);
    }
    return pathname;
}

/**
 * 判断原始请求是否访问了"无尾斜杠的应用根路径"。
 * 这种请求必须 302 到带尾斜杠的形式, 否则页面里的相对路径
 * (./vmrp.js 等) 会被解析到应用前缀之外, 造成资源 404。
 */
function needsTrailingSlashRedirect(rawPathname) {
    if (!GATEWAY_PREFIX) return false;
    return rawPathname === GATEWAY_PREFIX;
}

const server = http.createServer(function (req, res) {
    const parsed = url.parse(req.url, true);
    const rawPathname = parsed.pathname || '/';
    const pathname = stripGatewayPrefix(rawPathname);
    const qs = parsed.query || {};

    // 无尾斜杠的应用根路径 -> 302 到带尾斜杠形式。
    // 页面内使用相对路径 (./vmrp.js 等), 若地址停在 /app/vmrp,
    // 浏览器会把相对路径解析成 /app/vmrp.js, 跳出前缀导致全部 404。
    if (needsTrailingSlashRedirect(rawPathname)) {
        const q = req.url.indexOf('?');
        const suffix = q >= 0 ? req.url.slice(q) : '';
        res.writeHead(302, {
            'Location': GATEWAY_PREFIX + '/' + suffix,
            'Cache-Control': 'no-store'
        });
        return res.end();
    }

    // 网关会在转发时带上可信用户信息 Header (仅网关模式有效)
    const gwUser = {
        uid: req.headers['x-trim-userid'] || '',
        isAdmin: req.headers['x-trim-isadmin'] === 'true',
        username: req.headers['x-trim-username'] || ''
    };
    req.gwUser = gwUser;

    // API 路由
    if (pathname === '/api/health') {
        return sendJson(res, 200, {
            code: 0, msg: 'ok',
            data: {
                app: 'vmrp',
                dest: APP_DEST,
                www: WWW_ROOT,
                uptime: process.uptime(),
                socket: SOCKET_PATH || null,
                socketError: socketListenError,
                gatewayPrefix: GATEWAY_PREFIX || null,
                build: BUILD_ID,
                wwwStamp: WWW_STAMP,
                user: gwUser.uid ? gwUser : null
            }
        });
    }
    if (pathname === '/api/open-mrp' && req.method === 'GET') {
        return handleOpenMrp(req, res, qs);
    }
    if (pathname === '/api/save-file' && req.method === 'POST') {
        return handleSaveFile(req, res);
    }
    if (pathname === '/api/save-multi' && req.method === 'POST') {
        return handleSaveMulti(req, res);
    }
    if (pathname === '/api/list-dir' && req.method === 'GET') {
        return handleListDir(req, res, qs);
    }
    // 当前用户已授权给本应用的目录列表 (调官方后端 API, 供目录选择兜底)
    if (pathname === '/api/user-folders' && req.method === 'GET') {
        return handleUserFolders(req, res, gwUser);
    }
    // 诊断: 直接透出一次开放 API 调用结果, 便于排查 token/socket/scope
    if (pathname === '/api/openapi-probe' && req.method === 'GET') {
        return handleOpenApiProbe(req, res, gwUser);
    }
    // 管理员共享授权目录 (scope: trim.file.sharedAccess)
    if (pathname === '/api/shared-folders' && req.method === 'GET') {
        return handleSharedFolders(req, res);
    }
    // 授权综合诊断: 用户已授权目录 + 共享目录 + 身份信息
    if (pathname === '/api/auth-probe' && req.method === 'GET') {
        return handleAuthProbe(req, res, gwUser);
    }

    if (pathname.indexOf('/api/') === 0) {
        return sendJson(res, 404, { code: 1, msg: '未知接口: ' + pathname });
    }

    // 静态资源
    return serveStatic(req, res, pathname);
});

/* ---------- 监听: 统一网关 Unix Socket (可选) + TCP 端口 (可选) ---------- */

let listeningCount = 0;
const expectedListeners = (SOCKET_PATH ? 1 : 0) + (ENABLE_TCP ? 1 : 0);

function onListening(desc) {
    listeningCount++;
    log('已监听 ' + desc + ' (' + listeningCount + '/' + expectedListeners + ')');
    if (listeningCount >= expectedListeners) {
        log('VMRP 飞牛应用已就绪  www=' + WWW_ROOT +
            (GATEWAY_PREFIX ? '  gateway=' + GATEWAY_PREFIX : ''));
    }
}

server.on('error', function (e) {
    const code = (e && e.code) || '';
    // socket 监听失败不应立刻杀死进程:
    //   1) TCP 可能仍在监听 (本地调试场景), 进程应继续服务;
    //   2) 立即退出会让飞牛看到"应用异常退出"却看不到原因。
    // 这里只记录失败原因, 是否退出交给下面的"就绪自检"统一决定。
    if (code === 'EACCES' || code === 'EADDRINUSE' || code === 'ENOENT') {
        socketListenError = code + ' ' + (e && e.message);
        log('网关 socket 监听失败: ' + socketListenError);
        if (code === 'EACCES') {
            log('原因: 无权在 ' + path.dirname(SOCKET_PATH || '') +
                ' 创建 socket。该目录需对应用运行用户可写 (config/privilege run-as=package)。');
        }
        if (code === 'EADDRINUSE') {
            log('原因: socket 已被占用, 可能是旧进程未退出。');
        }
        return;   // 不退出, 由就绪自检决定
    }
    log('服务异常: ' + code + ' ' + (e && e.message));
    process.exit(1);
});

if (SOCKET_PATH) {
    // 确保 socket 所在目录存在且可写。
    // 飞牛网关只会转发到已存在的 socket, 这里失败会直接导致 502。
    const sockDir = path.dirname(SOCKET_PATH);
    try {
        if (!fs.existsSync(sockDir)) {
            fs.mkdirSync(sockDir, { recursive: true });
            log('已创建 socket 目录: ' + sockDir);
        }
        fs.accessSync(sockDir, fs.constants.W_OK);
    } catch (e) {
        log('警告: socket 目录不可写 (' + sockDir + '): ' + (e && e.message));
    }

    // 清掉上次异常退出残留的 socket 文件, 否则 listen 会 EADDRINUSE
    try {
        if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    } catch (e) {
        log('清理残留 socket 失败(忽略): ' + (e && e.message));
    }
    server.listen(SOCKET_PATH, function () {
        // 放宽 socket 权限, 保证网关进程可以连接。
        // 网关可能以不同用户身份访问该 socket (官方 code-server 实践为 0777)。
        try {
            fs.chmodSync(SOCKET_PATH, 0o777);
        } catch (e) {
            log('设置 socket 权限失败(忽略): ' + (e && e.message));
        }
        onListening('unix:' + SOCKET_PATH);
    });
}

if (ENABLE_TCP) {
    server.listen(PORT, HOST, function () {
        onListening('tcp:' + HOST + ':' + PORT);
    });
}

if (expectedListeners === 0) {
    log('未配置任何监听方式 (SOCKET_PATH / ENABLE_TCP), 服务退出');
    process.exit(1);
}

// 环境变量一致性自检:
// cmd/main 会同时注入 SOCKET_PATH 与 GATEWAY_PREFIX。若只有前缀没有 socket,
// 说明环境变量传递异常, 此时服务会退化成纯 TCP —— 网关永远找不到它 (502)。
// 仅在真实的飞牛运行环境 (TRIM_APPDEST 存在) 下启用, 避免影响本地调试。
if (GATEWAY_PREFIX && !SOCKET_PATH && process.env.TRIM_APPDEST) {
    log('致命错误: 检测到 GATEWAY_PREFIX=' + GATEWAY_PREFIX +
        ' 但 SOCKET_PATH 为空, 环境变量未正确传递, 服务退出');
    process.exit(1);
}

// 就绪自检 (延迟 2 秒, 等所有 listen 回调/错误都触发完):
//   - socket 存在            -> 正常
//   - socket 缺失但有 TCP    -> 网关模式下不可用, 明确退出 (避免静默 502)
//   - socket 缺失且无 TCP    -> 彻底失败, 退出
// 生产环境由 cmd/main 传 VMRP_DISABLE_TCP=1, 因此只有 socket 一条路,
// 缺失即退出, cmd/main 的等待循环会立刻捕获并输出可读错误。
if (SOCKET_PATH) {
    setTimeout(function () {
        if (fs.existsSync(SOCKET_PATH)) return;
        log('致命错误: 网关 socket 未创建成功 (' + SOCKET_PATH + ')' +
            (socketListenError ? ' 原因: ' + socketListenError : ''));
        if (socketListenError && /EACCES/.test(socketListenError)) {
            log('提示: 检查 ' + path.dirname(SOCKET_PATH) +
                ' 是否对应用运行用户可写 (config/privilege run-as=package)。');
        }
        process.exit(1);
    }, 2000);
}

// 优雅退出
function shutdown(sig) {
    log('收到 ' + sig + ', 正在关闭...');
    server.close(function () {
        if (SOCKET_PATH) {
            try { fs.unlinkSync(SOCKET_PATH); } catch (e) { /* 忽略 */ }
        }
        process.exit(0);
    });
    setTimeout(function () {
        if (SOCKET_PATH) {
            try { fs.unlinkSync(SOCKET_PATH); } catch (e) { /* 忽略 */ }
        }
        process.exit(0);
    }, 3000);
}
process.on('SIGTERM', function () { shutdown('SIGTERM'); });
process.on('SIGINT', function () { shutdown('SIGINT'); });

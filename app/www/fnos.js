/* ============================================================================
 * VMRP 飞牛 fnOS 集成模块 (fnos.js)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 VMRP contributors
 *
 * 本文件是 vmrp (https://github.com/vmrp/vmrp) 飞牛 fnOS 移植版的一部分,
 * 依据 GNU General Public License v3.0 或更新版本发布。
 *
 * 职责:
 *   1. 检测是否运行在飞牛微应用环境
 *   2. 导入文件: 用飞牛文件选择器 (pickUserFile) 选择 .mrp / 其他文件 -> 写入模拟器 FS
 *   3. 文件关联: 解析 ?path= 参数 (飞牛文件管理器"打开方式") -> 后端读取 -> 直接运行
 *   4. 保存到飞牛: 把模拟器内文件 / 打包 ZIP 保存到飞牛用户选定的目录
 *
 * 依赖: 飞牛 Web 宿主注入的 window.trimApp (或 window.TrimApp) 实例。
 *       若不在飞牛环境, 所有能力自动降级为原生 <input type=file> / 浏览器下载。
 * ========================================================================== */

(function () {
    'use strict';

    // 是否运行在飞牛宿主环境 (已连上宿主 bridge)
    var inFnOS = false;
    // SDK 是否已加载 (仅代表脚本可用, 不代表已连上宿主)
    var sdkLoaded = false;
    var sdk = null;
    // 移动端 flutter bridge 是否已就绪 (SDK 内部也监听同一事件)
    var flutterPlatformReady = false;

    try {
        if (window.flutter_inappwebview && window.flutter_inappwebview._platformReady) {
            flutterPlatformReady = true;
        }
        window.addEventListener('flutterInAppWebViewPlatformReady', function () {
            flutterPlatformReady = true;
            // 平台就绪后再复核一次宿主判定 (移动端可能此时才确定)
            var now = computeInFnOS();
            if (now !== inFnOS) {
                inFnOS = now;
                console.log('[vmrp-fnos] flutter 就绪后宿主判定: inFnOS=' + inFnOS);
            }
            dispatchReadyEvent();
        });
    } catch (e) { /* 忽略 */ }

    /* ------------------------------------------------------------------
     * SDK 初始化
     *
     * 飞牛 SDK (@trimjs/web-app) 不会向全局注入实例, 必须自己 new TrimApp()。
     *
     * 宿主环境有两种, 判定方式不同:
     *
     * A) Web 宿主 (PC 桌面 / 浏览器里的飞牛窗口)
     *    SDK 把页面放进 iframe, 通过 postMessage 握手。
     *      isWeb = true
     *      isStandaloneWeb = (window.parent === window)
     *        -> false = 被 iframe 内嵌, bridge 可用
     *        -> true  = 独立顶层页面, 无宿主
     *    判定: isWeb && !isStandaloneWeb
     *
     * B) 移动端 App (飞牛手机 App 内嵌页面)
     *    SDK 通过 flutter_inappwebview 的 JS bridge 通信, **没有 iframe**。
     *      isWeb = false
     *      window.flutter_inappwebview 存在 (或稍后触发 flutterInAppWebViewPlatformReady)
     *    判定: !isWeb && (flutter_inappwebview 可用)
     *    ⚠️ 只判断 iframe 会把移动端误判为"非宿主", 导致所有能力静默降级。
     * ------------------------------------------------------------------ */

    // 当前页面是否处于 iframe 内 (跨域访问 window.top 抛错 = 确实在 iframe 里)
    function inIframeNow() {
        try { return window.self !== window.top; } catch (e) { return true; }
    }

    // 是否运行在飞牛移动端 App 的 WebView 中
    function isMobileWebView() {
        try {
            if (window.flutter_inappwebview) return true;
        } catch (e) { /* 忽略 */ }
        if (flutterPlatformReady) return true;
        // UA 兜底: 飞牛 App 会给 UA 加标记
        try {
            return /FNAppType\/|FNOS\//.test(navigator.userAgent || '');
        } catch (e) { return false; }
    }

    // 综合判定当前是否真的运行在飞牛宿主内 (Web 宿主 或 移动端 App 均算)
    function computeInFnOS() {
        if (!sdkLoaded || !sdk) return false;
        // 移动端 App: 无 iframe, 靠 flutter bridge
        if (sdk.isWeb === false) return isMobileWebView();
        // Web 宿主: 明确报告自己是独立网页 -> 不是宿主环境
        if (sdk.isStandaloneWeb === true) return false;
        return inIframeNow();
    }

    function detectSDK() {
        // 1) 拿到构造函数: 本地 vendor 包 (CJS) 或宿主可能注入的全局
        var Ctor = (window.TrimApp || window.TrimAppSdk);
        if (!Ctor && window.trimjs) {
            Ctor = window.trimjs.TrimApp || window.trimjs.webApp || window.trimjs.default;
        }
        if (typeof Ctor !== 'function') {
            console.warn('[vmrp-fnos] 未找到 TrimApp 构造函数 (vendor/trimjs-web-app.js 是否加载?)');
            return false;
        }

        // 2) 实例化。init() 内部会异步探测宿主, 这里同步拿到实例即可。
        try {
            sdk = new Ctor();
            sdkLoaded = true;
        } catch (e) {
            console.warn('[vmrp-fnos] TrimApp 实例化失败: ' + (e && e.message));
            return false;
        }

        // 3) 同步粗判
        inFnOS = computeInFnOS();

        // 4) 等 SDK 握手完成后再精确判定一次, 并广播事件供 UI 刷新
        //    (此时 isStandaloneWeb / 宿主 bridge 状态才是最终值)
        try {
            sdk.ready().then(function () {
                var now = computeInFnOS();
                if (now !== inFnOS) {
                    inFnOS = now;
                    console.log('[vmrp-fnos] 宿主判定已更新(ready 后): inFnOS=' + inFnOS);
                } else {
                    console.log('[vmrp-fnos] 宿主判定(ready 后): inFnOS=' + inFnOS);
                }
                dispatchReadyEvent();
            }, function (e) {
                console.warn('[vmrp-fnos] SDK ready 失败: ' + (e && e.message));
                dispatchReadyEvent();
            });
        } catch (e) { /* 忽略 */ }

        return inFnOS;
    }

    // 通知页面: fnos 模块初始化完成, 宿主判定结果已确定
    function dispatchReadyEvent() {
        try {
            window.dispatchEvent(new CustomEvent('vmrpfnosready', {
                detail: { inFnOS: inFnOS, sdkLoaded: sdkLoaded }
            }));
        } catch (e) { /* 老浏览器不支持 CustomEvent, 忽略 */ }
    }

    // 对宿主 bridge 的 Promise 调用做统一包装, 便于定位失败原因
    function callSDK(method, args) {
        if (!sdk || typeof sdk[method] !== 'function') {
            return Promise.reject(new Error('SDK 方法不可用: ' + method));
        }
        try {
            return Promise.resolve(sdk[method].apply(sdk, args || []));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /* ------------------------------------------------------------------
     * bridge 原始报文探针 (真机排查关键)
     *
     * SDK 的移动端调用链是:
     *   sdk.pickUserFile(params)
     *     -> callAppMethod("pickUserFile", JSON.stringify(params))
     *        -> callHandler("pickUserFile", json)
     *           -> flutter_inappwebview.callHandler(...) 返回字符串 s
     *           -> JSON.parse(s)             // 第一层
     *           -> JSON.parse(parsed.result) // 第二层, 只取 .result
     *           -> 解析失败 = 返回 null (静默!)
     *
     * 任何形状不符都会静默变成 null, 上层无法区分
     * "用户取消" 与 "协议不匹配" —— 这正是"选了目录点确定却提示已取消保存"的疑点。
     *
     * 这里包一层 callHandler, 把原始字符串完整留存下来, 供 report() 输出。
     * ------------------------------------------------------------------ */

    var bridgeLog = [];          // 最近若干次 bridge 调用记录
    var BRIDGE_LOG_MAX = 12;

    function recordBridge(method, raw, parsed, err) {
        var rec = {
            at: new Date().toISOString(),
            method: method,
            rawType: typeof raw,
            raw: (typeof raw === 'string') ? raw.slice(0, 500) : String(raw),
            parsedOk: !err,
            parsed: null,
            err: err ? String((err && err.message) || err) : null
        };
        try {
            if (!err) rec.parsed = JSON.parse(JSON.stringify(parsed));
        } catch (e) { rec.parsed = '(无法序列化)'; }
        bridgeLog.push(rec);
        if (bridgeLog.length > BRIDGE_LOG_MAX) bridgeLog.shift();
        try {
            console.log('[vmrp-fnos] bridge<' + method + '> raw=' + rec.raw +
                (err ? (' | 解析失败: ' + rec.err) : (' | parsed=' + JSON.stringify(rec.parsed))));
        } catch (e) { /* 忽略 */ }
    }

    /**
     * 给 flutter bridge 挂一层 callHandler 探针。
     * 幂等: 重复调用只包一次。
     */
    function instrumentBridge() {
        try {
            var fb = window.flutter_inappwebview;
            if (!fb || typeof fb.callHandler !== 'function') return false;
            if (fb.__vmrpProbed) return true;
            var orig = fb.callHandler;
            fb.callHandler = function (name) {
                var args = Array.prototype.slice.call(arguments, 1);
                var ret;
                try {
                    ret = orig.apply(this, arguments);
                } catch (e) {
                    recordBridge(name, null, null, e);
                    throw e;
                }
                // callHandler 返回 Promise<string>
                if (ret && typeof ret.then === 'function') {
                    return ret.then(function (raw) {
                        var parsed = null, err = null;
                        try {
                            var one = (typeof raw === 'string') ? JSON.parse(raw) : raw;
                            parsed = one;
                            // 第二层: SDK 会再取 .result 解析
                            if (one && typeof one.result === 'string') {
                                try { parsed = JSON.parse(one.result); } catch (e2) { err = e2; }
                            }
                        } catch (e1) { err = e1; }
                        recordBridge(name, raw, parsed, err);
                        return raw;
                    }, function (e) {
                        recordBridge(name, null, null, e);
                        throw e;
                    });
                }
                recordBridge(name, ret, null, null);
                return ret;
            };
            fb.__vmrpProbed = true;
            console.log('[vmrp-fnos] 已挂载 bridge 探针');
            return true;
        } catch (e) {
            console.warn('[vmrp-fnos] 挂载 bridge 探针失败: ' + (e && e.message));
            return false;
        }
    }

    /* ------------------------------------------------------------------
     * 工具函数
     * ------------------------------------------------------------------ */

    // Uint8Array -> base64 (分块避免栈溢出)
    function u8ToBase64(u8) {
        var bin = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < u8.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    function toast(msg, dur) {
        if (typeof window.showToast === 'function') window.showToast(msg, dur || 3000);
        else console.log('[vmrp-fnos] ' + msg);
    }

    /* ------------------------------------------------------------------
     * 基础路径 (统一网关前缀)
     *
     * 走统一网关时页面的真实 URL 是 /app/vmrp/... , 因此所有后端接口
     * 不能用绝对路径 '/api/xxx' (会被网关当成 /api/xxx 而不是 /app/vmrp/api/xxx),
     * 必须基于当前页面路径动态推导前缀。
     * 例: 页面 /app/vmrp/  ->  apiBase = '/app/vmrp'  ->  '/app/vmrp/api/open-mrp'
     *     页面 /            ->  apiBase = ''          ->  '/api/open-mrp'
     * ------------------------------------------------------------------ */

    var _apiBase = null;

    function apiBase() {
        if (_apiBase !== null) return _apiBase;
        try {
            var p = window.location.pathname || '/';
            // 去掉末尾的 index.html / 文件名, 只保留目录
            if (/\/[^\/]*\.[^\/]*$/.test(p)) p = p.replace(/\/[^\/]*$/, '/');
            // 目录形式: /app/vmrp/ 或 /
            // 页面的 API 前缀 = 页面所在目录 (去掉末尾斜杠)
            var base = p.replace(/\/+$/, '');
            _apiBase = base;
        } catch (e) {
            _apiBase = '';
        }
        return _apiBase;
    }

    // 把 '/api/xxx' 转成带网关前缀的完整路径
    function apiUrl(p) {
        if (!p) return apiBase();
        if (/^https?:\/\//i.test(p)) return p;          // 已是绝对 URL
        if (p.charAt(0) !== '/') p = '/' + p;
        return apiBase() + p;
    }

    // 从绝对路径取文件名
    function baseName(p) {
        if (!p) return '';
        var s = String(p).replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
    }

    // 根据文件名推断模拟器内的目标子目录 (与原生导入逻辑保持一致)
    function targetDirOf(name) {
        if (name && name.indexOf('.') !== -1) {
            var ext = name.substring(name.lastIndexOf('.')).toLowerCase();
            if (ext.indexOf('nes') !== -1) return 'nes/';
        }
        return '';
    }

    // 等待模拟器 FS 就绪
    function whenFSReady(cb, timeoutMs) {
        var start = Date.now();
        (function poll() {
            if (typeof FS !== 'undefined' && FS && typeof FS.writeFile === 'function') {
                cb();
                return;
            }
            if (timeoutMs && Date.now() - start > timeoutMs) {
                toast('模拟器尚未加载完成，请稍后再试');
                return;
            }
            setTimeout(poll, 300);
        })();
    }

    /* ==================================================================
     * 1. 导入文件 —— 飞牛文件选择器
     * ================================================================== */

    /**
     * 用飞牛文件选择器选择文件并导入模拟器。
     * 文件授权后通过 /api/open-mrp 由后端读取 (页面无法直接读 NAS 磁盘)。
     * @param {Object} opts { accept: ['.mrp'], directory: false }
     */
    function fnImportFile(opts) {
        opts = opts || {};
        if (!inFnOS || !sdk) {
            return false;   // 交回原生 <input type=file>
        }

        var params = {
            directory: false,
            multiple: true,
            title: opts.title || '选择要导入的文件',
            okText: '导入',
            sidebarGroup: ['myFiles', 'otherShare', 'external', 'remote', 'favorites']
        };
        if (opts.accept) params.accept = opts.accept;

        // 必须先等 bridge 初始化完成, 否则 isWeb 分支的 getWebMethods() 会报错
        sdk.ready().then(function () {
            return sdk.pickUserFile(params);
        }).then(function (result) {
            // 双平台均返回 {code,msg,data}, 统一归一化 (裸数组为防御性兼容)
            var paths = normalizePickResultList(result, '选择文件失败');
            if (!paths.length) {
                // 文件选择失败也区分取消/鉴权, 并尝试兜底通道
                if (lastPickError && !isUserCancel()) {
                    console.warn('[vmrp-fnos] 文件选择被拒绝: code=' + lastPickError.code +
                        ' msg=' + lastPickError.msg);
                    adviseAuthFailure();
                }
                return;
            }
            importPaths(paths, { destDir: opts.destDir, onDone: opts.onDone });
        }).catch(function (e) {
            console.warn('[vmrp-fnos] pickUserFile 异常: ' + (e && e.message));
            toast('调用飞牛文件选择器失败: ' + ((e && e.message) || ''));
        });
        return true;
    }

    /**
     * 通过后端把飞牛上的若干绝对路径文件读进模拟器 FS。
     * @param {string[]} paths
     * @param {Object}   [opts]
     *   destDir   {string}  目标目录 (默认按文件类型自动归入 /mythroad/ 或 /mythroad/nes/)
     *   onDone    {Function}(okCount, total) 完成回调
     */
    function importPaths(paths, opts) {
        opts = opts || {};
        if (!paths || paths.length === 0) {
            if (opts.onDone) opts.onDone(0, 0);
            return;
        }
        whenFSReady(function () {
            var total = paths.length, done = 0, okCount = 0;

            function finish() {
                done++;
                if (done >= total) {
                    if (opts.onDone) {
                        opts.onDone(okCount, total);
                    } else {
                        toast('导入完成: 成功 ' + okCount + '/' + total + ' 个文件', 3500);
                    }
                }
            }

            paths.forEach(function (abs) {
                var name = baseName(abs);
                // 指定了目标目录则写入该目录, 否则沿用默认归类规则
                var destDir = opts.destDir
                    ? (opts.destDir.charAt(opts.destDir.length - 1) === '/' ? opts.destDir : opts.destDir + '/')
                    : '/mythroad/' + targetDirOf(name);
                var destPath = destDir + name;

                fetch(apiUrl('/api/open-mrp?path=') + encodeURIComponent(abs))
                    .then(function (r) {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.arrayBuffer();
                    })
                    .then(function (ab) {
                        try {
                            // 目标子目录可能不存在, 先确保创建
                            if (typeof FS.mkdirTree === 'function') {
                                try { FS.mkdirTree(destDir); } catch (e0) { /* 已存在 */ }
                            }
                            FS.writeFile(destPath, new Uint8Array(ab));
                            okCount++;
                            if (typeof window.print === 'function') {
                                window.print("写入:'" + destPath + "'完成.");
                            }
                        } catch (e) {
                            console.warn('[vmrp-fnos] 写入 FS 失败 ' + destPath + ': ' + e.message);
                        }
                        finish();
                    })
                    .catch(function (e) {
                        console.warn('[vmrp-fnos] 读取失败 ' + abs + ': ' + e.message);
                        finish();
                    });
            });
        }, 15000);
    }

    /* ==================================================================
     * 2. 文件关联 —— 打开方式 (?path=)
     * ================================================================== */

    /**
     * 解析文件关联传入的 path 参数。
     * 飞牛打开文件时会追加 path=/vol1/xxx/yyy.mrp
     * 支持 SDK 的 parseAppAuthCallback (路由授权回调) 与普通 query。
     */
    function resolveLaunchPath() {
        // 1) 普通 query: ?path=... (端口服务入口会走这里)
        var qs = window.location.search || '';
        var m = qs.match(/[?&]path=([^&]*)/);
        if (m && m[1]) {
            try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
        }
        // 2) SDK 回调解析 (统一网关 / openAppAuth 场景)
        if (sdk && typeof sdk.parseAppAuthCallback === 'function') {
            try {
                var r = sdk.parseAppAuthCallback(window.location.href);
                if (r && r.status === 'success' && r.path && r.path.length) return r.path[0];
            } catch (e) { /* 忽略 */ }
        }
        return null;
    }

    /**
     * 若当前是"用模拟器打开某个 mrp 文件", 把该文件读入 FS 并标记为待运行。
     * 复用原有 ?f= 直接运行机制: 写入 /mythroad/dsm_gm.mrp 位置。
     * @returns {boolean} 是否进入文件关联模式
     */
    function handleLaunchPath() {
        var p = resolveLaunchPath();
        if (!p || !/\.mrp$/i.test(p)) return false;

        var name = baseName(p);
        console.log('[vmrp-fnos] 文件关联打开: ' + p);

        // 暴露给 fs.js 的 preRun 逻辑使用
        window.vmrpLaunchPath = p;
        window.vmrpLaunchName = name;
        return true;
    }

    /* ==================================================================
     * 3. 保存到飞牛文件系统
     * ================================================================== */

    /**
     * 让用户选择一个飞牛目录作为保存位置。
     * @returns {Promise<string|null>} 目录绝对路径
     */
    function pickSaveDir() {
        if (!inFnOS || !sdk) {
            return Promise.resolve(null);
        }
        lastPickError = null;
        return sdk.ready().then(function () {
            return sdk.pickUserFile({
                directory: true,
                title: '选择保存目录',
                okText: '保存到此处',
                creatable: true,
                sidebarGroup: ['myFiles', 'otherShare', 'external', 'remote', 'favorites']
            });
        }).then(function (result) {
            var dir = normalizePickResult(result, '选择目录失败');
            if (dir) return dir;

            // 拿不到路径: 此时 normalizePickResultList 已写入了失败详情。
            // 关键: 不要把"鉴权失败"当成"用户取消" —— 那会误导用户。
            if (lastPickError && !isUserCancel()) {
                console.warn('[vmrp-fnos] 目录选择被拒绝: code=' + lastPickError.code +
                    ' msg=' + lastPickError.msg +
                    ' (官方说明: ' + (PICK_ERROR_TEXT[String(lastPickError.code)] || '未知') + ')');
                // 鉴权类失败尝试走 authorizeUserFile 兜底 (见下方)
                return tryAuthorizeFallback();
            }
            // 真·取消
            console.warn('[vmrp-fnos] 目录选择: 用户取消');
            return null;
        }).catch(function (e) {
            console.warn('[vmrp-fnos] pickSaveDir 异常: ' + (e && e.message));
            toast('调用飞牛目录选择器失败: ' + ((e && e.message) || ''));
            return null;
        });
    }

    /**
     * 目录选择被拒时的兜底链 —— 依次尝试所有可用通道。
     *
     * 背景: 部分环境下 pickUserFile 会返回 1003103「应用权限校验失败」,
     * 官方建议重装应用。但重装不一定能解决 (票据/注册态问题), 所以这里
     * 按顺序尝试其余几条官方通路, 尽量让用户不依赖系统设置手动操作:
     *
     *   通道 1: 查后端已授权目录 (trim.file.getUserAccessibleFolders)
     *           —— 若此前授权过, 直接复用, 完全绕开选择器
     *   通道 2: authorizeUserFile(已知路径)  —— 定向重新申请授权
     *   通道 3: pickSharedFile()             —— 管理员共享授权 (绕开个人授权链路)
     *   通道 4: openAppAuth()                —— 仅 isStandaloneWeb 时可用
     *
     * 全部失败 -> 返回 null, 由调用方给出明确的可执行引导。
     *
     * @returns {Promise<string|null>}
     */
    function tryAuthorizeFallback() {
        return channelUserFolders()
            .then(function (picked) {
                if (picked) return picked;
                return channelSharedFolders();
            })
            .then(function (picked) {
                if (picked) return picked;
                return channelAuthorizeKnownPath();
            })
            .then(function (picked) {
                if (picked) return picked;
                return channelOpenAppAuth();
            })
            .then(function (picked) {
                if (picked) return picked;
                // 所有通道都不通 -> 给出真实原因 + 可执行建议
                adviseAuthFailure();
                return null;
            });
    }

    /** 通道 1: 复用后端查到的已授权目录 */
    function channelUserFolders() {
        return fetch(apiUrl('/api/user-folders'), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var paths = (j && j.code === 0 && j.data && j.data.paths) || [];
                if (!paths.length) {
                    console.log('[vmrp-fnos] 通道1: 无已授权目录');
                    return null;
                }
                console.log('[vmrp-fnos] 通道1: 命中 ' + paths.length + ' 个已授权目录');
                return askPickFromList(paths);
            })
            .catch(function () { return null; });
    }

    /** 通道 2: 管理员共享授权目录 (pickSharedFile / getSharedAccessibleFolders) */
    function channelSharedFolders() {
        // 先看是否已有共享授权 (后端查询, 不弹窗)
        return fetch(apiUrl('/api/shared-folders'), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var paths = (j && j.code === 0 && j.data && j.data.paths) || [];
                if (paths.length) {
                    console.log('[vmrp-fnos] 通道2: 命中 ' + paths.length + ' 个共享授权目录');
                    return askPickFromList(paths);
                }
                // 没有则尝试发起共享授权 (仅管理员可用)
                if (!sdk || typeof sdk.pickSharedFile !== 'function') {
                    console.log('[vmrp-fnos] 通道2: SDK 无 pickSharedFile');
                    return null;
                }
                console.log('[vmrp-fnos] 通道2: 尝试 pickSharedFile (需管理员)');
                return sdk.pickSharedFile({
                    title: '选择要授权给应用的目录',
                    okText: '授权',
                    creatable: true
                }).then(function (res) {
                    var p = normalizePickResult(res, '共享授权失败');
                    if (p) return p;
                    if (lastPickError) {
                        // 非管理员会返回 code:1 "仅管理员可进行此操作"
                        console.log('[vmrp-fnos] 通道2 未通过: code=' + lastPickError.code +
                            ' msg=' + lastPickError.msg);
                    }
                    return null;
                }).catch(function (e) {
                    console.log('[vmrp-fnos] 通道2 异常: ' + (e && e.message));
                    return null;
                });
            })
            .catch(function () { return null; });
    }

    /**
     * 通道 3: authorizeUserFile 定向重新申请授权。
     * 需要"已知路径"。这里从几个来源凑:
     *   - 后端已保存的历史保存目录 (localStorage)
     *   - 环境变量里的 data-share 目录
     */
    function channelAuthorizeKnownPath() {
        if (!sdk || typeof sdk.authorizeUserFile !== 'function') {
            console.log('[vmrp-fnos] 通道3: SDK 无 authorizeUserFile');
            return Promise.resolve(null);
        }
        var known = getKnownDirs();
        if (!known.length) {
            console.log('[vmrp-fnos] 通道3: 无已知路径可供定向授权');
            return Promise.resolve(null);
        }
        // 让用户挑一个已知路径去申请授权
        return askPickFromList(known).then(function (path) {
            if (!path) return null;
            console.log('[vmrp-fnos] 通道3: authorizeUserFile(' + path + ')');
            return sdk.authorizeUserFile(path).then(function (res) {
                var p = normalizePickResult(res, '重新申请授权失败');
                if (p) return p;
                if (lastPickError) {
                    console.log('[vmrp-fnos] 通道3 未通过: code=' + lastPickError.code +
                        ' msg=' + lastPickError.msg);
                }
                return null;
            }).catch(function (e) {
                console.log('[vmrp-fnos] 通道3 异常: ' + (e && e.message));
                return null;
            });
        });
    }

    /** 通道 4: openAppAuth —— 仅独立浏览器页面 (isStandaloneWeb) 可用 */
    function channelOpenAppAuth() {
        if (!sdk || sdk.isStandaloneWeb !== true || typeof sdk.openAppAuth !== 'function') {
            console.log('[vmrp-fnos] 通道4: 不满足 isStandaloneWeb 或 SDK 无 openAppAuth');
            return Promise.resolve(null);
        }
        console.log('[vmrp-fnos] 通道4: openAppAuth 打开授权页');
        try {
            return sdk.openAppAuth('pickUserFile', {
                appName: getAppName(),
                directory: true,
                sidebarGroup: ['myFiles', 'otherShare', 'external', 'remote', 'favorites'],
                redirectUri: apiUrl('/callback.html')
            }, { target: '_blank', features: 'width=750,height=630' })
                .then(function () { return null; })   // 结果经回调页带回, 此处不阻塞
                .catch(function () { return null; });
        } catch (e) {
            console.log('[vmrp-fnos] 通道4 异常: ' + (e && e.message));
            return Promise.resolve(null);
        }
    }

    /**
     * 收集"已知路径"候选, 供通道 3 做定向重新授权。
     * 来源: 历史保存目录 / data-share 目录 / 常见用户根目录。
     */
    function getKnownDirs() {
        var out = [];
        function push(p) {
            if (typeof p === 'string' && p && p.charAt(0) === '/' && out.indexOf(p) < 0) out.push(p);
        }
        try {
            var hist = JSON.parse(localStorage.getItem('vmrp.lastSaveDirs') || '[]');
            if (Array.isArray(hist)) hist.forEach(push);
        } catch (e) { /* 忽略 */ }
        try {
            var last = localStorage.getItem('vmrp.lastSaveDir');
            if (last) push(last);
        } catch (e) { /* 忽略 */ }
        return out;
    }

    /** 记住最近用过的保存目录, 供后续定向授权 */
    function rememberSaveDir(dir) {
        if (!dir) return;
        try {
            localStorage.setItem('vmrp.lastSaveDir', dir);
            var hist = JSON.parse(localStorage.getItem('vmrp.lastSaveDirs') || '[]');
            if (!Array.isArray(hist)) hist = [];
            hist = hist.filter(function (p) { return p !== dir; });
            hist.unshift(dir);
            localStorage.setItem('vmrp.lastSaveDirs', JSON.stringify(hist.slice(0, 8)));
        } catch (e) { /* 忽略 */ }
    }

    /** 全部通道失败时, 给出真实原因与可执行建议 (不再谎称"已取消") */
    function adviseAuthFailure() {
        var code = lastPickError ? lastPickError.code : 0;
        var known = lastPickError ? PICK_ERROR_TEXT[String(lastPickError.code)] : '';
        var tip;
        if (code === 1003103) {
            // 最典型: 应用权限校验失败
            tip = '目录授权失败: 应用鉴权异常。\n\n' +
                '建议按顺序尝试:\n' +
                '1. 卸载本应用后重新安装 (官方建议)\n' +
                '2. 或联系管理员在「应用设置」里为本应用添加授权目录\n' +
                '3. 手机上可先在飞牛 App 的「文件」里把目标目录加入收藏, 再回来重试';
        } else if (code === 1003201) {
            tip = '目录授权失败: 管理员已关闭本应用的普通用户授权。\n请让管理员在应用设置中开启。';
        } else if (code === 1000002) {
            tip = '目录授权失败: 应用 API Scope 不足。\n请重新安装本应用以刷新权限声明。';
        } else {
            tip = '目录授权失败' + (known ? (': ' + known) : (code ? (' (错误码 ' + code + ')') : '')) +
                '\n请尝试重新安装应用。';
        }
        console.warn('[vmrp-fnos] ' + tip.replace(/\n/g, ' '));
        toast(tip, 9000);
    }

    /** 从页面配置读取应用名 (用于 openAppAuth) */
    function getAppName() {
        try {
            var m = window.location.pathname.match(/^\/app\/([^\/]+)/);
            if (m && m[1]) return m[1];
        } catch (e) { /* 忽略 */ }
        return 'vmrp';
    }

    /** 最近一次 getAppMessage 拿到的 appApi 版本 (来自 bridge 报文) */
    function getAppApi() {
        var v = findBridgeField('appApi');
        return v === undefined ? null : v;
    }

    /** 宿主 App 版本 */
    function getAppVersion() {
        var v = findBridgeField('appVersion');
        return v === undefined ? null : v;
    }

    /** 在 bridge 记录里找 getAppMessage 报文的某个字段 */
    function findBridgeField(field) {
        for (var i = bridgeLog.length - 1; i >= 0; i--) {
            var r = bridgeLog[i];
            if (r.method !== 'getAppMessage') continue;
            var p = r.parsed;
            if (p && typeof p === 'object' && p[field] !== undefined) return p[field];
        }
        return undefined;
    }

    /**
     * 让用户在"已授权目录"里挑一个 (原生 select 弹窗, 简单可靠)。
     * @param {string[]} paths
     * @returns {Promise<string|null>}
     */
    function askPickFromList(paths) {
        return new Promise(function (resolve) {
            var msg = '请选择保存目录:\n\n' +
                paths.map(function (p, i) { return (i + 1) + '. ' + p; }).join('\n') +
                '\n\n输入序号 (留空取消):';
            var input = window.prompt(msg, '1');
            if (!input) { resolve(null); return; }
            var idx = parseInt(input, 10);
            if (!(idx >= 1 && idx <= paths.length)) { resolve(null); return; }
            resolve(paths[idx - 1]);
        });
    }

    /**
     * 归一化文件/目录选择器的返回值 -> 路径数组。
     *
     * 返回值形态 (真机实测 + 官方文档双证):
     *   官方类型: pickUserFile(params?): Promise<AppBridgeResponse<string[]> | undefined>
     *            AppBridgeResponse<T> = { code: number; msg: string; data: T }
     *
     *   PC (isWeb=true)       -> { code: 0, msg: '', data: ['/vol1/xxx'] }
     *   移动端 (isWeb=false)  -> 同样 { code, msg, data }  ← 经 bridge 双层 JSON.parse 后
     *                            返回的就是这个对象, **不是裸数组**
     *
     *   失败时 data 为 null, 靠 code 区分原因:
     *     -1       = 用户取消
     *     0        = 成功
     *     1003103  = 应用权限校验失败 (需重装应用)
     *     1003201  = 管理员已关闭该应用的普通用户授权能力
     *     1000002  = API Scope 不足
     *     1000701  = 路径不存在
     *
     * 之所以保留"裸数组"分支: 早期 SDK 版本 / 某些宿主可能直接给数组,
     * 属于防御性兼容, 不是主路径。
     *
     * @param {*} result      原始返回值
     * @param {string} errTip 业务侧错误提示前缀
     * @returns {string[]}    选中的绝对路径列表 (空数组表示取消/失败)
     */
    function normalizePickResultList(result, errTip) {
        // 诊断: 把原始返回值打进控制台, 真机排查必备
        try {
            console.log('[vmrp-fnos] pickUserFile 返回 (' + typeof result + '): ' +
                JSON.stringify(result) + ' | isWeb=' + (sdk ? sdk.isWeb : '?'));
        } catch (e) { /* 忽略 */ }

        // 1) 裸数组: 防御性兼容 (非主路径, 官方类型是 {code,msg,data})
        if (Array.isArray(result)) {
            return result.filter(function (p) { return typeof p === 'string' && p; });
        }
        if (!result) return [];

        // 2) 主路径: {code, msg, data}
        if (typeof result.code === 'number') {
            if (result.code !== 0) {
                // 记录最后一次失败详情, 供 pickSaveDir 区分"取消"与"鉴权失败"
                lastPickError = {
                    code: result.code,
                    msg: result.msg || '',
                    at: Date.now()
                };
                toast(describePickError(result, errTip), 4000);
                return [];
            }
            lastPickError = null;
            var d = result.data;
            if (Array.isArray(d)) {
                return d.filter(function (p) { return typeof p === 'string' && p; });
            }
            if (typeof d === 'string' && d) return [d];
            return [];
        }

        // 3) 兜底: 直接给了路径字符串 / {path} / {paths}
        if (typeof result === 'string' && result) return [result];
        if (typeof result.path === 'string' && result.path) return [result.path];
        if (Array.isArray(result.paths)) {
            return result.paths.filter(function (p) { return typeof p === 'string' && p; });
        }

        console.warn('[vmrp-fnos] 无法识别的选择器返回值: ' + JSON.stringify(result));
        return [];
    }

    /**
     * 最后一次选择器失败详情 (由 normalizePickResultList 写入)。
     * 用于区分「用户取消」与「鉴权/权限失败」——两者 before 都表现为"没选到"。
     */
    var lastPickError = null;

    /**
     * JS SDK 错误码 -> 用户能看懂的话 (来源: 官方错误码文档)
     */
    var PICK_ERROR_TEXT = {
        '-1': '已取消',
        '1000000': '服务异常，请稍后重试',
        '1000001': '登录状态失效，请重新登录',
        '1000002': '应用权限不足',
        '1000030': '当前路径不支持该操作',
        '1000300': '应用未安装或未运行',
        '1000701': '路径不存在，请重新选择',
        '1003103': '应用权限校验失败，请重新安装应用',
        '1003201': '管理员已关闭普通用户授权，请联系管理员'
    };

    /**
     * 把 {code,msg} 变成给用户看的提示语。
     * 优先用官方文案, 未知码则回退到 msg。
     */
    function describePickError(r, errTip) {
        var known = PICK_ERROR_TEXT[String(r.code)];
        var prefix = errTip || '选择失败';
        if (known) return prefix + ': ' + known;
        return prefix + ': ' + (r.msg || ('错误码 ' + r.code));
    }

    /** 该次失败是否属于"用户主动取消" */
    function isUserCancel() {
        return !!(lastPickError && (lastPickError.code === -1 ||
            /取消|cancel/i.test(lastPickError.msg || '')));
    }

    /**
     * 归一化选择器返回值 -> 单个路径 (取第一个)。
     * @returns {string|null}
     */
    function normalizePickResult(result, errTip) {
        var list = normalizePickResultList(result, errTip);
        return list.length ? list[0] : null;
    }

    /**
     * 把一组 {name, data(Uint8Array)} 保存到飞牛指定目录。
     * @returns {Promise<number>} 成功保存的文件数
     */
    function saveEntriesToFnOS(entries, dirOverride) {
        if (!entries || entries.length === 0) {
            toast('没有可保存的文件');
            return Promise.resolve(0);
        }
        return pickSaveDir().then(function (dir) {
            if (dirOverride) dir = dirOverride;
            if (!dir) {
                // 只有"真取消"才说已取消; 鉴权类失败已在 adviseAuthFailure 里说明过原因
                if (isUserCancel()) toast('已取消保存');
                return 0;
            }
            rememberSaveDir(dir);
            var files = entries.map(function (e) {
                return { name: e.name, data: u8ToBase64(e.data) };
            });
            return fetch(apiUrl('/api/save-multi'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: dir, files: files })
            }).then(function (r) { return r.json(); })
              .then(function (j) {
                  if (j && j.code === 0) {
                      var n = j.data.saved ? j.data.saved.length : 0;
                      toast('已保存 ' + n + ' 个文件到飞牛', 3500);
                      return n;
                  }
                  toast('保存失败: ' + ((j && j.msg) || '未知错误'), 4000);
                  return 0;
              })
              .catch(function (e) {
                  toast('保存失败: ' + (e && e.message));
                  return 0;
              });
        });
    }

    /**
     * 保存单个 Uint8Array 文件到飞牛。
     */
    function saveSingleToFnOS(name, data) {
        return pickSaveDir().then(function (dir) {
            if (!dir) {
                if (isUserCancel()) toast('已取消保存');
                return false;
            }
            rememberSaveDir(dir);
            return fetch(apiUrl('/api/save-file'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dir: dir, name: name, data: u8ToBase64(data) })
            }).then(function (r) { return r.json(); })
              .then(function (j) {
                  if (j && j.code === 0) {
                      toast('已保存到飞牛: ' + j.data.path, 4000);
                      return true;
                  }
                  toast('保存失败: ' + ((j && j.msg) || '未知错误'), 4000);
                  return false;
              })
              .catch(function (e) {
                  toast('保存失败: ' + (e && e.message));
                  return false;
              });
        });
    }

    /**
     * 判断当前页面是否运行在飞牛宿主窗口内 (iframe 内嵌 / 非独立浏览器页面)。
     * 独立浏览器标签页中不应显示"退出应用"按钮。
     */
    function isInFnOSWindow() {
        // 每次都重算一遍: SDK 握手是异步的, 早先的判定可能过早为 false。
        // 一旦已经判定为 true 就保持 (避免握手后抖动导致按钮闪烁消失)。
        if (!inFnOS) {
            var now = computeInFnOS();
            if (now) {
                inFnOS = true;
                console.log('[vmrp-fnos] 宿主判定已更新: inFnOS=true');
            }
        }
        return inFnOS === true;
    }

    /**
     * 主动重新检测宿主环境 (供 UI 在合适时机调用, 例如 load / ready 之后)。
     * @returns {boolean} 最新判定结果
     */
    function refreshHostDetection() {
        if (!sdk || !sdkLoaded) return inFnOS === true;
        try {
            var now = computeInFnOS();
            if (now !== inFnOS) {
                inFnOS = now;
                console.log('[vmrp-fnos] 宿主判定已刷新: inFnOS=' + inFnOS);
            }
        } catch (e) { /* 忽略 */ }
        return inFnOS === true;
    }

    /**
     * 关闭当前飞牛应用窗口 (飞牛 SDK close 能力)。
     * 不在飞牛环境时返回 false, 由调用方决定降级行为。
     * @returns {Promise<boolean>} 是否成功发起关闭
     */
    function closeApp() {
        if (!inFnOS || !sdk) {
            return Promise.resolve(false);
        }
        return sdk.ready().then(function () {
            return sdk.close();
        }).then(function () {
            console.log('[vmrp-fnos] 已请求关闭应用窗口');
            return true;
        }).catch(function (e) {
            console.warn('[vmrp-fnos] close 调用失败: ' + (e && e.message));
            return false;
        });
    }

    /* ==================================================================
     * 版本校验: 识别"页面来自缓存, 服务端已升级"的情况
     *
     * 移动端 WebView 对静态资源的缓存比 PC 浏览器激进, 升级 fpk 后
     * 页面里可能仍是旧版 fnos.js。这里启动时向 /api/health 取服务端
     * WWW_STAMP (www 目录文件指纹), 与本页脚本自身携带的 __VMRP_WWW_STAMP
     * 比对; 不一致则强制 reload 一次 (带 cache-busting 参数)。
     * ================================================================== */

    var STALE_RELOAD_KEY = 'vmrp_stale_reload_at';

    function checkStalePage() {
        // 页面脚本自带指纹由服务端注入 (见 index.html 的 <script> 内联常量),
        // 取不到就跳过 (说明是旧版页面, 无法自证)
        var localStamp = window.__VMRP_WWW_STAMP;
        if (!localStamp) return;

        fetch(apiUrl('/api/health'), { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                var serverStamp = j && j.data && j.data.wwwStamp;
                if (!serverStamp || serverStamp === localStamp) return;

                // 防止无限刷新: 同一分钟内只允许强刷一次
                var last = 0;
                try { last = parseInt(sessionStorage.getItem(STALE_RELOAD_KEY) || '0', 10) || 0; } catch (e) { /* 忽略 */ }
                var now = Date.now();
                if (now - last < 60000) {
                    console.warn('[vmrp-fnos] 页面版本旧 (local=' + localStamp +
                        ' server=' + serverStamp + ') 但刚刷新过, 跳过以免死循环');
                    return;
                }
                try { sessionStorage.setItem(STALE_RELOAD_KEY, String(now)); } catch (e) { /* 忽略 */ }

                console.warn('[vmrp-fnos] 检测到页面为旧版本 (local=' + localStamp +
                    ' server=' + serverStamp + '), 强制重新加载');
                var u = new URL(window.location.href);
                u.searchParams.set('_v', serverStamp);
                window.location.replace(u.toString());
            })
            .catch(function () { /* 网络异常时静默 */ });
    }

    /* ==================================================================
     * 初始化
     * ================================================================== */

    detectSDK();
    checkStalePage();

    // bridge 探针要在任何 bridge 调用之前挂上。
    // flutter_inappwebview 可能稍后才注入, 故立即试一次 + 平台就绪后再试。
    instrumentBridge();
    window.addEventListener('flutterInAppWebViewPlatformReady', function () {
        instrumentBridge();
    });
    // 兜底: 前 10 秒内每秒试一次 (覆盖注入时机不确定的情况)
    (function retryInstrument() {
        var tries = 0;
        var timer = setInterval(function () {
            tries++;
            if (instrumentBridge() || tries >= 10) clearInterval(timer);
        }, 1000);
    })();

    window.vmrpFnos = {
        version: '1.6.0',
        get inFnOS() { return inFnOS; },
        get sdkLoaded() { return sdkLoaded; },
        get sdk() { return sdk; },

        // 导入
        importFile: fnImportFile,
        importPaths: importPaths,

        // 文件关联
        resolveLaunchPath: resolveLaunchPath,
        handleLaunchPath: handleLaunchPath,

        // 窗口 / 宿主
        isInFnOSWindow: isInFnOSWindow,
        refreshHostDetection: refreshHostDetection,
        closeApp: closeApp,
        diagnose: function () {
            var webMode = sdk ? sdk.isWeb : null;
            return {
                sdkLoaded: sdkLoaded,
                inFnOS: inFnOS,
                hasTrimAppCtor: typeof (window.TrimApp) === 'function',
                isIframe: inIframeNow(),
                isStandaloneWeb: sdk ? sdk.isStandaloneWeb : null,
                isWeb: webMode,
                isMobileWebView: isMobileWebView(),
                flutterPlatformReady: flutterPlatformReady,
                hasFlutterBridge: !!window.flutter_inappwebview,
                compute: computeInFnOS(),
                mode: (webMode === false)
                    ? 'mobile-app'
                    : (inIframeNow() ? 'web-host' : 'standalone-web'),
                // 版本自检: 页面脚本自带的指纹 vs 其承载模块
                moduleVersion: '1.6.0',
                wwwStamp: window.__VMRP_WWW_STAMP || null,
                location: window.location.href,
                appApi: getAppApi(),
                appVersion: getAppVersion(),
                hasAuthorizeUserFile: !!(sdk && typeof sdk.authorizeUserFile === 'function'),
                hasPickSharedFile: !!(sdk && typeof sdk.pickSharedFile === 'function'),
                hasOpenAppAuth: !!(sdk && typeof sdk.openAppAuth === 'function'),
                userAgent: (function () { try { return navigator.userAgent; } catch (e) { return ''; } })()
            };
        },

        /**
         * 一次性打印完整环境 + 版本诊断 (真机排查时在控制台执行)
         * 用法: window.vmrpFnos.report()
         */
        report: function () {
            var d = window.vmrpFnos.diagnose();
            var lines = [
                '=== VMRP 飞牛环境诊断 ===',
                '模块版本   : ' + d.moduleVersion,
                '页面指纹   : ' + (d.wwwStamp || '(无 — 可能是缓存的旧页面)'),
                '宿主模式   : ' + d.mode,
                'inFnOS     : ' + d.inFnOS,
                'isWeb      : ' + d.isWeb,
                'flutter桥  : ' + d.hasFlutterBridge,
                'SDK已加载  : ' + d.sdkLoaded,
                'appApi     : ' + (d.appApi || '(未知)'),
                'App版本    : ' + (d.appVersion || '(未知)'),
                'isStandaloneWeb : ' + d.isStandaloneWeb,
                '授权通道   : authorizeUserFile=' + d.hasAuthorizeUserFile +
                    ' pickSharedFile=' + d.hasPickSharedFile +
                    ' openAppAuth=' + d.hasOpenAppAuth,
                '主循环暂停 : ' + (typeof window.__vmrpLoopPaused === 'function'
                    ? window.__vmrpLoopPaused() : 'n/a'),
                'URL        : ' + d.location
            ];
            // 附上最近的 bridge 原始报文 —— 排查"选了却返回空"的关键证据
            if (bridgeLog.length) {
                lines.push('');
                lines.push('=== 最近 ' + bridgeLog.length + ' 次 bridge 调用 ===');
                bridgeLog.forEach(function (r, i) {
                    lines.push('[' + (i + 1) + '] ' + r.method + '  @' + r.at);
                    lines.push('    raw   : ' + r.raw);
                    lines.push('    parsed: ' + (r.err ? ('解析失败 -> ' + r.err) : JSON.stringify(r.parsed)));
                });
            } else {
                lines.push('');
                lines.push('=== bridge 调用记录: 空 ===');
                lines.push('(说明探针未挂上, 或本次会话尚未发生 bridge 调用)');
            }

            // 最近一次选择器失败详情 (区分"取消"与"鉴权失败")
            lines.push('');
            if (lastPickError) {
                lines.push('=== 最近一次选择器失败 ===');
                lines.push('code : ' + lastPickError.code);
                lines.push('msg  : ' + lastPickError.msg);
                lines.push('官方 : ' + (PICK_ERROR_TEXT[String(lastPickError.code)] || '(未知错误码)'));
                lines.push('性质 : ' + (isUserCancel() ? '用户主动取消' : '非取消 (权限/鉴权/参数问题)'));
            } else {
                lines.push('=== 最近一次选择器失败: 无 ===');
            }
            var text = lines.join('\n');
            try { console.log(text); } catch (e) { /* 忽略 */ }
            return text;
        },

        /** 最近 bridge 原始报文 (供 UI 或外部读取) */
        getBridgeLog: function () { return bridgeLog.slice(); },

        /** 主动强制刷新页面 (清缓存) — 供用户手动排查 */
        forceReload: function () {
            var u = new URL(window.location.href);
            u.searchParams.set('_v', String(Date.now()));
            window.location.replace(u.toString());
        },

        // 保存到飞牛
        pickSaveDir: pickSaveDir,
        saveEntries: saveEntriesToFnOS,
        saveSingle: saveSingleToFnOS,

        // 诊断补充: 最近一次选择器失败详情 / 用户已授权目录
        lastPickError: function () {
            return lastPickError ? {
                code: lastPickError.code,
                msg: lastPickError.msg,
                text: PICK_ERROR_TEXT[String(lastPickError.code)] || '',
                at: new Date(lastPickError.at).toISOString(),
                isCancel: isUserCancel()
            } : null;
        },
        pickErrorText: function () { return PICK_ERROR_TEXT; },
        queryUserFolders: function () {
            return fetch(apiUrl('/api/user-folders'), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .catch(function (e) { return { code: 1, msg: (e && e.message) || '请求失败' }; });
        },
        querySharedFolders: function () {
            return fetch(apiUrl('/api/shared-folders'), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .catch(function (e) { return { code: 1, msg: (e && e.message) || '请求失败' }; });
        },
        probeOpenApi: function () {
            return fetch(apiUrl('/api/openapi-probe'), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .catch(function (e) { return { code: 1, msg: (e && e.message) || '请求失败' }; });
        },

        /**
         * 主动重新走一遍授权兜底链 —— 供 UI 上的「重新申请授权」按钮调用。
         * 用户遇到 1003103 时不必重装, 先点这个试。
         * @returns {Promise<string|null>} 拿到的目录路径
         */
        reauthorize: function () {
            if (!inFnOS || !sdk) return Promise.resolve(null);
            return sdk.ready().then(function () {
                return tryAuthorizeFallback();
            }).catch(function () { return null; });
        },

        /** 已知路径列表 (定向授权候选) */
        getKnownDirs: function () { return getKnownDirs(); },

        // 工具
        u8ToBase64: u8ToBase64,
        baseName: baseName,
        apiUrl: apiUrl,
        apiBase: apiBase
    };

    if (inFnOS) {
        console.log('[vmrp-fnos] 已检测到飞牛宿主环境, 文件 API 已启用');
    } else {
        console.log('[vmrp-fnos] 未检测到飞牛宿主环境, 将降级为浏览器原生文件能力');
    }
})();

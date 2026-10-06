# VMRP for 飞牛 fnOS

把 [vmrp](https://github.com/vmrp/vmrp)（冒泡 / Mythroad 功能机 MRP 模拟器）的 Web 版封装为 **飞牛 fnOS 原生应用**。

安装后可在飞牛桌面直接打开模拟器，在文件管理器里双击 `.mrp` 文件直接运行，并支持在飞牛与模拟器之间互传文件。

<br>

## 关于上游项目

本项目是 [**vmrp**](https://github.com/vmrp/vmrp) 的 fnOS 平台移植版，**不是**独立项目。

| | |
|---|---|
| 上游仓库 | https://github.com/vmrp/vmrp |
| 上游作者 | [zengming00](https://github.com/zengming00) |
| 开源协议 | **GNU General Public License v3.0** |
| 核心原理 | 基于 [Unicorn Engine](https://github.com/unicorn-engine/unicorn) 实现 ARM 指令级模拟，不依赖真实 ARM CPU |
| 上游在线体验 | https://vmrp.github.io/vmrp_v1.0/main.html |
| Web 版构建 | Emscripten 编译至 `wasm/dist`（本项目的 `app/www/`） |

> 📌 **关于仓库地址**：原仓库 `github.com/zengming00/vmrp` 已改名为组织仓库
> `github.com/vmrp/vmrp`（访问旧地址会自动跳转）。本项目统一使用新地址。

**vmrp 是什么**：安卓上的 mrpoid 模拟器受限于系统环境，作者因此开发了 vmrp —— 它借助 Unicorn Engine 实现真正的指令级模拟器，可以运行斯凯（Mythroad / 冒泡）平台的 `.mrp` 应用与游戏，也能用于逆向分析。

本项目**不修改**模拟器核心逻辑，只做了三件事：

1. 把上游 Web 版产物（`vmrp.js` / `vmrp.wasm` / `fs.js` / `midi.js` / `fs/`）原样纳入 `app/www/`
2. 新增 `app/www/fnos.js` 作为飞牛宿主能力集成层
3. 新增 `app/server/server.js` 提供文件读写后端 + 生命周期脚本与打包配置

模拟器本身的全部功劳属于上游作者与贡献者。

<br>

## 功能

| 能力 | 说明 |
|---|---|
| 桌面图标 | 安装后在飞牛桌面直接点击打开模拟器 |
| 文件关联 | 注册 `.mrp` 打开方式，文件管理器双击 / 右键"打开方式"即直接运行该 MRP |
| 导入文件 | 功能区"导入文件"调用飞牛文件选择器，直接选取 NAS 上的文件导入模拟器 |
| 保存到飞牛 | 把模拟器内文件 / 整个目录保存到 NAS（保留目录结构） |
| 存档 | 游戏进度自动保存到浏览器 IndexedDB，下次打开自动恢复 |
| 网页版兼容 | 非飞牛环境下自动降级为原生文件选择与浏览器下载，行为与上游 Web 版一致 |

<br>

## 快速开始

### 安装

```bash
# 把 vmrp.fpk 传到飞牛设备后
appcenter-cli install-fpk vmrp.fpk
```

或在飞牛应用中心手动上传 `.fpk` 安装包。

> **首次使用目录授权功能**：若选择保存目录时报「应用鉴权异常」，请点击帮助区的
> **「重新申请目录授权」**按钮重试；仍失败可尝试卸载后重新安装。

### 打包

```bash
bash build.sh
```

产物为 `vmrp.fpk`。脚本会先跑全部自检（9 个测试脚本、330+ 项断言），全部通过后才调用官方 `fnpack` 打包。

本地开发模式（免打包，直接映射目录）：

```bash
appcenter-cli install-local
```

<br>

## 项目结构

```
vmrp-fn-app/
├── app/
│   ├── server/server.js      # 后端: 静态资源托管 + 文件读写 + 飞牛开放 API 客户端
│   ├── ui/
│   │   ├── config            # 桌面入口 + .mrp 文件关联注册
│   │   └── images/           # 桌面图标 (64 / 256)
│   └── www/                  # vmrp Web 版产物 (来自上游 wasm/dist)
│       ├── index.html        # 模拟器主页面
│       ├── vmrp.js           # Emscripten 生成 (上游)
│       ├── vmrp.wasm         # 模拟器核心 (上游)
│       ├── fs.js / midi.js   # 上游
│       ├── fs/               # 内置 mythroad 文件系统 (上游)
│       ├── vendor/           # @trimjs/web-app (飞牛官方 JS SDK)
│       ├── fnos.js           # ★ 飞牛集成层 (本项目新增)
│       └── callback.html     # ★ 授权回调页 (本项目新增)
├── cmd/main                  # 生命周期脚本: 启停 Node 服务
├── config/
│   ├── privilege             # 运行用户
│   └── resource              # api-scope + data-share 声明
├── manifest                  # 应用元数据
├── ICON.PNG / ICON_256.PNG   # 应用中心图标
├── tools/
│   ├── fnpack.exe            # 飞牛官方打包工具
│   ├── make_icon.py          # 图标生成脚本
│   └── test-*.js             # 自检脚本
├── build.sh                  # 打包脚本 (含自检)
├── LICENSE                   # GPL-3.0 全文
└── README.md
```

> ★ = 本项目新增，其余文件来自上游 vmrp 或飞牛官方。

<br>

## 技术架构

### 访问方式：统一网关

应用**不监听 TCP 端口**，而是监听 Unix Socket 由飞牛统一网关转发：

- 服务监听 `${TRIM_APPDEST}/app.sock`
- 网关前缀 `/app/vmrp`，网关注入 `X-Trim-Userid` / `X-Trim-Isadmin` / `X-Trim-Username`
- 用户访问前由网关校验 NAS 登录态，避免服务被绕过直接访问

> 早期版本使用 `service_port` 端口模式，会导致 **fn connect 报「暂无权限访问该服务」**，
> 故迁移至网关模式。

### 后端接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 健康检查（含构建号与页面指纹 `wwwStamp`） |
| `/api/open-mrp?path=` | GET | 读取 NAS 上的 `.mrp`（文件关联用） |
| `/api/save-file` | POST | 保存单个文件（body: `{dir, name, data(base64)}`） |
| `/api/save-multi` | POST | 批量保存（body: `{dir, files:[{name, data}]}`，支持子目录） |
| `/api/list-dir?path=` | GET | 列出目录内容 |
| `/api/user-folders` | GET | 查询当前用户已授权目录（开放 API 代理） |
| `/api/shared-folders` | GET | 查询管理员共享授权目录 |
| `/api/openapi-probe` | GET | 诊断：token / socket / scope 可用性 |
| `/api/auth-probe` | GET | 诊断：授权综合信息 |

**安全限制**：所有路径参数必须位于 `/vol*` 之下，服务端做 `path.posix.normalize`
规范化并拒绝目录穿越（`..`），文件名剥离路径分隔符，同名文件自动加序号。

### 归属信息（manifest）

| 字段 | 值 | 含义 |
|---|---|---|
| `maintainer` | `zengming00` | 开发者 —— 模拟器原作者 |
| `maintainer_url` | `https://github.com/vmrp/` | 开发者链接 |
| `distributor` | `gddhy` | 发布者 —— fnOS 移植版打包分发方 |
| `distributor_url` | `https://gddhy.net/` | 发布者链接 |

> 开发者与发布者分属两者：模拟器核心由 **zengming00** 开发，
> 飞牛 fnOS 移植版由 **gddhy** 打包发布。这与 GPL-3.0 的要求一致 ——
> 分发衍生作品时需同时标明原作者与分发方。

### 飞牛能力接入

`manifest` 声明 `micro_app = true` 以启用宿主 JS SDK。

`config/resource` 声明两个 scope：

```json
{
  "api-scope": ["trim.file.userAccess", "trim.file.sharedAccess"]
}
```

| scope | 用途 |
|---|---|
| `trim.file.userAccess` | 当前用户选择并授权自己的目录 / 文件 |
| `trim.file.sharedAccess` | 管理员为应用授权固定目录（授权失败时的备用通道） |

**前端集成层 `app/www/fnos.js`**：

- 自动探测宿主环境（Web 宿主走 postMessage，移动端 App 走 flutter bridge）
- **非飞牛环境自动降级**为浏览器原生行为，不影响网页版
- `importFile()` → `pickUserFile()` 选文件 → 经 `/api/open-mrp` 读入模拟器 FS
- `saveEntries()` / `saveSingle()` → `pickUserFile({directory:true})` 选目录 → 写入 NAS

### 目录授权失败的四通道兜底

飞牛环境偶发 `1003103 应用权限校验失败`，且**重装不一定能解决**。
应用在目录选择被拒后会自动依次尝试四条官方通路：

1. **复用已授权目录** — 后端 `trim.file.getUserAccessibleFolders`
2. **管理员共享授权** — `pickSharedFile` / `trim.file.getSharedAccessibleFolders`（绕开个人授权链路）
3. **定向补授权** — `authorizeUserFile(path)`，对历史保存目录重新申请
4. **路由授权** — `openAppAuth()`，仅独立浏览器页（`isStandaloneWeb`）可用

全部失败时按错误码给出可执行建议，并提供「重新申请目录授权」按钮手动重试。

> 后端开放 API 与前端 JS SDK 是**两套独立链路**，鉴权互不影响。
> 后端 API 通不代表前端 SDK 通，反之亦然。

### 文件关联原理

`app/ui/config` 中 `vmrp.OpenMrp` 入口声明 `"fileTypes": ["mrp"]` 且 `noDisplay: true`。

飞牛在用户选择"用 MRP模拟器打开"某文件时，会在入口 URL 后追加 `?path=/vol1/xxx/yyy.mrp`。
`fs.js` 的 preRun 检测到 `path` 参数后转为请求 `/api/open-mrp`，复用原有 `?f=` 自动运行机制，写入 `/mythroad/dsm_gm.mrp` 位置后直接启动。

#### 文件名含空格的处理（重要）

飞牛拼接 `?path=` 时按 **`application/x-www-form-urlencoded`** 语义编码，
即**空格会变成 `+`** 而不是 `%20`。若只用 `decodeURIComponent` 解码，`+` 会原样保留，
导致文件名里的空格变成加号，最终提示"文件不存在"或打开失败。

因此所有查询串解码都遵循**两步**（顺序不可颠倒）：

```js
var s = String(raw).replace(/\+/g, ' ');   // 1) 先把 form-urlencoded 的空格还原
try { s = decodeURIComponent(s); } catch (e) {}  // 2) 再做百分号解码
```

先替换再解码，才能保住文件名里**真正的加号**（编码为 `%2B`）：若顺序颠倒，
`%2B` 会先被解成 `+`，随后又被误当空格，造成数据损坏。

涉及位置（三处前端 + 一处后端防护）：

| 文件 | 函数 | 作用 |
|---|---|---|
| `app/www/fnos.js` | `decodeQueryValue()` | 文件关联主链路（`?path=`） |
| `app/www/index.html` | `safeDecode()` | 页面内 `GetQueryString`（`?f=` / `?title=`） |
| `app/www/callback.html` | `safeDec()` | 授权回调查询串 |
| `app/server/server.js` | `sanitizeAbsPath()` | **不做**无条件解码，避免二次解码 |

后端 `sanitizeAbsPath` 特别说明：前端一律用 `encodeURIComponent` 传出，
`url.parse(req.url, true)` 已解过一层，所以后端拿到的是**真实路径**。
此时若再无条件 `decodeURIComponent`，文件名本身含 `%20` 字样的文件（真的叫 `a%20b.mrp`）
会被二次解码成 `a b.mrp`，反而指向错误文件。故改为**先按原样判断，失败再解码一次**兜底。

### 缓存与版本

移动端 WebView 会无视校验直接使用缓存，因此：

- 静态资源全部返回 `no-store, no-cache, must-revalidate`
- HTML 注入 `window.__VMRP_WWW_STAMP`（www 目录指纹）
- 页面加载时比对指纹与 `/api/health` 的 `wwwStamp`，不一致则自动强刷（sessionStorage 60s 节流）
- 帮助区提供「重新申请目录授权」与版本信息

### 资源占用

- 抖动动画使用 `requestAnimationFrame` + 帧节流（避免 `setInterval(fn, 1)` 导致的 CPU 冲高）
- 页面切至后台时调用 `Module.pauseMainLoop()` 暂停 Emscripten 主循环，回到前台 `resumeMainLoop()`

<br>

## 运行时依赖

`manifest` 声明：

```ini
install_dep_apps = nodejs_v22
```

飞牛应用中心安装本应用时会自动安装 Node.js v22 运行时（`/var/apps/nodejs_v22/target/bin`）。
`cmd/main` 启动时按顺序查找 node：

1. 包内自带 `app/server/bin/node`（如有）
2. 依赖运行时 `/var/apps/nodejs_v22/target/bin/node`
3. 系统 `PATH` 中的 node

<br>

## 开发与自检

`build.sh` 会依次执行以下自检脚本（全部通过才打包）：

| 脚本 | 断言数 | 覆盖内容 |
|---|---|---|
| `tools/verify-fnos.js` | 18 | 集成层 API 完整性 |
| `tools/test-exit-confirm.js` | 11 | 退出二次确认 |
| `tools/test-srcpick.js` | 11 | 来源选择弹窗 |
| `tools/test-gateway.js` | 83 | 网关前缀 / 尾斜杠 / 静态资源 |
| `tools/test-cmdmain.js` | 11 | 生命周期脚本 |
| `tools/test-pickresult.js` | 89 | 选择器返回值 + 授权兜底链 |
| `tools/test-cache-cpu.js` | 86 | 缓存策略 / CPU 占用 / 错误码 |
| `tools/verify-stale-flow.js` | 15 | 指纹强刷链路（起真实服务验证） |
| `tools/smoke-gateway.js` | 19 | 网关端到端冒烟 |

单独运行某个脚本：

```bash
node tools/test-pickresult.js
```

### 图标重新生成

```bash
python tools/make_icon.py
```

从 `../vmrp/icon.png` 生成并更新 `ICON.PNG`、`ICON_256.PNG` 与 `app/ui/images/icon_{64,256}.png`。

<br>

## 从源码构建模拟器本体

本项目使用上游**已编译好的 Web 产物**。如需自行编译模拟器核心，请参考上游
[README 的"编译方法"章节](https://github.com/vmrp/vmrp#%E7%BC%96%E8%AF%91%E6%96%B9%E6%B3%95)：

- Windows 下使用 mingw + SDL2 + Unicorn + capstone 编译原生模拟器
- Web 版通过 Emscripten 编译至 `wasm/dist`
- `mythroad` 层需用斯凯 SDK 单独编译，提取其中的 `cfunction.ext`

编译产物的 `wasm/dist` 内容可直接替换本项目的 `app/www/`。

<br>

## 许可

本项目遵循 **GNU General Public License v3.0**（或更新版本）发布，与上游 vmrp 保持一致。
完整协议文本见 [LICENSE](LICENSE)。

```
VMRP for 飞牛 fnOS
Copyright (C) 2026 VMRP contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```

### 第三方组件

| 组件 | 协议 | 来源 |
|---|---|---|
| vmrp 模拟器核心 | GPL-3.0 | https://github.com/vmrp/vmrp |
| Unicorn Engine | GPL-2.0 | https://github.com/unicorn-engine/unicorn |
| @trimjs/web-app | 飞牛官方 | 飞牛 fnOS SDK |
| MidiPlayer | 见上游 | https://github.com/chenx/MidiPlayer |
| Mythroad / 斯凯资源 | 见上游说明 | 随 vmrp 分发 |

<br>

## 致谢

- [zengming00](https://github.com/zengming00) 及 vmrp 贡献者 —— 模拟器核心
- [Yichou](https://github.com/Yichou/mrpoid2018) 的 mrpoid —— vmrp 的参考实现
- 飞牛 fnOS 应用开发文档与社区镜像 [ckcoding/fnnas-docs](https://github.com/ckcoding/fnnas-docs)

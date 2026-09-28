#!/bin/bash
# VMRP 飞牛应用打包脚本
# 用法: bash build.sh
# 产物: vmrp.fpk

set -e

cd "$(dirname "$0")"

echo "[1/3] 清理临时文件..."
find . -name ".DS_Store" -delete 2>/dev/null || true
# 服务运行期产生的日志不要打进安装包 (运行时日志写在 ${TRIM_PKGVAR})
rm -f app/server.log
find . -name "*.log" -not -path "./node_modules/*" -delete 2>/dev/null || true

# GPL-3.0 合规: LICENSE 必须随分发物一并提供 (fnpack 会打包根目录的 LICENSE)
if [ ! -f LICENSE ]; then
    echo "错误: 缺少 LICENSE 文件 (GPL-3.0 要求随分发提供)"
    exit 1
fi

echo "[2/3] 同步网页资源 (从 ../vmrp)..."
# 可选: 若上游 vmrp 网页有更新, 取消下面注释以重新同步
# 注意: app/www/fnos.js 与 app/www/vendor/ 是飞牛专用改造, 不要被上游覆盖!
# SRC="../vmrp"
# if [ -d "$SRC" ]; then
#     cp "$SRC/index.html" "$SRC/fs.js" "$SRC/vmrp.js" "$SRC/midi.js" "$SRC/vmrp.wasm" app/www/
#     cp -r "$SRC/fs" app/www/
#     cp "$SRC/icon.png" "$SRC/icon-512.png" app/www/
#     echo "    已同步网页资源"
#     echo "    提示: 同步后需重新应用 fnos.js 集成、index.html 飞牛改造项"
# fi

# 自检: 飞牛集成关键项是否完好
if command -v node >/dev/null 2>&1; then
    node tools/verify-fnos.js || { echo "自检失败, 已中止打包"; exit 1; }
    echo
    node tools/test-exit-confirm.js || { echo "退出确认测试失败, 已中止打包"; exit 1; }
    echo
    node tools/test-srcpick.js || { echo "来源弹窗测试失败, 已中止打包"; exit 1; }
    echo
    node tools/test-gateway.js || { echo "统一网关/移动端测试失败, 已中止打包"; exit 1; }
    echo
    node tools/test-cmdmain.js || { echo "cmd/main 行为测试失败, 已中止打包"; exit 1; }
    echo
    node tools/test-pickresult.js || { echo "选择器返回值归一化测试失败, 已中止打包"; exit 1; }
    echo
    node tools/test-cache-cpu.js || { echo "缓存/版本自检/CPU 防护测试失败, 已中止打包"; exit 1; }
    echo
    node tools/verify-stale-flow.js || { echo "版本指纹端到端验证失败, 已中止打包"; exit 1; }
    echo
    node tools/smoke-gateway.js || { echo "网关路由冒烟测试失败, 已中止打包"; exit 1; }
fi

echo "[3/3] 打包 fpk..."
if [ -x ./tools/fnpack.exe ]; then
    ./tools/fnpack.exe build
elif command -v fnpack >/dev/null 2>&1; then
    fnpack build
else
    echo "错误: 未找到 fnpack 工具"
    echo "请下载对应平台版本放到 tools/ 目录:"
    echo "  https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64"
    exit 1
fi

echo
echo "打包完成:"
ls -la ./*.fpk

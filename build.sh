#!/usr/bin/env bash
# 打包扩展为 .crx（Edge/Chrome 均可安装）
# 用法: ./build.sh
# 产物: dist/时间戳转化-<version>.crx
# 首次构建生成 dist/extension-key.pem（私钥，勿提交/勿丢失，扩展 ID 由它决定）
set -euo pipefail
cd "$(dirname "$0")"

DIST="dist"
STAGE="$DIST/ext"

EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$EDGE" ]; then
    BROWSER="$EDGE"
elif [ -x "$CHROME" ]; then
    BROWSER="$CHROME"
else
    echo "未找到 Edge 或 Chrome，无法打包" >&2
    exit 1
fi

# 只打包 manifest 引用的文件
rm -rf "$STAGE"
mkdir -p "$STAGE/src"
cp manifest.json "$STAGE/"
cp src/*.js src/*.html "$STAGE/src/"
rm -f "$STAGE/src/manifest.json" # MV2 遗留文件，不属于本扩展

KEY="$DIST/extension-key.pem"
if [ -f "$KEY" ]; then
    "$BROWSER" --pack-extension="$PWD/$STAGE" --pack-extension-key="$PWD/$KEY" --no-message-box
else
    "$BROWSER" --pack-extension="$PWD/$STAGE" --no-message-box
    mv "$DIST/ext.pem" "$KEY"
    echo "已生成私钥 ${KEY} (请妥善保存，重新生成会改变扩展 ID)"
fi

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT="$DIST/timestamp-converter-$VERSION.crx"
mv "$DIST/ext.crx" "$OUT"
echo "打包完成: $OUT"

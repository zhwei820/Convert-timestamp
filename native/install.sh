#!/usr/bin/env bash
# 编译 Touch ID native messaging host 并注册到 Chrome / Edge
# 用法: native/install.sh <扩展ID> [更多扩展ID...]   （扩展 ID 见 chrome://extensions）
# 重新编译后二进制签名改变，首次 Touch ID 解锁时钥匙串会再弹一次授权，选「始终允许」
set -euo pipefail
cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
    echo "用法: $0 <扩展ID> [更多扩展ID...]" >&2
    exit 1
fi

HOST_NAME="com.bit.timestamp_vault"
INSTALL_DIR="$HOME/Library/Application Support/$HOST_NAME"
BIN="$INSTALL_DIR/vault-host"

mkdir -p "$INSTALL_DIR"
swiftc -O -swift-version 5 vault-host/main.swift -o "$BIN"
echo "已编译: $BIN"

ORIGINS=$(printf '"chrome-extension://%s/",' "$@")
ORIGINS="[${ORIGINS%,}]"

for DIR in \
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"; do
    [ -d "$(dirname "$DIR")" ] || continue
    mkdir -p "$DIR"
    cat > "$DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "时间戳转化 密码库 Touch ID",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": $ORIGINS
}
EOF
    echo "已注册: $DIR/$HOST_NAME.json"
done

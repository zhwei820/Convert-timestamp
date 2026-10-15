# 时间戳转化 —— 浏览器扩展常用命令
#
# 常用：make build（打 crx） / make server（起密码库服务器） / make native-install EXT_ID=<扩展ID>（装 Touch ID）

SHELL := /bin/bash
.DEFAULT_GOAL := help

VERSION   := $(shell python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
KEY       := dist/extension-key.pem
CC_DS     ?= $(HOME)/GitAIMessage/cc-ds.py
PORT      ?= 8000
VAULT_DIR ?= $(HOME)/.cc-ds
HOST_NAME := com.bit.timestamp_vault
HOST_DIR  := $(HOME)/Library/Application Support/$(HOST_NAME)
NM_DIRS   := "$(HOME)/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
             "$(HOME)/Library/Application Support/Microsoft Edge/NativeMessagingHosts"

.PHONY: help check build ext-id clean version server token backups \
        native-install native-uninstall vscode-package vscode-install

help: ## 显示这份帮助
	@echo "时间戳转化 v$(VERSION)"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-17s\033[0m %s\n", $$1, $$2}'

check: ## 检查 manifest 与 src/*.js 语法
	@python3 -c "import json; json.load(open('manifest.json'))"
	@for f in src/*.js; do node --check "$$f" || exit 1; done
	@echo "✅ manifest 与 JS 语法检查通过"

build: check ## 打包成 dist/*.crx（先跑语法检查）
	./build.sh

# crx 安装的扩展 ID 由私钥决定；「加载已解压的扩展」的 ID 由目录路径决定，以 chrome://extensions 显示为准
ext-id: ## 打印 crx 安装时的扩展 ID（由 dist/extension-key.pem 算出）
	@[ -f $(KEY) ] || { echo "❌ 没有 $(KEY)，先 make build"; exit 1; }
	@openssl rsa -in $(KEY) -pubout -outform DER 2>/dev/null | shasum -a 256 | head -c 32 | tr 0-9a-f a-p; echo

clean: ## 删掉打包产物（保留私钥 dist/extension-key.pem）
	rm -rf dist/ext dist/*.crx
	@echo "✅ 已清理，私钥保留"

version: ## 打印扩展版本
	@echo "$(VERSION)"

server: ## 启动密码库服务器 cc-ds.py（PORT=8000，CC_DS=路径 可覆盖）
	@[ -f "$(CC_DS)" ] || { echo "❌ 找不到 $(CC_DS)，用 CC_DS=<路径> 指定"; exit 1; }
	CC_DS_VAULT_DIR="$(VAULT_DIR)" python3 "$(CC_DS)" --port $(PORT)

token: ## 把密码库 Token 复制到剪贴板（填进扩展的「服务器设置」）
	@[ -f "$(VAULT_DIR)/vault-token" ] || { echo "❌ 还没有 Token，先 make server 启动一次"; exit 1; }
	@tr -d '\n' < "$(VAULT_DIR)/vault-token" | pbcopy
	@echo "✅ 已复制 $(VAULT_DIR)/vault-token 到剪贴板"

backups: ## 列出密码库历史版本（恢复：把某个文件复制成 ~/.cc-ds/vault.json）
	@ls -lt "$(VAULT_DIR)/backups" 2>/dev/null || echo "暂无备份"

native-install: ## 编译并注册 Touch ID 组件（EXT_ID=<扩展ID>，多个用空格分隔）
	@[ -n "$(EXT_ID)" ] || { echo "❌ 需要 EXT_ID=<扩展ID>，见 chrome://extensions；crx 安装的可用 make ext-id 查看"; exit 1; }
	native/install.sh $(EXT_ID)

native-uninstall: ## 卸载 Touch ID 组件并删除钥匙串里保存的密码库密钥
	@for d in $(NM_DIRS); do rm -fv "$$d/$(HOST_NAME).json"; done
	rm -rf "$(HOST_DIR)"
	-@security delete-generic-password -s $(HOST_NAME) -a vault-key >/dev/null 2>&1 && echo "已删除钥匙串条目 vault-key"
	-@security delete-generic-password -s $(HOST_NAME) -a biometry-state >/dev/null 2>&1 && echo "已删除钥匙串条目 biometry-state"
	@echo "✅ 已卸载；扩展里的 Touch ID 开关请在密码库设置中停用"

vscode-package: ## 打包 vs-code-plugin（SOL 价格插件）
	$(MAKE) -C vs-code-plugin package

vscode-install: ## 打包并安装 vs-code-plugin 到本机 VS Code
	$(MAKE) -C vs-code-plugin install

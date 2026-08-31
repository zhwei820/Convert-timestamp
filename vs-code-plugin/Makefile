# SOL 实时价格 —— VS Code 插件构建脚本
#
# 常用：make package（打 vsix） / make install（打好并装进 VS Code） / make dev（开调试窗口）

SHELL := /bin/bash
.DEFAULT_GOAL := help

NAME      := $(shell node -p "require('./package.json').name")
VERSION   := $(shell node -p "require('./package.json').version")
PUBLISHER := $(shell node -p "require('./package.json').publisher")
EXT_ID    := $(PUBLISHER).$(NAME)
VSIX      := dist/$(NAME)-$(VERSION).vsix
VSCE      := npx --yes @vscode/vsce

.PHONY: help deps typecheck package install uninstall dev clean version

help: ## 显示这份帮助
	@echo "$(NAME) v$(VERSION)"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

# 插件本身零运行时依赖，这里装的只是类型定义和 tsc（给编辑器提示 + make typecheck 用）
node_modules: package.json
	npm install
	@touch node_modules

deps: node_modules ## 安装开发依赖（仅类型定义，插件运行时零依赖）

typecheck: node_modules ## 对着真实的 vscode API 类型定义做检查
	npm run typecheck
	@echo "✅ 类型检查通过"

package: typecheck ## 打包成 dist/*.vsix（先跑类型检查）
	@mkdir -p dist
	$(VSCE) package --out $(VSIX)
	@echo
	@echo "✅ 已打包：$(VSIX)"
	@echo "   装进 VS Code：make install"

install: package ## 打包并装进本机 VS Code（--force 覆盖旧版本）
	@command -v code >/dev/null || { echo "❌ 找不到 code 命令：VS Code 里执行「Shell Command: Install 'code' command in PATH」"; exit 1; }
	code --install-extension $(VSIX) --force
	@echo "✅ 已安装 $(EXT_ID) v$(VERSION)，重启 VS Code 生效"

uninstall: ## 从本机 VS Code 卸载
	@command -v code >/dev/null || { echo "❌ 找不到 code 命令"; exit 1; }
	code --uninstall-extension $(EXT_ID)

dev: ## 开一个加载了本插件的调试窗口（等价于按 F5）
	@command -v code >/dev/null || { echo "❌ 找不到 code 命令"; exit 1; }
	code --extensionDevelopmentPath=$(CURDIR) --new-window

clean: ## 删掉打包产物
	rm -rf dist
	@echo "✅ 已清理 dist/"

version: ## 打印插件 id 和版本
	@echo "$(EXT_ID) v$(VERSION)"

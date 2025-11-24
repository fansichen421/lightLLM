#!/usr/bin/env bash
# 简要：将本地仓库推送到指定远程 https://github.com/fansichen421/lightLLM.git
# 使用：在 /home/steven/桌面/lightLLM 目录下执行：./push_to_github.sh "<commit message>"
# 说明：
#  - 若远程 origin 已存在，会将 origin 的 URL 更新为目标 URL。
#  - 若未暂存/提交更改，脚本会先执行 `git add -A` 和 `git commit -m "<commit message>"`（若未提供 commit message，会使用默认消息）。
#  - HTTPS 方式会在推送时要求凭证（建议使用 Personal Access Token），也可以先配置 SSH 并改用 git@github.com:... 的地址。
#  - 若想推送到 main 分支，请传入环境变量 TARGET_BRANCH，例如：TARGET_BRANCH=main ./push_to_github.sh "msg"
set -euo pipefail

REPO_URL="https://github.com/fansichen421/lightLLM.git"
TARGET_BRANCH="${TARGET_BRANCH:-master}"
COMMIT_MSG="${1:-auto: push local changes}"

# 确保在仓库根目录（有 .git）
if [ ! -d ".git" ]; then
  echo ".git not found. 请在仓库根目录 /home/steven/桌面/lightLLM 下运行此脚本。" >&2
  exit 1
fi

# 确保 git 可用
if ! command -v git >/dev/null 2>&1; then
  echo "git 未安装或不可用。" >&2
  exit 1
fi

# 切换到当前分支并获取分支名
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "当前分支: ${CURRENT_BRANCH}"

# 暂存并提交未提交的更改
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "检测到未提交更改，正在 add/commit..."
  git add -A
  # 如果没有暂存的变化不会创建空提交
  git commit -m "${COMMIT_MSG}" || true
else
  echo "无未提交更改。"
fi

# 设置或更新 origin remote
if git remote get-url origin >/dev/null 2>&1; then
  OLD_URL="$(git remote get-url origin)"
  if [ "${OLD_URL}" != "${REPO_URL}" ]; then
    echo "更新 origin 从 ${OLD_URL} 到 ${REPO_URL}"
    git remote set-url origin "${REPO_URL}"
  else
    echo "origin 已指向目标 URL"
  fi
else
  echo "添加 origin -> ${REPO_URL}"
  git remote add origin "${REPO_URL}"
fi

# 如果目标分支与当前分支不一致，按用户意图推送 current 或 TARGET_BRANCH
if [ "${CURRENT_BRANCH}" != "${TARGET_BRANCH}" ]; then
  echo "当前分支 (${CURRENT_BRANCH}) 与目标分支 (${TARGET_BRANCH}) 不同。将把当前分支推送为远程 ${TARGET_BRANCH}（远端分支名）。"
  git push -u origin "${CURRENT_BRANCH}:${TARGET_BRANCH}"
else
  echo "推送 ${CURRENT_BRANCH} 到 origin/${CURRENT_BRANCH}"
  git push -u origin "${CURRENT_BRANCH}"
fi

echo "推送完成。"

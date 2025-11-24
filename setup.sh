#!/usr/bin/env bash
# setup.sh — 自动化安装脚本 for lightLLM
# 用途：检测系统与 GPU，安装 ollama、ROCm（>=7.1）、conda 环境，pull 模型，创建目录，并可替换绝对路径
# 运行：
#   手动交互：./setup.sh
#   非交互（自动接受所有步骤）：./setup.sh -y

set -euo pipefail
IFS=$'\n\t'

# 默认行为：交互式。-y 无提示模式
ASSUME_YES=0
QUIET=0
while getopts ":yhq" opt; do
  case ${opt} in
    y ) ASSUME_YES=1 ;;
    q ) QUIET=1 ;;
    h ) echo "Usage: $0 [-y]"; exit 0 ;;
    \? ) echo "Invalid option: -$OPTARG" >&2; exit 1 ;;
  esac
done

ask() {
  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  if [ "$QUIET" -eq 1 ]; then
    return 1
  fi
  read -rp "$1 [y/N]: " ans
  case "$ans" in
    [Yy]* ) return 0 ;;
    * ) return 1 ;;
  esac
}

echoinfo(){ echo "[INFO] $*"; }
echowarn(){ echo "[WARN] $*"; }
echoerr(){ echo "[ERROR] $*" >&2; }

# 1. GPU 型号列表（支持 ROCm 7.1）
SUPPORTED_GPUS=(
  "AMD Instinct MI355X"
  "AMD Instinct MI350X"
  "AMD Instinct MI325X"
  "AMD Instinct MI300X"
  "AMD Instinct MI300A"
  "AMD Instinct MI250X"
  "AMD Instinct MI250"
  "AMD Instinct MI210"
  "AMD Instinct MI100"
  "AMD Radeon AI PRO R9700"
  "AMD Radeon PRO V710"
  "AMD Radeon PRO W7900 Dual Slot"
  "AMD Radeon PRO W7900"
  "AMD Radeon PRO W7800 48GB"
  "AMD Radeon PRO W7800"
  "AMD Radeon PRO W7700"
  "AMD Radeon PRO W6800"
  "AMD Radeon PRO V620"
  "AMD Radeon RX 9070 XT"
  "AMD Radeon RX 9070 GRE"
  "AMD Radeon RX 9070"
  "AMD Radeon RX 9060 XT"
  "AMD Radeon RX 9060"
  "AMD Radeon RX 7900 XTX"
  "AMD Radeon RX 7900 XT"
  "AMD Radeon RX 7900 GRE"
  "AMD Radeon RX 7800 XT"
  "AMD Radeon RX 7700 XT"
)

# helper to lowercase
lc(){ echo "$1" | tr '[:upper:]' '[:lower:]'; }

# detect GPU model via lspci or rocm-smi
detect_gpu_model(){
  if command -v rocm-smi >/dev/null 2>&1; then
    # 尝试 rocm-smi -i 输出
    GPU_INFO=$(rocm-smi -i 2>/dev/null || true)
    if [ -n "$GPU_INFO" ]; then
      echo "$GPU_INFO" | sed -n '1,200p'
      return 0
    fi
  fi
  if command -v lspci >/dev/null 2>&1; then
    lspci -nn | grep -i 'amd\|advanced micro devices' -A1 || true
  fi
}

match_supported_gpu(){
  local info="$1"
  if [ -z "$info" ]; then
    return 1
  fi
  for m in "${SUPPORTED_GPUS[@]}"; do
    # case-insensitive substring match
    if echo "$info" | grep -qi "$(echo "$m" | sed 's/\//\\\//g')"; then
      echo "$m"
      return 0
    fi
  done
  return 1
}

# check VRAM (approx) via rocm-smi or lshw
detect_vram_gb(){
  # try rocm-smi
  if command -v rocm-smi >/dev/null 2>&1; then
    v=$(rocm-smi --showhw | awk '/VRAM/ {print $3; exit}' || true)
    # rocm-smi output varies; try different parsing
    if [ -n "$v" ]; then
      # strip non-digits, convert MB/GB
      if echo "$v" | grep -qi 'gb'; then
        printf "%d" "$(echo "$v" | grep -oE '[0-9]+' )"
        return 0
      elif echo "$v" | grep -qi 'mb'; then
        mb=$(echo "$v" | grep -oE '[0-9]+' )
        gb=$(( (mb + 512) / 1024 ))
        printf "%d" "$gb"; return 0
      fi
    fi
  fi
  # try lshw
  if command -v lshw >/dev/null 2>&1; then
    v=$(lshw -C display 2>/dev/null | grep -i 'size' | head -n1 || true)
    if [ -n "$v" ]; then
      if echo "$v" | grep -qi 'gb'; then
        echo "$v" | grep -oE '[0-9]+' | head -n1
        return 0
      elif echo "$v" | grep -qi 'mb'; then
        mb=$(echo "$v" | grep -oE '[0-9]+' | head -n1)
        gb=$(( (mb + 512) / 1024 ))
        echo "$gb"; return 0
      fi
    fi
  fi
  # unknown
  echo "0"; return 1
}

# 2. 检查並安裝 ollama
ensure_ollama_installed(){
  if command -v ollama >/dev/null 2>&1; then
    echoinfo "ollama 已安装：$(command -v ollama)"
    return 0
  fi
  echoinfo "ollama 未检测到。准备安装 ollama。"
  if ask "是否现在运行 ollama 安装脚本？"; then
    echoinfo "运行：curl -fsSL https://ollama.com/install.sh | sh"
    curl -fsSL https://ollama.com/install.sh | sh
    echoinfo "请在安装完成后重新打开 shell 或按脚本提示操作以使 ollama 可用。"
  else
    echowarn "跳过 ollama 安装。"; return 1
  fi
}

# 3. 检查系统版本（只支持 Ubuntu 24.04 或 25.04）
check_os(){
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_NAME="$NAME"
    OS_VER="$VERSION_ID"
    echoinfo "检测到系统：$NAME $VERSION_ID"
    if [ "$ID" != "ubuntu" ]; then
      echoerr "仅支持 Ubuntu 24.04 或 25.04（检测到：$NAME $VERSION_ID）。"; return 2
    fi
    if [ "$VERSION_ID" != "24.04" ] && [ "$VERSION_ID" != "25.04" ]; then
      echoerr "仅支持 Ubuntu 24.04 或 25.04（检测到 $VERSION_ID）。"; return 2
    fi
    return 0
  else
    echoerr "/etc/os-release 未找到，无法判断系统版本。"; return 2
  fi
}

# 4. ROCm 版本检测与安装（检测 >= 7.1）
get_rocm_version(){
  # try reading /opt/rocm/.info or /opt/rocm/version
  if [ -f /opt/rocm/.info ]; then
    awk -F= '/ROCM_VERSION/ {print $2; exit}' /opt/rocm/.info || true
  fi
  if [ -f /opt/rocm/version ]; then
    cat /opt/rocm/version 2>/dev/null || true
  fi
  # try rocminfo
  if command -v rocminfo >/dev/null 2>&1; then
    rocminfo --version 2>/dev/null | head -n1 || true
  fi
  # try dpkg
  dpkg -l | awk '/rocm/ {print $3; exit}' || true
}

version_ge(){
  # compare two dot-separated version strings: returns 0 if $1 >= $2
  # e.g. version_ge 7.1 7.0
  printf '%s\n%s\n' "$1" "$2" | awk -F. '{for(i=1;i<=NF;i++){a[i]=$i}} END{for(i=1;i<=length(a);i++){if(a[i]>b[i]){print 0; exit} else if(a[i]<b[i]){print 1; exit}} print 0}' b="$2"
}

ensure_rocm(){
  local found_ver
  found_ver=$(get_rocm_version || true)
  echoinfo "检测到的 ROCm 版本信息: ${found_ver:-(none)}"
  # crude match for version number
  if echo "$found_ver" | grep -oE '[0-9]+\.[0-9]+' | head -n1 >/dev/null 2>&1; then
    v=$(echo "$found_ver" | grep -oE '[0-9]+\.[0-9]+' | head -n1)
    # compare v >= 7.1
    # fallback simpler compare
    req_major=7
    req_minor=1
    major=${v%%.*}
    minor=${v#*.}
    minor=${minor%%.*}
    if [ "$major" -gt "$req_major" ] || { [ "$major" -eq "$req_major" ] && [ "$minor" -ge "$req_minor" ]; }; then
      echoinfo "ROCm 版本满足（>=7.1）：$v"
      return 0
    fi
  fi

  echowarn "未检测到 ROCm >= 7.1，或版本过低。"
  if ask "是否尝试安装/更新 ROCm 到 7.1+（需要 sudo）？"; then
    echoinfo "将尝试安装/更新 ROCm。请确认目标系统为 Ubuntu 24.04/25.04。"
    # 官方安装通常需要添加 AMD 仓库并 apt install rocm-dkms 等
    echoinfo "示例安装命令（请根据官方 ROCm 指引确认）："
    cat <<'CMD'
# 示例（仅供参考）——请根据 AMD 官方文档调整
sudo apt update
sudo apt install -y wget gnupg ca-certificates
wget -qO - https://repo.radeon.com/rocm/rocm.gpg.key | sudo apt-key add -
# 添加 repo（以下 URL 需根据官方指引确认）
# echo "deb [arch=amd64] https://repo.radeon.com/rocm/apt/ubuntu/ ubuntu main" | sudo tee /etc/apt/sources.list.d/rocm.list
sudo apt update
sudo apt install -y rocm-dkms rocm-utils rocminfo
CMD
    echoinfo "上面是示例，安装过程中请按提示完成并重启机器以加载驱动。"
  else
    echoerr "跳过 ROCm 安装。某些功能可能不可用。"
    return 1
  fi
}

# 5. 模型推拉决策
pull_models(){
  # check if models exist
  have_gpt_oss=0; have_qwen=0
  if command -v ollama >/dev/null 2>&1; then
    if ollama list | grep -q 'gpt-oss:latest'; then have_gpt_oss=1; fi
    if ollama list | grep -q 'qwen3:4b'; then have_qwen=1; fi
  fi
  if [ "$have_gpt_oss" -eq 1 ] && [ "$have_qwen" -eq 1 ]; then
    echoinfo "两个模型都已安装。跳过模型拉取。"; return 0
  fi
  # detect vram
  vram_gb=$(detect_vram_gb || true)
  echoinfo "检测到 GPU 显存（近似）: ${vram_gb} GB"
  if [ "$vram_gb" -ge 16 ]; then
    # prefer gpt-oss
    if [ "$have_gpt_oss" -eq 0 ]; then
      if ask "显存 >=16GB，是否拉取 gpt-oss:latest？"; then
        echoinfo "执行: ollama pull gpt-oss:latest"; ollama pull gpt-oss:latest || echowarn "ollama pull gpt-oss 失败";
      fi
    fi
  else
    if [ "$have_qwen" -eq 0 ]; then
      if ask "显存 <16GB，是否拉取 qwen3:4b？"; then
        echoinfo "执行: ollama pull qwen3:4b"; ollama pull qwen3:4b || echowarn "ollama pull qwen3 失败";
      fi
    fi
  fi
}

# 6. 创建 ~/LightLLM
create_lightllm_dir(){
  mkdir -p "$HOME/LightLLM"
  echoinfo "已创建目录：$HOME/LightLLM"
}

# 7. Conda / Miniconda 与环境创建
ensure_conda_env(){
  # try conda
  if command -v conda >/dev/null 2>&1; then
    echoinfo "conda 已存在：$(command -v conda)"
  else
    echowarn "未检测到 conda/miniconda。"
    if ask "是否安装 Miniconda 到 \$HOME/miniconda（静默模式）？"; then
      tmp_installer="/tmp/miniconda_installer.sh"
      echoinfo "下载并安装 Miniconda..."
      curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o "$tmp_installer"
      bash "$tmp_installer" -b -p "$HOME/miniconda"
      rm -f "$tmp_installer"
      # initialize conda for current shell
      # shellcheck disable=SC1090
      source "$HOME/miniconda/etc/profile.d/conda.sh"
      echoinfo "Miniconda 已安装并初始化。"
    else
      echoerr "跳过 conda 安装。后续依赖安装可能失败。"; return 1
    fi
  fi

  # ensure conda is available in this shell
  if ! command -v conda >/dev/null 2>&1; then
    if [ -f "$HOME/miniconda/etc/profile.d/conda.sh" ]; then
      # shellcheck disable=SC1090
      source "$HOME/miniconda/etc/profile.d/conda.sh"
    fi
  fi

  # create env
  ENV_NAME=lightllm
  PYVER=3.11
  if conda env list | awk '{print $1}' | grep -q "^$ENV_NAME$"; then
    echoinfo "conda 环境 $ENV_NAME 已存在。"
  else
    echoinfo "创建 conda 环境 $ENV_NAME (python=$PYVER)"
    conda create -n "$ENV_NAME" python="$PYVER" -y
  fi
  echoinfo "激活环境 $ENV_NAME"
  # shellcheck disable=SC1090
  source "$(conda info --base)/etc/profile.d/conda.sh"
  conda activate "$ENV_NAME"

  # 安装依赖：如果仓库有 requirements.txt 或 pyproject/toml，优先使用
  if [ -f "requirements.txt" ]; then
    echoinfo "使用 requirements.txt 安装 pip 依赖"
    pip install -r requirements.txt
  elif [ -f "web/requirements.txt" ]; then
    echoinfo "使用 web/requirements.txt 安装 pip 依赖"
    pip install -r web/requirements.txt
  else
    echowarn "未找到 requirements.txt，跳过 pip 依赖安装。请手动安装需要的包。"
  fi
}

# 9. 打开防火墙（启用 ufw 并允许常用端口）
open_firewall(){
  if command -v ufw >/dev/null 2>&1; then
    echoinfo "将启用 UFW 并允许 22/80/443 端口"
    if ask "是否启用 UFW 并允许 22/80/443？"; then
      sudo ufw allow 22/tcp
      sudo ufw allow 80/tcp
      sudo ufw allow 443/tcp
      sudo ufw --force enable
      echoinfo "UFW 已启用。"
    else
      echowarn "跳过启用 UFW。";
    fi
  else
    echowarn "未检测到 ufw。可按需手动开启防火墙（如 iptables/nftables）。"
  fi
}

# 10. 修改绝对路径（交互式替换指定的绝对路径为 $HOME）
replace_absolute_paths(){
  echoinfo "查找仓库中可能的绝对路径（例如以 /home/ 或 /root/ 开头）并提供替换选项。"
  # 列出可能的文件（排除二进制）
  mapfile -t files < <(grep -RIl "\b/home/\|\b/root/" . || true)
  if [ ${#files[@]} -eq 0 ]; then
    echoinfo "未找到明显的绝对路径字符串。"
    return 0
  fi
  echo "找到如下文件包含可能的绝对路径："
  for f in "${files[@]}"; do echo "  $f"; done
  if ask "是否开始替换这些文件中出现的 /home/<user> 为 \$HOME（会做备份 .bak）？"; then
    for f in "${files[@]}"; do
      echoinfo "备份 $f -> $f.bak"; cp -a "$f" "$f.bak"
      sed -E "s#(/home/[A-Za-z0-9._-]+)(/[^[:space:]]*)?#\$HOME\2#g" "$f.bak" > "$f"
      echoinfo "已替换 $f（备份保存在 $f.bak）"
    done
    git add -A || true
    if git diff --cached --quiet; then
      echoinfo "没有需要提交的路径更改。"
    else
      if ask "是否提交这些路径替换更改到 git？"; then
        git commit -m "Replace absolute paths with $HOME in files" || echowarn "提交失败";
      fi
    fi
  else
    echowarn "跳过绝对路径替换。"
  fi
}

# 主流程
main(){
  echoinfo "开始 LightLLM 安装脚本流程"

  # 检查 OS
  if ! check_os; then
    echoerr "请使用受支持的 Ubuntu 版本后再运行此脚本。"
    # 仍继续，用户可选择跳过
  fi

  # 检测 GPU 型号
  gpu_info=$(detect_gpu_model || true)
  echoinfo "GPU 原始信息（短）："
  echo "$gpu_info" | sed -n '1,20p'
  matched=$(match_supported_gpu "$gpu_info" || true)
  if [ -n "$matched" ]; then
    echoinfo "检测到受支持 GPU： $matched"
  else
    echoerr "未检测到受支持的 GPU 型号（或无法检测）。列出的 GPU 支持 ROCm 7.1。"
    if ! ask "仍然继续吗？（如果继续，ROCm/驱动可能不受支持）"; then
      echoerr "退出安装。"
      exit 1
    fi
  fi

  # ollama
  ensure_ollama_installed || echowarn "ollama 可能未安装或安装被跳过。"

  # ROCm
  ensure_rocm || echowarn "ROCm 未安装或安装被跳过。"

  # 拉取模型
  if command -v ollama >/dev/null 2>&1; then
    pull_models
  else
    echowarn "ollama 不可用，跳过模型拉取。"
  fi

  # 创建目录
  create_lightllm_dir

  # conda env
  ensure_conda_env || echowarn "conda 环境创建/依赖安装被跳过或失败。"

  # 打开防火墙
  open_firewall || echowarn "防火墙设置被跳过或失败。"

  # 修改绝对路径
  replace_absolute_paths || echowarn "路径替换步骤出现问题或被跳过。"

  echoinfo "全部步骤完成（或已尽力）。请查看日志并根据需要重新运行带 -y 的无提示模式。"
}

main "$@"

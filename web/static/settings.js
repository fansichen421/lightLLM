const darkModeToggle = document.getElementById("dark-mode-toggle");
let toolSettings = JSON.parse(localStorage.getItem("toolSettings")) || {};
let customModelSelect = null;
// RAG 默认关闭：首次不存在时设为 false
if (!Object.prototype.hasOwnProperty.call(toolSettings, 'RAG')) {
  toolSettings['RAG'] = false;
  localStorage.setItem('toolSettings', JSON.stringify(toolSettings));
}

// 深色模式功能
function toggleDarkMode() {
  const isDarkMode = document.body.classList.toggle("dark-mode");
  localStorage.setItem("darkMode", isDarkMode);
  updateDarkModeIcon(isDarkMode);
}

function updateDarkModeIcon(isDarkMode) {
  const svg = darkModeToggle.querySelector("svg");
  if (isDarkMode) {
    // 月亮图标
    svg.innerHTML =
      '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="2" fill="none"/>';
  } else {
    // 太阳图标
    svg.innerHTML =
      '<path d="M12 16C14.2091 16 16 14.2091 16 12C16 9.79086 14.2091 8 12 8C9.79086 8 8 9.79086 8 12C8 14.2091 9.79086 16 12 16Z" stroke="currentColor" stroke-width="2"/><path d="M12 2V4" stroke="currentColor" stroke-width="2"/><path d="M12 20V22" stroke="currentColor" stroke-width="2"/><path d="M4.93 4.93L6.34 6.34" stroke="currentColor" stroke-width="2"/><path d="M17.66 17.66L19.07 19.07" stroke="currentColor" stroke-width="2"/><path d="M2 12H4" stroke="currentColor" stroke-width="2"/><path d="M20 12H22" stroke="currentColor" stroke-width="2"/><path d="M6.34 17.66L4.93 19.07" stroke="currentColor" stroke-width="2"/><path d="M19.07 4.93L17.66 6.34" stroke="currentColor" stroke-width="2"/>';
  }
}

// 初始化深色模式
function initDarkMode() {
  const savedDarkMode = localStorage.getItem("darkMode");
  const prefersDarkMode = window.matchMedia(
    "(prefers-color-scheme: dark)"
  ).matches;

  // 优先使用用户保存的设置，其次使用系统偏好
  if (savedDarkMode === "true" || (savedDarkMode === null && prefersDarkMode)) {
    document.body.classList.add("dark-mode");
    updateDarkModeIcon(true);
  }
}

// 加载模型列表
async function loadModelList() {
  try {
    const response = await fetch("/data/model_list.json");
    if (!response.ok) {
      throw new Error("网络响应不正常");
    }
    const modelList = await response.json();

    // 获取select元素
    const modelSelect = document.getElementById("model-select");

    // 清空现有的选项
    modelSelect.innerHTML = "";

    // 遍历模型列表，为每个模型创建一个选项
    Object.entries(modelList).forEach(([displayName, modelData]) => {
      const option = document.createElement("option");
      option.value = modelData.model_id;
      option.textContent = displayName;
      modelSelect.appendChild(option);
    });

    // 可以触发change事件，以便其他依赖于模型选择的代码能够执行
    modelSelect.dispatchEvent(new Event("change"));

    // 恢复保存的模型设置
    const savedModel = localStorage.getItem("selectedModel");
    if (
      savedModel &&
      modelSelect.querySelector(`option[value="${savedModel}"]`)
    ) {
      modelSelect.value = savedModel;
    }

    
    if (!customModelSelect) {
      customModelSelect = new CustomSelect(modelSelect);
    } else {
      try {
        customModelSelect.refresh();
      } catch (e) {
        // fallback: recreate if refresh fails
        customModelSelect = new CustomSelect(modelSelect);
      }
    }

    // 返回模型列表
    return modelList;
  } catch (error) {
    const modelSelect = document.getElementById("model-select");
    modelSelect.innerHTML = '<option value="">加载模型列表失败</option>';
    return {};
  }
}

// 加载工具列表
async function loadToolList() {
  try {
    // 获取工具列表
    let response;

    response = await fetch(`/tool_list`, { method: "POST" });

    const result = await response.json();

    // 检查响应状态
    if (result.status !== "success") {
      throw new Error(result.message || "获取工具列表失败");
    }

    // 获取实际的工具列表
    let toolList = result.tools;
    // 保证'RAG'始终在工具列表中
    if (!toolList.includes('RAG')) {
      toolList.unshift('RAG');
    }
    // 遍历工具列表，为每个工具创建一个选项
    const toolsContainer = document.getElementById("tools-container");
    toolsContainer.innerHTML = ""; // 清空现有内容

    // 遍历工具列表
    toolList.forEach((toolName) => {
      const toolElement = document.createElement("div");
      const isEnabled = toolSettings[toolName] === true;
      toolElement.innerHTML = `
              <div class="tool-item">
                  <span class="tool-name">${toolName}</span>
                  <div class="tool-switch ${
                    isEnabled ? "active" : ""
                  }" data-tool="${toolName}"></div>
              </div>
`;

      const switchElement = toolElement.querySelector(".tool-switch");
      switchElement.addEventListener("click", () => toggleTool(toolName));

      toolsContainer.appendChild(toolElement);
    });
    return toolList;
  } catch (error) {
    console.error("加载工具列表时出错:", error);
  }
}
// 切换工具
function toggleTool(toolName) {
  const switchEl = document.querySelector(`.tool-switch[data-tool="${toolName}"]`);
  // 如果滑块被禁用，则忽略点击
  if (!switchEl || switchEl.classList.contains("disabled")) return;
  const is_enable = !switchEl.classList.contains("active");
  if (is_enable) {
    toolSettings[toolName] = true;
  } else {
    toolSettings[toolName] = false;
  }
  // 更新切换按钮
  switchEl.classList.toggle("active");
  // 保存工具设置
  localStorage.setItem("toolSettings", JSON.stringify(toolSettings));
}

// 上传RAG文件按钮逻辑
document.addEventListener("DOMContentLoaded", function () {
  const uploadBtn = document.getElementById("upload-rag-btn");
  const fileInput = document.getElementById("upload-rag-file");
  if (uploadBtn && fileInput) {
    uploadBtn.onclick = () => fileInput.click();
    fileInput.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // 同步到全局 `file-input`（如果存在），兼容主上传逻辑
      try {
        const mainFileInput = document.getElementById("file-input");
        if (mainFileInput) {
          const dt = new DataTransfer();
          dt.items.add(file);
          mainFileInput.files = dt.files;
          mainFileInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (err) {
        console.warn('无法同步文件到主 input:', err);
      }
      uploadBtn.textContent = "上传中...";
      uploadBtn.disabled = true;
      try {
        const formData = new FormData();
        // 后端兼容旧路径，但仍期望字段名为 'files'
        formData.append("files", file);
        const resp = await fetch("/rag/upload", {
          method: "POST",
          body: formData,
        });
        const result = await resp.json();
        if (resp.ok && result.status === 'success') {
          uploadBtn.textContent = "上传并构建完成！";
          setTimeout(() => {
            uploadBtn.textContent = "上传RAG文件";
            uploadBtn.disabled = false;
          }, 1500);
        } else {
          uploadBtn.textContent = result.message || "上传失败";
          setTimeout(() => {
            uploadBtn.textContent = "上传RAG文件";
            uploadBtn.disabled = false;
          }, 1500);
        }
      } catch (err) {
        uploadBtn.textContent = "网络错误";
        setTimeout(() => {
          uploadBtn.textContent = "上传RAG文件";
          uploadBtn.disabled = false;
        }, 1200);
      }
      fileInput.value = "";
    };
  }
});

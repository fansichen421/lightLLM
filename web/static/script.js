const defaultMessages = [
  { role: "system", content: "你是AI助手，请确保回答尽可能简洁。\n如果有可用的工具，请自行判断是否有必要使用。" },
  { role: "assistant", content: "您好！我是AI助手，有什么可以帮助您的吗？" },
];

let ws = null;
let isConnected = false;
let currentAiMessage = null;
let currentAiMessageContent = "";
let currentThinking = null;
let isTyping = false;
let hasReceivedFirstChunk = false;
let thinkingStartTime = null;       
let thinkingTimer = null;
let thinkingStatusElement = null;
// 最短显示 thinking 面板的毫秒数，避免出现 0s 闪烁
const THINKING_MIN_VISIBLE_MS = 800;
let thinkingShownAt = null;
let isGenerating = false;
let userId = localStorage.getItem("userId");
let messageTree = MessageTree.fromMessages(defaultMessages);
let modelList = null;
let customThinkingSelect = null;

// 检查是否为本地 ollama 模型
function isLocalOllamaModel() {
  const select = document.getElementById("model-select");
  if (!modelList || !select || !select.selectedOptions.length) {
    return false;
  }
  const selectedText = select.selectedOptions[0].textContent || "";
  const info = modelList[selectedText];
  const baseUrl = info?.base_url || "";
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
}

// 检查是否为思考模型（支持 enabled 或 auto 模式）
function isThinkingModel() {
  const select = document.getElementById("model-select");
  if (!modelList || !select || !select.selectedOptions.length) {
    return false;
  }
  const selectedText = select.selectedOptions[0].textContent || "";
  const info = modelList[selectedText];
  const thinkingModes = info?.thinking_modes || [];
  return thinkingModes.some(mode => mode === "enabled" || mode === "auto");
}

function isLocalModelSelected() {
  return isLocalOllamaModel();
}

function updateRagUIByToolSwitch() {
  // 工具滑块控制 RAG 区和输入区显示
  const ragChat = document.getElementById("rag-chat");
  const inputArea = document.querySelector(".input-area");
  const sendButton = document.getElementById("send-button");
  const ragSwitch = document.querySelector('.tool-switch[data-tool="RAG"]');
  const isRagOn = ragSwitch && ragSwitch.classList.contains("active");
  if (ragChat) ragChat.style.display = isRagOn ? "" : "none";
  if (inputArea) inputArea.style.display = isRagOn ? "none" : "";
  if (sendButton) sendButton.style.display = isRagOn ? "none" : "";
}

// 获取当前选择的模型和思考模式
function getCurrentModelSettings() {
  const select = document.getElementById("model-select");
  const selectedText = select.selectedOptions[0].textContent;
  const modelInfo = modelList[selectedText];
  
  const isLocal = isLocalOllamaModel();
  const isThinking = isThinkingModel();
  
  let thinkingMode = document.getElementById("thinking-mode-select").value;
  
  // 如果是本地 ollama 非思考模型，强制禁用 reasoning
  if (isLocal && !isThinking) {
    thinkingMode = "disabled";
  }
  
  return {
    model: select.value,
    base_url: modelInfo.base_url,
    thinkingMode: thinkingMode,
    temperature: document.getElementById("temperature-slider").value,
    frequencyPenalty: document.getElementById("frequency-penalty-slider").value,
    isLocalOllamaModel: isLocal,
    isThinkingModel: isThinking,
  };
}

function sendMessage() {
  if (!isConnected) return;

  isGenerating = true;
  updateSendButton(true);
  hasReceivedFirstChunk = false;
  // 清理旧的思考面板，防止 reasoning 内容堆积
  try {
    if (currentThinking && currentThinking.parentNode) {
      currentThinking.parentNode.removeChild(currentThinking);
    }
  } catch (e) {}
  currentThinking = null;
  thinkingStatusElement = null;
  thinkingStartTime = null;
  thinkingShownAt = null;
  if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }

  const settings = getCurrentModelSettings();
  ws.send(
    JSON.stringify({
      messages: messageTree.getMessages(),
      model: settings.model,
      base_url: settings.base_url,
      thinking_mode: settings.thinkingMode,
      temperature: parseFloat(settings.temperature),
      frequency_penalty: parseFloat(settings.frequencyPenalty),
      tool_settings: toolSettings,
    })
  );
  showTypingIndicator();
}

// 发送消息
function sendMessageFromInputArea() {
  if (isGenerating) {
    stopGeneration();
    return;
  }

  const messageInput = document.getElementById("message-input");
  const messageText = messageInput.value.trim();
  if (!messageText) {
    return;
  }
  
  // 移除自动启用 RAG 的逻辑，保持用户选择
  
  scrollToBottom();

  let tempMessage = { role: "user", content: messageText };
  const newMessageNode = messageTree.pushBack(tempMessage);
  createUserMessage(newMessageNode);
  sendMessage();

  messageInput.value = "";
  messageInput.focus();
  messageInput.style.height = "auto";
}

// 停止生成函数
function stopGeneration() {
  // 使用fetch但不等待响应
  fetch(`/stop_generation/${userId}`, {
    method: "POST",
    keepalive: true, // 确保请求在页面卸载时也能发送
  }).catch((error) => {
    // 捕获可能的错误但不处理
    console.error("Stop generation request failed:", error);
  });

  // 立即更新UI状态
  isGenerating = false;
  updateSendButton(false);
  if (thinkingStatusElement && thinkingStartTime) {
    thinkingStatusElement.textContent = `思考已停止`;
  }
}

// 显示"正在输入"指示器
function showTypingIndicator() {
  if (isTyping) return;

  const typingDiv = document.createElement("div");
  typingDiv.className = "typing-indicator";
  typingDiv.id = "typing-indicator";

  const dotsDiv = document.createElement("div");
  dotsDiv.className = "typing-dots";

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.className = "typing-dot";
    dotsDiv.appendChild(dot);
  }

  typingDiv.appendChild(dotsDiv);
  const messagesContainer = document.getElementById("messages");
  messagesContainer.appendChild(typingDiv); // 先添加到容器末尾
  isTyping = true;
  scrollToBottomIfAtEnd();
}

function scrollToBottomIfAtEnd() {
  const tolerance = 50; // px 容差
  messagesContainer = document.getElementById("messages");
  const isAtBottom =
    messagesContainer.scrollHeight -
      messagesContainer.scrollTop -
      messagesContainer.clientHeight <=
    tolerance;
  if (isAtBottom) {
    scrollToBottom();
  }
}

function scrollToBottom() {
  const messagesContainer = document.getElementById("messages");
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// 创建用户消息
function createUserMessage(node) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message user-message";
  const text = node.content;

  renderMessageWithMath(messageDiv, text);

  const messagesContainer = document.getElementById("messages");
  messagesContainer.appendChild(messageDiv);

  const buttonContainer = document.createElement("div");
  buttonContainer.className = "message-buttons";

  const parentIndex = messageTree.parentMap[node.index];
  const parentNode = messageTree.messageNodes[parentIndex];

  const copyBtn = document.createElement("button");
  copyBtn.className = "edit-btn"; // 并非bug
  copyBtn.innerHTML = `
  <svg xmlns="http://www.w3.org/2000/svg" 
       width="14" height="14" viewBox="0 0 24 24" 
       fill="none" stroke="currentColor" 
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
`;

  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" 
           width="14" height="14" viewBox="0 0 24 24" 
           fill="none" stroke="currentColor" 
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
      setTimeout(() => {
        copyBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" 
             width="14" height="14" viewBox="0 0 24 24" 
             fill="none" stroke="currentColor" 
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
      }, 1500);
    });
  });

  const editBtn = document.createElement("button");
  editBtn.className = "edit-btn";
  editBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>`;
  editBtn.addEventListener("click", () => {
    // 保存原始内容
    const originalContent = messageDiv.innerHTML;

    // 创建编辑区域
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.className = "textarea";

    // 创建按钮容器
    const editControls = document.createElement("div");
    editControls.style.display = "flex";
    editControls.style.gap = "8px";
    editControls.style.marginTop = "10px";

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "确定";
    confirmBtn.className = "confirm-btn";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.className = "cancel-btn";

    // 替换消息内容为编辑模式
    messageDiv.innerHTML = "";
    messageDiv.appendChild(textarea);
    messageDiv.appendChild(editControls);
    editControls.appendChild(confirmBtn);
    editControls.appendChild(cancelBtn);

    // 自动聚焦到文本区域
    textarea.focus();
    textarea.select();

    // 确定按钮事件
    confirmBtn.addEventListener("click", () => {
      const editedText = textarea.value.trim();
      if (editedText) {
        const editedMessage = { content: editedText, role: "user" };
        messageTree.pushMessage(parentIndex, editedMessage);
        renderMessages();
        sendMessage();
      } else {
        // 如果为空，恢复原始内容
        messageDiv.innerHTML = originalContent;
      }
    });

    // 取消按钮事件
    cancelBtn.addEventListener("click", () => {
      messageDiv.innerHTML = originalContent;
    });

    // 按Enter保存，按Escape取消
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        confirmBtn.click();
      } else if (e.key === "Escape") {
        cancelBtn.click();
      }
    });
  });

  const prevBranchBtn = document.createElement("button");
  prevBranchBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 19l-7-7 7-7"></path>
            </svg>`;
  prevBranchBtn.className = "edit-btn";
  prevBranchBtn.addEventListener("click", () => {
    parentNode.selectedChildIndex -= 1;
    renderMessages();
    prevBranchBtn.disabled = !(parentNode.selectedChildIndex > 0);
    nextBranchBtn.disabled = !(
      parentNode.selectedChildIndex <
      parentNode.children.length - 1
    );
  });

  const selectedMessageIndex = document.createElement("div");
  const totalBranches = parentNode.children.length;
  selectedMessageIndex.innerHTML = `${
    parentNode.selectedChildIndex + 1
  }/${totalBranches}`;
  selectedMessageIndex.className = "selected-message-index";

  const nextBranchBtn = document.createElement("button");
  nextBranchBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 5l7 7-7 7"></path>
            </svg>`;
  nextBranchBtn.className = "edit-btn";
  nextBranchBtn.addEventListener("click", () => {
    parentNode.selectedChildIndex += 1;
    renderMessages();
    prevBranchBtn.disabled = !(parentNode.selectedChildIndex > 0);
    nextBranchBtn.disabled = !(
      parentNode.selectedChildIndex <
      parentNode.children.length - 1
    );
  });

  if (totalBranches > 1) {
    prevBranchBtn.disabled = !(parentNode.selectedChildIndex > 0);
    nextBranchBtn.disabled = !(
      parentNode.selectedChildIndex <
      parentNode.children.length - 1
    );
    buttonContainer.appendChild(prevBranchBtn);
    buttonContainer.appendChild(selectedMessageIndex);
    buttonContainer.appendChild(nextBranchBtn);
  }

  buttonContainer.appendChild(copyBtn);
  buttonContainer.appendChild(editBtn);
  messagesContainer.appendChild(buttonContainer);
  scrollToBottomIfAtEnd();

  return messageDiv;
}

// 创建AI消息
function createAiMessage(text = "") {
  currentAiMessage = document.createElement("div");
  currentAiMessage.className = "message ai-message";
  renderMessageWithMath(currentAiMessage, text);
  messagesContainer = document.getElementById("messages");
  messagesContainer.appendChild(currentAiMessage);
  scrollToBottomIfAtEnd();
  return currentAiMessage;
}

// 创建工具消息
function createToolMessage(text) {
  const toolMessage = document.createElement("div");
  toolMessage.className = "message tool-message ai-message";
  toolMessage.textContent = text;

  const typingIndicator = document.getElementById("typing-indicator");
  const messagesContainer = document.getElementById("messages");

  // 如果存在"正在输入"指示器，将tool元素插入到它前面
  if (typingIndicator) {
    typingIndicator.parentNode.insertBefore(toolMessage, typingIndicator);
  } else {
    // 否则添加到容器末尾
    messagesContainer.appendChild(toolMessage);
  }
  scrollToBottomIfAtEnd();
  return currentAiMessage;
}

// 通过messages列表渲染整个消息区
function renderMessages() {
  const messagesContainer = document.getElementById("messages");
  messagesContainer.innerHTML = "";
  let node = messageTree.root;
  while (node != null) {
    if (node.content === "")
      node = messageTree.messageNodes[node.getActiveChild()];
    if (node.role === "user") {
      createUserMessage(node);
    } else if (node.role === "assistant") {
      createAiMessage(node.content);
    } else if (node.role === "tool") {
      createToolMessage("已调用工具");
    }
    node = messageTree.messageNodes[node.getActiveChild()];
  }
}

// 清空对话记录
function clearMessages() {
  const messagesContainer = document.getElementById("messages");
  const chatHeader = document.getElementById("chat-header");
  chatHeader.innerHTML = "新对话";
  // 清理标题
  messageTree.title = null;
  // 保留第一条欢迎消息
  const welcomeMessage = messagesContainer.querySelector(".ai-message");
  messageTree = MessageTree.fromMessages(defaultMessages);
  messagesContainer.innerHTML = "";
  if (welcomeMessage) {
    messagesContainer.appendChild(welcomeMessage);
  }

  // 重置状态
  resetAiMessageState();
  updateSendButton(false);
}

// 重置AI消息状态
function resetAiMessageState() {
  currentAiMessage = null;
  currentAiMessageContent = "";
  // 延迟移除 thinking DOM，确保最短可见时长，避免闪烁
  try {
    if (currentThinking) {
      // 如果已被标记为 sticky（思考已完成并需保留），则不自动移除
      if (currentThinking.classList && currentThinking.classList.contains('sticky')) {
        // 保留面板，退出
      } else {
        const el = currentThinking;
        const shownAt = thinkingShownAt || thinkingStartTime || 0;
        const elapsed = Date.now() - shownAt;
        const remaining = Math.max(0, THINKING_MIN_VISIBLE_MS - elapsed);
        setTimeout(() => {
          try {
            if (el && el.parentNode) el.parentNode.removeChild(el);
          } catch (e) {}
        }, remaining);
      }
    }
  } catch (e) {}
  currentThinking = null;
  isTyping = false;
  hasReceivedFirstChunk = false;

  // 停止思考计时器
  if (thinkingTimer) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  thinkingStartTime = null;
  thinkingShownAt = null;
  // 清理前端聚合缓存（如果已定义）
  try { if (window && typeof window.__ws_clear_aggregate === 'function') window.__ws_clear_aggregate(); } catch (e) {}
}

// 更新发送按钮状态
function updateSendButton(isPause) {
  const sendButton = document.getElementById("send-button");
  const svg = sendButton.querySelector("svg");

  if (isPause) {
    // 暂停图标
    svg.innerHTML =
      '<rect x="6" y="6" width="12" height="12" fill="currentColor"/>';
    sendButton.classList.add("pause-state");
  } else {
    // 发送图标
    svg.innerHTML = `<svg width="25" height="25" viewBox="0 0 24 24" fill="none">
              <path
                d="M20 4L11 13"
                stroke="white"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M20 4L13 20L11 13L4 11L20 4Z"
                stroke="white"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>`;
    sendButton.classList.remove("pause-state");
  }
}

document.addEventListener("click", (e) => {
  const sidebar = document.getElementById("sidebar");
  const menuButton = document.getElementById("menu-toggle");
  const historySidebar = document.getElementById("history");
  const historyToggle = document.getElementById("history-toggle");

  if (
    sidebar.classList.contains("open") &&
    !sidebar.contains(e.target) &&
    !menuButton.contains(e.target)
  ) {
    sidebar.classList.remove("open");
  }
  if (
    historySidebar.classList.contains("open") &&
    !historyToggle.contains(e.target) &&
    !historySidebar.contains(e.target)
  ) {
    historySidebar.classList.remove("open");
  }
});

// 监听浏览器返回事件
window.addEventListener("popstate", (event) => {
  const sidebar = document.getElementById("sidebar");
  const historySidebar = document.getElementById("history");

  // 如果任一侧边栏是打开状态，则关闭它
  if (sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
    // 阻止默认的返回行为
    window.history.pushState(null, null, location.href);
  } else if (historySidebar.classList.contains("open")) {
    historySidebar.classList.remove("open");
    // 阻止默认的返回行为
    window.history.pushState(null, null, location.href);
  }
});

// 当打开侧边栏时，添加一个新的历史记录
function openSidebar(sidebarElement) {
  sidebarElement.classList.add("open");
  // 添加一个新的历史记录，这样用户按返回键时会触发popstate事件
  window.history.pushState(null, null, location.href);
}

document.addEventListener("DOMContentLoaded", function () {
  // 获取DOM元素
  const chatHeader = document.getElementById("chat-header");
  const messagesContainer = document.getElementById("messages");
  const messageInput = document.getElementById("message-input");
  const sendButton = document.getElementById("send-button");
  const statusElement = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const connectionInfo = document.getElementById("connection-info");
  const clearBtn = document.getElementById("clear-btn");
  const temperatureSlider = document.getElementById("temperature-slider");
  const temperatureValue = document.getElementById("temperature-value");
  const frequencyPenaltySlider = document.getElementById(
    "frequency-penalty-slider"
  );
  const frequencyPenaltyValue = document.getElementById(
    "frequency-penalty-value"
  );
  const menuToggle = document.getElementById("menu-toggle");
  const sidebar = document.getElementById("sidebar");
  const historyToggle = document.getElementById("history-toggle");
  const historySidebar = document.getElementById("history");

  async function initHeader() {
    const header = document.getElementById("header");
    const title = "ai.shanghaitech.online";
    let delay = 30;

    // 清空header内容
    header.textContent = "";

    // 逐个字符显示
    for (let char of title) {
      // 添加当前字符
      header.textContent += char;
      // 等待 delay 毫秒
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay += 4;
    }
  }

  menuToggle.addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar.classList.contains("open")) {
      openSidebar(sidebar);
    }
  });

  historyToggle.addEventListener("click", () => {
    const historySidebar = document.getElementById("history");
    if (!historySidebar.classList.contains("open")) {
      openSidebar(historySidebar);
    }
  });

  sendButton.disabled = true;

  // 初始化WebSocket连接
  function connectWebSocket() {
    // 获取WebSocket URL（根据当前页面地址自动确定）
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = function () {
        ws.send(JSON.stringify({ type: "init", userId: userId }));
        console.log("WebSocket连接已建立");
        // 初始化页面内的 WS 调试面板（可见）
        try {
          if (!document.getElementById('ws-debug-panel')) {
            const dbg = document.createElement('div');
            dbg.id = 'ws-debug-panel';
            dbg.style.position = 'fixed';
            dbg.style.right = '12px';
            dbg.style.bottom = '12px';
            dbg.style.width = '320px';
            dbg.style.maxHeight = '40vh';
            dbg.style.overflow = 'auto';
            dbg.style.background = 'rgba(0,0,0,0.7)';
            dbg.style.color = '#fff';
            dbg.style.fontSize = '12px';
            dbg.style.padding = '8px';
            dbg.style.borderRadius = '8px';
            dbg.style.zIndex = 99999;
            dbg.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
            dbg.innerHTML = '<div style="font-weight:600;margin-bottom:6px">WS Debug</div>';
            const clearBtn = document.createElement('button');
            clearBtn.textContent = 'Clear';
            clearBtn.style.fontSize = '11px';
            clearBtn.style.marginLeft = '8px';
            clearBtn.onclick = () => { dbg.innerHTML = '<div style="font-weight:600;margin-bottom:6px">WS Debug</div>'; };
            dbg.appendChild(clearBtn);
            document.body.appendChild(dbg);
          }
        } catch (e) { /**/ }
        isConnected = true;
        updateStatus("connected", "已连接");
      };

      ws.onmessage = function (event) {
        const data = JSON.parse(event.data);
        try {
          console.log("WS RECV:", data);
        } catch (e) {
          // ignore console issues
        }
        // 将收到的消息也写入页面内的调试面板，便于无 DevTools 环境排查
        try {
          const dbg = document.getElementById('ws-debug-panel');
          if (dbg) {
            const row = document.createElement('div');
            row.style.padding = '4px 0';
            row.style.borderTop = '1px solid rgba(255,255,255,0.06)';
            row.textContent = (new Date()).toLocaleTimeString() + ' ' + (data.type || '') + ' ' + (typeof data.data === 'string' ? data.data.slice(0,200) : JSON.stringify(data.data).slice(0,200));
            dbg.appendChild(row);
            dbg.scrollTop = dbg.scrollHeight;
          }
        } catch (e) { /**/ }
        if (data.type === "chunk") {
          // 处理流式文本块
          if (!hasReceivedFirstChunk) {
            // 第一次收到chunk时，移除"正在输入"指示器并创建AI消息
            removeTypingIndicator();
            createAiMessage();
            hasReceivedFirstChunk = true;

            // 收到第一个 chunk 时，标记思考框为完成状态
            if (currentThinking) {
              currentThinking.classList.add('sticky');
              if (thinkingStatusElement && thinkingStartTime) {
                const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
                thinkingStatusElement.textContent = `已思考 ${elapsed}秒`;
              }
            }

            if (thinkingTimer) {
              clearInterval(thinkingTimer);
              thinkingTimer = null;
            }
          }

          // 添加文本块到当前AI消息（使用前端聚合以合并短片段，减少渲染抖动）
          const chunkText = String(data.data || '');
          if (aggregateConfig && aggregateConfig.enabled) {
            // 立即刷新的条件：片段本身较长、包含换行或以句末标点收尾
            const maxChars = aggregateConfig.maxChars || 6;
            const immediate = chunkText.length >= maxChars || /\r?\n/.test(chunkText) || /[。！？.!?]\s*$/.test(chunkText);
            _aggregateBuffer += chunkText;
            if (immediate || _aggregateBuffer.length >= maxChars) {
              _flushAggregate();
            } else {
              _scheduleAggregateFlush();
            }
          } else {
            if (currentAiMessage) {
              currentAiMessageContent += chunkText;
              renderMessageWithMath(currentAiMessage, currentAiMessageContent);
            }
            scrollToBottomIfAtEnd();
          }
        } else if (data.type === "reasoning") {
          try { console.log('WS: reasoning frame received', data.data); } catch (e) {}
          
          // 检查当前模型设置，如果是本地非思考模型或思考模式被禁用，则忽略 reasoning
          const settings = getCurrentModelSettings();
          if ((settings.isLocalOllamaModel && !settings.isThinkingModel) || 
              settings.thinkingMode === "disabled") {
            try { console.log('WS: reasoning ignored - model does not support or disabled'); } catch (e) {}
            return;
          }
          
          // 过滤不可见字符（如零宽空格）并忽略空的 reasoning 分片，避免无意义的闪烁
          const rawReasoning = String(data.data || "");
          const cleaned = rawReasoning.replace(/[\u0000-\u001F\u007F\u200B\uFEFF]/g, "").replace(/\s/g, "");
          if (!rawReasoning || cleaned === "") {
            try { console.log('WS: reasoning frame ignored (empty or invisible)'); } catch (e) {}
            return;
          }

          if (!currentThinking) {
            currentThinking = document.createElement("div");
            currentThinking.className = "thinking";

            // header：状态 + 折叠按钮
            const header = document.createElement("div");
            header.className = "thinking-header";

            thinkingStatusElement = document.createElement("div");
            thinkingStatusElement.className = "thinking-status";
            thinkingStatusElement.textContent = "思考中";

            const toggleBtn = document.createElement("span");
            toggleBtn.className = "thinking-toggle";
            toggleBtn.textContent = "展开 ▼";

            header.appendChild(thinkingStatusElement);
            header.appendChild(toggleBtn);

            currentThinking.appendChild(header);

            // 内容容器
            const thinkingContent = document.createElement("div");
            thinkingContent.className = "thinking-content";
            currentThinking.appendChild(thinkingContent);

            // 切换逻辑
            toggleBtn.addEventListener("click", () => {
              if (thinkingContent.classList.contains("open")) {
                // 收起
                thinkingContent.style.maxHeight =
                  thinkingContent.scrollHeight + "px"; // 先固定当前高度
                requestAnimationFrame(() => {
                  thinkingContent.style.maxHeight = "0px"; // 再收起动画
                  thinkingContent.classList.remove("open");
                });
                toggleBtn.textContent = "展开 ▼";
              } else {
                // 展开
                thinkingContent.classList.add("open");
                thinkingContent.style.maxHeight =
                  thinkingContent.scrollHeight + "px";
                toggleBtn.textContent = "收起 ▲";

                // 动画结束后清除内联 style，避免影响后续内容更新
                thinkingContent.addEventListener(
                  "transitionend",
                  () => {
                    if (thinkingContent.classList.contains("open")) {
                      thinkingContent.style.maxHeight = "none";
                    }
                  },
                  { once: true }
                );
              }
            });

            // 插入到消息流里
            const typingIndicator = document.getElementById("typing-indicator");
            if (typingIndicator) {
              typingIndicator.parentNode.insertBefore(
                currentThinking,
                typingIndicator
              );
            } else {
              messagesContainer.appendChild(currentThinking);
            }

            // 默认展开思考内容，避免只显示 header 看似为空的闪烁
            try {
              thinkingContent.classList.add('open');
              thinkingContent.style.maxHeight = 'none';
              toggleBtn.textContent = '收起 ▲';
            } catch (e) {}

            thinkingStartTime = Date.now();
            thinkingShownAt = Date.now();
            thinkingTimer = setInterval(updateThinkingStatus, 1000);
          }

          // 写入内容（使用 text nodes 逐行追加，避免 innerHTML 引起的不可见/转义问题）
          const thinkingContent = currentThinking.querySelector(".thinking-content");
          try {
            // 强制可见样式
            thinkingContent.style.whiteSpace = 'pre-wrap';
            thinkingContent.style.display = 'block';
            thinkingContent.style.minHeight = '18px';

            const text = String(data.data || '');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              const tn = document.createTextNode(lines[i]);
              thinkingContent.appendChild(tn);
              if (i < lines.length - 1) thinkingContent.appendChild(document.createElement('br'));
            }

            try { console.log('RENDER_REASONING appended length', text.length); } catch (e) {}
            currentThinking.style.display = 'block';
            currentThinking.classList.add('has-content');
          } catch (e) {
            console.error('Failed to render reasoning content', e);
          }
          scrollToBottomIfAtEnd();
        } else if (data.type === "tool_call") {
          // 停止计时器并更新最终状态
          if (thinkingTimer) {
            clearInterval(thinkingTimer);
            thinkingTimer = null;
          }

          if (thinkingStatusElement && thinkingStartTime) {
            const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
            thinkingStatusElement.textContent = `已思考 ${elapsed}秒`;
          }
          tempMessage = {
            role: "tool",
            content: data.data,
            tool_call_id: data.tool_call_id,
          };
          messageTree.pushBack(tempMessage);
          createToolMessage(data.data);

          scrollToBottomIfAtEnd();
        } else if (data.type === "final") {
          // 刷新聚合缓冲并更新 messages
          try { if (typeof _flushAggregate === 'function') _flushAggregate(); } catch (e) {}
          const tempMessage = {
            role: "assistant",
            content: currentAiMessageContent,
          };
          messageTree.pushBack(tempMessage);
          
          // 思考框已在收到第一个 chunk 时标记为 sticky，这里不再重复标记

          // 清理生成相关状态，但保留 thinking 面板（若有）以便用户查看
          currentAiMessage = null;
          currentAiMessageContent = "";
          hasReceivedFirstChunk = false;
          isGenerating = false;
          updateSendButton(false);
          scrollToBottomIfAtEnd();
        } else if (data.type === "finish") {
          // 在结束前确保聚合缓冲被刷新
          try { if (typeof _flushAggregate === 'function') _flushAggregate(); } catch (e) {}
          updateSendButton(false);
          removeTypingIndicator();
          isGenerating = false;
          if (messageTree.title === null) {
            const text = messagesContainer.innerText;
            fetch("/generate_title", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text: text }),
            })
              .then((response) => {
                if (response.ok) {
                  return response.json();
                } else {
                  throw new Error("无法生成标题");
                }
              })
              .then((data) => {
                messageTree.title = data.title;
                saveHistory(messageTree.title);
                loadHistoryList();
                chatHeader.innerHTML = messageTree.title;
              });
          } else {
            saveHistory(messageTree.title);
            loadHistoryList();
            chatHeader.innerHTML = messageTree.title;
          }
        } else if (data.type === "error") {
          // 处理错误消息
          console.error("收到错误消息:", data.data);
          // 重置状态
          resetAiMessageState();
          updateSendButton(false);
          // 显示错误消息
          const errorMessage = document.createElement("div");
          errorMessage.className = "message error-message ai-message";
          errorMessage.textContent = data.data;
          messagesContainer.appendChild(errorMessage);
          scrollToBottomIfAtEnd();
        }
      };

      ws.onclose = function () {
        console.log("WebSocket连接已关闭");
        isConnected = false;
        updateStatus("disconnected", "已断开");
        connectionInfo.textContent = "已断开";
        sendButton.disabled = true;

        // 5秒后尝试重新连接
        setTimeout(connectWebSocket, 5000);
      };

      ws.onerror = function (error) {
        console.error("WebSocket错误:", error);
        updateStatus("disconnected", "连接错误");
        connectionInfo.textContent = "连接错误";
      };
    } catch (error) {
      console.error("创建WebSocket连接失败:", error);
      updateStatus("disconnected", "连接失败");
      connectionInfo.textContent = "连接失败";

      // 5秒后尝试重新连接
      setTimeout(connectWebSocket, 5000);
    }
  }

  // 更新思考状态
  function updateThinkingStatus() {
    if (thinkingStatusElement && thinkingStartTime) {
      const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
      thinkingStatusElement.textContent = `思考中 ${elapsed}秒`;
    }
  }

  // 更新连接状态显示
  function updateStatus(status, text) {
    statusElement.className = "status " + status;
    statusText.textContent = text;
  }

  // 移除"正在输入"指示器
  function removeTypingIndicator() {
    const typingIndicator = document.getElementById("typing-indicator");
    if (typingIndicator) {
      typingIndicator.remove();
    }
    isTyping = false;
  }

  // 模型和思考模式功能
  function updateThinkingModeOptions() {
    const modelSelect = document.getElementById("model-select");
    const thinkingModeSelect = document.getElementById("thinking-mode-select");
    const selectedModel = modelSelect.value;

    // 清空当前选项
    thinkingModeSelect.innerHTML = "";

    // 检查是否为本地 ollama 模型和是否为思考模型
    const isLocal = isLocalOllamaModel();
    const isThinking = isThinkingModel();

    // 始终首先添加 "disabled" 选项
    const disabledOption = document.createElement("option");
    disabledOption.value = "disabled";
    disabledOption.textContent = getThinkingModeDisplayName("disabled");
    thinkingModeSelect.appendChild(disabledOption);

    // 本地 ollama 非思考模型：只显示"禁用"选项
    if (isLocal && !isThinking) {
      thinkingModeSelect.value = "disabled";
      thinkingModeSelect.disabled = true;
      localStorage.setItem("thinkingMode", "disabled");
      
      if (!customThinkingSelect)
        customThinkingSelect = new CustomSelect(thinkingModeSelect);
      else
        customThinkingSelect.refresh();
      return;
    }

    // 启用选择器
    thinkingModeSelect.disabled = false;

    // 根据选择的模型添加支持的思考模式
    const modelData = Object.values(modelList).find(
      (m) => m.model_id === selectedModel
    );
    
    if (modelData && modelData.thinking_modes) {
      modelData.thinking_modes.forEach((mode) => {
        // 跳过 disabled，因为已经手动添加
        if (mode === "disabled") return;
        const option = document.createElement("option");
        option.value = mode;
        option.textContent = getThinkingModeDisplayName(mode);
        thinkingModeSelect.appendChild(option);
      });
    }

    // 优先恢复保存的思考模式设置
    const savedThinkingMode = localStorage.getItem("thinkingMode");
    if (
      savedThinkingMode &&
      thinkingModeSelect.querySelector(`option[value="${savedThinkingMode}"]`)
    ) {
      thinkingModeSelect.value = savedThinkingMode;
    } else {
      // 默认选择 disabled
      thinkingModeSelect.value = "disabled";
      localStorage.setItem("thinkingMode", "disabled");
    }

    if (!customThinkingSelect)
      customThinkingSelect = new CustomSelect(thinkingModeSelect);
    else
      customThinkingSelect.refresh();
  }

  // 获取思考模式的显示名称
  function getThinkingModeDisplayName(mode) {
    const modeNames = {
      disabled: "禁用",
      enabled: "启用",
      auto: "自动",
    };
    return modeNames[mode] || mode;
  }

  // 初始化模型、思考模式和工具
  async function initModelSettings() {
    // 如果没有 userId,生成新的 UUID
    if (!userId) {
      userId = crypto.randomUUID();
      localStorage.setItem("userId", userId);
    }
    
    // 通知后端注册 userId
    const response = await fetch(`/api/generate-user-id/${userId}`);
    const data = await response.json();
    userId = data.data;
    localStorage.setItem("userId", userId);
    const modelSelect = document.getElementById("model-select");
    const thinkingModeSelect = document.getElementById("thinking-mode-select");
    modelList = await loadModelList();

    // 添加刷新模型按钮的事件处理（如果存在）
    const refreshModelsBtn = document.getElementById("refresh-models-btn");
    if (refreshModelsBtn) {
      refreshModelsBtn.addEventListener("click", async () => {
        refreshModelsBtn.disabled = true;
        const origText = refreshModelsBtn.textContent;
        refreshModelsBtn.textContent = "刷新中...";
        try {
          // 读取当前选择（如果有）
          const modelSelect = document.getElementById("model-select");
          const selectedText = modelSelect && modelSelect.selectedOptions && modelSelect.selectedOptions[0]
            ? modelSelect.selectedOptions[0].textContent
            : null;
          const selectedModelId = modelSelect ? modelSelect.value : null;

          // 先触发一次后端刷新（检测本地 ollama 列表）
          try { await fetch('/api/refresh_models', { method: 'POST' }); } catch (e) { /* ignore */ }

          // 重新加载 model_list.json 并刷新下拉
          modelList = await loadModelList();
          // 触发 UI 更新
          updateThinkingModeOptions();
          updateModelNetworkIndicator();

          // 如果当前选择看上去是本地模型，但刷新后在列表中仍未检测到对应 model_id，则尝试启动 ollama 并轮询直到模型出现或超时
          try {
            let isLocalSelected = false;
            if (selectedText && modelList && modelList[selectedText]) {
              const base = (modelList[selectedText].base_url || "").toLowerCase();
              if (base.includes("localhost") || base.includes("127.0.0.1")) isLocalSelected = true;
            }

            const modelAppears = (ml, mid) => {
              if (!ml || !mid) return false;
              return Object.values(ml).some(m => m.model_id === mid);
            };

            if (isLocalSelected && selectedModelId && !modelAppears(modelList, selectedModelId)) {
              // 请求后端启动 ollama（若后端未安装 ollama，会返回错误）
              try {
                await fetch('/api/start_ollama', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: selectedModelId }),
                });
              } catch (e) {
                console.warn('请求 /api/start_ollama 失败：', e);
              }

              // 轮询直到模型出现在列表中（最多等待 30 秒，间隔 2 秒）
              const startTs = Date.now();
              const timeoutMs = 30000;
              const pollInterval = 2000;
              let appeared = false;
              while (Date.now() - startTs < timeoutMs) {
                try {
                  await fetch('/api/refresh_models', { method: 'POST' });
                  const latest = await loadModelList();
                  if (modelAppears(latest, selectedModelId)) {
                    appeared = true;
                    modelList = latest;
                    break;
                  }
                } catch (e) {
                  // 忽略网络/解析错误并继续重试
                }
                await new Promise(r => setTimeout(r, pollInterval));
              }
              if (!appeared) {
                console.warn('超时：未能在本地模型列表中检测到所选模型');
              }
              // 再次更新 UI
              updateThinkingModeOptions();
              updateModelNetworkIndicator();
            }
          } catch (e) {
            console.warn('自动启动本地模型流程发生异常：', e);
          }
        } catch (e) {
          console.error('刷新模型失败', e);
        } finally {
          refreshModelsBtn.disabled = false;
          refreshModelsBtn.textContent = origText;
        }
      });
    }

    // 初始化思考模式选项
    updateThinkingModeOptions();

    // 初始化工具列表
    const toolList = await loadToolList();

    localStorage.setItem("toolList", JSON.stringify(toolList));

    // 监听模型变化
    modelSelect.addEventListener("change", function () {
      localStorage.setItem("selectedModel", this.value);
      updateThinkingModeOptions();
      
      // 更新 RAG 按钮状态
      if (typeof updateRagButtonState === 'function') {
        updateRagButtonState();
      }
      
      // 更新网络指示器
      try { 
        if (typeof updateModelNetworkIndicator === 'function') {
          updateModelNetworkIndicator(); 
        }
      } catch (e) { 
        console.warn(e); 
      }
    });

    // 监听思考模式变化
    thinkingModeSelect.addEventListener("change", function () {
      localStorage.setItem("thinkingMode", this.value);
    });
  }

  // 更新temperature显示值
  function updateTemperatureDisplay(value) {
    // 将0-200的范围转换为 0.0 -> 2.0
    const temp = (value / 100).toFixed(1);
    temperatureValue.textContent = temp;
  }

  // 更新frequencyPenalty显示值
  function updateFrequencyPenaltyDisplay(value) {
    // 将-200-200的范围转换为 -2.0 -> 2.0
    const freq = (value / 100).toFixed(1);
    frequencyPenaltyValue.textContent = freq;
  }

  // 监听滑块变化
  temperatureSlider.addEventListener("input", function () {
    updateTemperatureDisplay(this.value);
    // 保存到localStorage
    localStorage.setItem("temperature", this.value);
  });

  frequencyPenaltySlider.addEventListener("input", function () {
    updateFrequencyPenaltyDisplay(this.value);
    // 保存到localStorage
    localStorage.setItem("frequencyPenalty", this.value);
  });

  // 初始化temperature值
  const savedTemperature = localStorage.getItem("temperature");
  if (savedTemperature) {
    temperatureSlider.value = savedTemperature;
    updateTemperatureDisplay(savedTemperature);
  } else {
    updateTemperatureDisplay(temperatureSlider.value);
  }

  // 初始化frequencyPenalty值
  const savedFrequencyPenalty = localStorage.getItem("frequencyPenalty");
  if (savedFrequencyPenalty) {
    frequencyPenaltySlider.value = savedFrequencyPenalty;
    updateFrequencyPenaltyDisplay(savedFrequencyPenalty);
  } else {
    updateFrequencyPenaltyDisplay(frequencyPenaltySlider.value);
  }

  // 事件监听
  sendButton.addEventListener("click", sendMessageFromInputArea);

  // 检测是否为移动设备
  function isMobileDevice() {
    // 检查是否有触摸支持
    const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

    // 检查用户代理字符串
    const isMobileUA =
      /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
        navigator.userAgent
      );

    return hasTouch && isMobileUA;
  }

  messageInput.addEventListener("keydown", function (e) {
    if (isMobileDevice()) {
      return;
    }
    if ((e.key === "Enter" && e.ctrlKey) || (e.key === "Enter" && e.ctrlKey)) {
      // Ctrl+Enter 换行
      const cursorPos = this.selectionStart;
      this.value =
        this.value.substring(0, cursorPos) +
        "\n" +
        this.value.substring(cursorPos);
      this.selectionStart = this.selectionEnd = cursorPos + 1;
      e.preventDefault();
    } else if (e.key === "Enter" && !e.shiftKey) {
      // 直接 Enter 发送
      e.preventDefault();
      sendMessageFromInputArea();
    }
  });

  messageInput.addEventListener("input", function () {
    this.style.height = "auto";

    const maxHeight = window.innerHeight * 0.15; // 15vh
    if (this.scrollHeight <= maxHeight) {
      // 内容没超过上限：自适应高度 + 隐藏滚动条
      this.style.height = this.scrollHeight + "px";
      this.style.overflowY = "hidden";
    } else {
      // 超过上限：锁定最大高度 + 允许滚动
      this.style.height = maxHeight + "px";
      this.style.overflowY = "auto";
    }
  });

  messageInput.addEventListener("input", function () {
    // 输入框有内容且已连接时启用发送按钮
    const hasContent = this.value.trim().length > 0;
    sendButton.disabled = !hasContent || !isConnected;
  });
  clearBtn.addEventListener("click", clearMessages);
  document.addEventListener("keydown", (e) => {
    if (e.key === "j" && e.ctrlKey) {
      e.preventDefault();
      clearBtn.click();
    } else if (e.key === "k" && e.ctrlKey) {
      e.preventDefault();
      messageInput.focus();
    }
  });

  darkModeToggle.addEventListener("click", toggleDarkMode);

  // 初始化设置和WebSocket连接 - 必须等待 initModelSettings 完成后再连接 WebSocket
  initHeader();
  initDarkMode();
  initModelSettings().then(() => {
    connectWebSocket();
  });
  loadHistoryList();

  // 初始化后强制禁用 RAG 工具
  try {
    if (toolSettings) {
      toolSettings["RAG"] = false;
      localStorage.setItem("toolSettings", JSON.stringify(toolSettings));
    }
    const ragSwitch = document.querySelector('.tool-switch[data-tool="RAG"]');
    if (ragSwitch) {
      ragSwitch.classList.remove("active");
    }
    updateRagUIByToolSwitch();
  } catch (e) {
    console.warn("初始化 RAG 状态失败:", e);
  }

  // 工具滑块事件监听，控制 RAG 区显示
  document.addEventListener("click", function (e) {
    if (e.target && e.target.classList.contains("tool-switch") && e.target.dataset.tool === "RAG") {
      updateRagUIByToolSwitch();
    }
  });

  // 模型切换时，只有本地模型才允许 RAG 滑块可用
  const modelSelect = document.getElementById("model-select");
  if (modelSelect) {
    modelSelect.addEventListener("change", function () {
      const ragSwitch = document.querySelector('.tool-switch[data-tool="RAG"]');
      if (ragSwitch) {
        // 如果选择的是前 5 个模型（索引 0-4），则禁用 RAG 滑块并强制关闭
        const selectedIndex = this.selectedIndex;
        if (selectedIndex >= 0 && selectedIndex < 5) {
          ragSwitch.classList.add("disabled");
          // 强制关闭
          ragSwitch.classList.remove("active");
          if (toolSettings) {
            toolSettings["RAG"] = false;
            localStorage.setItem("toolSettings", JSON.stringify(toolSettings));
          }
          ragSwitch.title = "该模型为联网模型，RAG 不可用";
          updateRagUIByToolSwitch();
        } else {
          // 非前5，恢复按本地模型判断（兼容旧逻辑）
          ragSwitch.classList.remove("disabled");
          if (!isLocalModelSelected()) {
            // 如果不是本地模型，也要禁用
            ragSwitch.classList.add("disabled");
            ragSwitch.classList.remove("active");
            ragSwitch.title = "仅本地模型可用";
            if (toolSettings) {
              toolSettings["RAG"] = false;
              localStorage.setItem("toolSettings", JSON.stringify(toolSettings));
            }
            updateRagUIByToolSwitch();
          } else {
            ragSwitch.title = "本地模型可用";
          }
        }
      }
      // 更新右下角联网指示器
      try { updateModelNetworkIndicator(); } catch (e) { console.warn(e); }
    });
  }

  // 初始化时触发一次模型选择逻辑，确保根据当前选择设置 RAG 可用性
  if (modelSelect) modelSelect.dispatchEvent(new Event("change"));

  // 初始化时同步一次显示/隐藏 RAG 输入区
  updateRagUIByToolSwitch();

  // 更新模型联网指示器（根据 base_url 判断是否为联网模型）
  function updateModelNetworkIndicator() {
    const indicator = document.getElementById("model-network-indicator");
    const select = document.getElementById("model-select");
    if (!indicator || !select || !modelList) return;

    const selectedValue = select.value;
    // modelList 的结构为 { displayName: modelData }
    let modelData = null;
    for (const [displayName, md] of Object.entries(modelList)) {
      if (md.model_id === selectedValue) {
        modelData = md;
        break;
      }
    }

    if (!modelData) {
      indicator.className = "model-network-indicator hidden";
      indicator.title = "未知模型状态";
      indicator.textContent = "";
      return;
    }

    const base = (modelData.base_url || "").toLowerCase();
    const isNetwork = base && !base.includes("localhost") && !base.includes("127.0.0.1") && (base.startsWith("http") || base.includes("://"));

    indicator.classList.remove("networked", "local", "hidden");
    if (isNetwork) {
      indicator.classList.add("networked");
      indicator.title = "联网模型";
      indicator.textContent = "网";
    } else {
      indicator.classList.add("local");
      indicator.title = "本地模型";
      indicator.textContent = "本";
    }
  }

  // RAG 专用提问区美化与进度条/日志逻辑
  const ragInput = document.getElementById("rag-input");
  const ragSend = document.getElementById("rag-send");
  const ragAnswer = document.getElementById("rag-answer");
  const ragProgress = document.getElementById("rag-progress");
  const ragProgressBar = document.getElementById("rag-progress-bar");
  const ragLog = document.getElementById("rag-log");

  // RAG提问（支持中途停止）
  if (ragInput && ragSend && ragAnswer) {
    let ragAbortController = null;

    function setRagButtonRunning(running) {
      if (running) {
        ragSend.textContent = "停止";
        ragSend.style.background = "#f44336";
        ragSend.classList.add("running");
      } else {
        ragSend.textContent = "RAG 提问";
        ragSend.style.background = "";
        ragSend.classList.remove("running");
      }
    }

    ragSend.addEventListener("click", async () => {
      // 如果已有正在进行的请求，点击则取消它
      if (ragAbortController) {
        try {
          ragAbortController.abort();
        } catch (e) {
          console.warn("Abort failed:", e);
        }
        ragAbortController = null;
        setRagButtonRunning(false);
        // 将取消记录为一条助手消息
        const cancelText = "RAG 已取消。";
        messageTree.pushBack({ role: "assistant", content: cancelText });
        createAiMessage(cancelText);
        ragAnswer.textContent = cancelText;
        return;
      }

      const q = ragInput.value.trim();
      if (!q) return;

      // 将用户的 RAG 查询加入消息树，生成与普通输入一致的分支/编辑/复制 UI
      const userRagMsg = { role: "user", content: q };
      const userNode = messageTree.pushBack(userRagMsg);
      createUserMessage(userNode);
      scrollToBottomIfAtEnd();
      // 清空输入框（与普通提问保持一致）
      ragInput.value = "";

      // 新建 AbortController 用于中断请求
      ragAbortController = new AbortController();
      const signal = ragAbortController.signal;

      // UI 初始化
      setRagButtonRunning(true);
      ragAnswer.textContent = "RAG 正在思考...";
      ragProgress.style.display = "none";
      ragProgressBar.style.width = "0%";
      ragLog.textContent = "";

      try {
        const res = await fetch("/rag_query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q }),
          signal,
        });

        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "请求失败");
        }
        const data = await res.json();
        const answerContent = data.answer || JSON.stringify(data);
        // 将 RAG 答案作为助手消息加入消息树
        messageTree.pushBack({ role: "assistant", content: answerContent });
        createAiMessage(answerContent);
        scrollToBottomIfAtEnd();
        ragAnswer.textContent = "RAG 完成。";
      } catch (e) {
        const messagesContainer = document.getElementById("messages");
        const errMsg = document.createElement("div");
        errMsg.className = "message ai-message error";
        if (e.name === "AbortError") {
          const cancelText = "RAG 已取消。";
          errMsg.textContent = cancelText;
          ragAnswer.textContent = cancelText;
          messageTree.pushBack({ role: "assistant", content: cancelText });
        } else {
          errMsg.textContent = "RAG 调用失败：" + e;
          ragAnswer.textContent = "RAG 调用失败：" + e;
          messageTree.pushBack({ role: "assistant", content: "RAG 调用失败：" + e });
        }
        messagesContainer.appendChild(errMsg);
        scrollToBottomIfAtEnd();
      } finally {
        // 清理状态
        ragAbortController = null;
        setRagButtonRunning(false);
      }
    });
  }

  // RAG上传/构建进度条与日志（文件上传时）
  const fileInput = document.getElementById("file-input");
  let isUploading = false;
  if (fileInput) {
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file || isUploading) return;
      isUploading = true;

      const formData = new FormData();
      formData.append("files", file);
      const savedFilename = file.name;

      const messagesContainer = document.getElementById("messages");
      const uploadingMsg = document.createElement("div");
      uploadingMsg.className = "message ai-message";
      uploadingMsg.textContent = `正在上传并启动构建：${savedFilename}...`;
      messagesContainer.appendChild(uploadingMsg);

      ragProgress.style.display = "block";
      ragProgressBar.style.width = "5%";
      ragLog.textContent = "等待后台构建启动...\n";

      let poller = null;
      const POLL_INTERVAL = 1000;
      function updateLogAndStatus() {
        fetch('/upload_log').then(r => r.ok ? r.json() : Promise.resolve({log:''})).then(j => {
          if (j && typeof j.log === 'string') {
            // 截断日志，最多显示最后 300 行
            const lines = j.log.split(/\r?\n/);
            const tail = lines.slice(-300).join('\n');
            ragLog.textContent = tail;
          }
        }).catch(()=>{});
        fetch('/build_status').then(r => r.ok ? r.json() : Promise.resolve(null)).then(j => {
          if (!j || !j.build_status) return;
          const st = j.build_status.state;
          if (st === 'pending') {
            ragProgressBar.style.width = '15%';
          } else if (st === 'running') {
            // 简单动态：长度随时间增长
            const cur = parseFloat(ragProgressBar.style.width) || 15;
            ragProgressBar.style.width = Math.min(cur + 8, 90) + '%';
          } else if (st === 'success' || st === 'error') {
            ragProgressBar.style.width = '100%';
            clearInterval(poller);
            uploadingMsg.textContent = st === 'success'
              ? `文件已上传并构建完成：${savedFilename}`
              : `构建失败：${savedFilename}`;
            ragLog.textContent += `\n构建${st === 'success' ? '成功' : '失败'}！`;
            isUploading = false;
            setTimeout(()=> { fileInput.value = ''; }, 800);
          }
        }).catch(()=>{});
      }

      try {
        const resp = await fetch('/upload_kb', { method:'POST', body: formData });
        let result = null;
        try { result = await resp.json(); } catch (_){}
        if (!resp.ok || !result || result.status !== 'success') {
          const errMsg = (result && result.message) || resp.statusText;
          uploadingMsg.textContent = `上传失败：${errMsg}`;
          ragProgressBar.style.width = '100%';
          isUploading = false;
          fileInput.value = '';
          // 如果是已有构建任务，提供强制重启按钮
          if (/已有构建任务正在进行/.test(errMsg)) {
            const forceBtn = document.createElement('button');
            forceBtn.textContent = '强制重启构建';
            forceBtn.style.marginLeft = '8px';
            forceBtn.style.padding = '6px 12px';
            forceBtn.style.borderRadius = '8px';
            forceBtn.style.border = 'none';
            forceBtn.style.cursor = 'pointer';
            forceBtn.style.background = '#ff9800';
            forceBtn.style.color = '#fff';
            forceBtn.onclick = async () => {
              if (isUploading) return;
              isUploading = true;
              forceBtn.disabled = true;
              uploadingMsg.textContent = '正在强制取消旧构建并重启...';
              const fd = new FormData();
              fd.append('files', file);
              fd.append('force', 'true');
              try {
                const r2 = await fetch('/upload_kb', { method: 'POST', body: fd });
                let j2 = null; try { j2 = await r2.json(); } catch(_){}
                if (r2.ok && j2 && j2.status === 'success') {
                  uploadingMsg.textContent = '已强制重启构建，正在后台运行...';
                  ragProgressBar.style.width = '5%';
                  // 重新启动轮询
                  poller = setInterval(updateLogAndStatus, POLL_INTERVAL);
                  updateLogAndStatus();
                } else {
                  uploadingMsg.textContent = '强制重启失败：' + ((j2 && j2.message) || r2.statusText);
                  isUploading = false;
                  forceBtn.disabled = false;
                }
              } catch (e) {
                uploadingMsg.textContent = '网络错误：' + e;
                isUploading = false;
                forceBtn.disabled = false;
              }
            };
            uploadingMsg.appendChild(forceBtn);
          }
          return;
        }
        ragLog.textContent += '后台构建已启动...\n';
        poller = setInterval(updateLogAndStatus, POLL_INTERVAL);
        updateLogAndStatus();
      } catch (err) {
        uploadingMsg.textContent = `网络错误：${err}`;
        ragProgressBar.style.width = '100%';
        isUploading = false;
        fileInput.value = '';
      }
      scrollToBottomIfAtEnd();
    });
  }

  const ragUploadBtn = document.getElementById("rag-upload-btn");
  const ragUploadFile = document.getElementById("rag-upload-file");
  if (ragUploadBtn && ragUploadFile) {
    ragUploadBtn.onclick = () => ragUploadFile.click();
    ragUploadFile.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // 触发主 file-input 的上传逻辑（通过同步文件并触发 change）
      try {
        const mainFileInput = document.getElementById("file-input");
        if (mainFileInput && !isUploading) {
          const dt = new DataTransfer();
          dt.items.add(file);
          mainFileInput.files = dt.files;
          mainFileInput.dispatchEvent(new Event('change', { bubbles: true }));
          ragUploadFile.value = "";
          return;
        }
      } catch (err) {
        console.warn('无法同步文件到主 input:', err);
      }
      // 保存原始内容，方便恢复
      const originalHTML = ragUploadBtn.innerHTML;
      ragUploadBtn.classList.add('btn-loading');
      ragUploadBtn.innerHTML = '<span class="spinner"></span>上传中...';
      ragUploadBtn.disabled = true;
      try {
        const formData = new FormData();
        // 前端使用 'files' 字段，以匹配后端 /upload_kb 的签名 list[UploadFile]
        formData.append("files", file);
        const resp = await fetch("/upload_kb", {
          method: "POST",
          body: formData,
        });
        let result = null;
        try { result = await resp.json(); } catch (_){ result = null; }
        if (resp.ok && result && result.status === 'success') {
          // 后端已在后台启动构建，开始轮询日志与状态
          const ragLog = document.getElementById('rag-log');
          ragUploadBtn.innerHTML = '<span class="spinner"></span>构建中...';
          const pollInterval = 1000;
          let poller = null;
          async function pollOnce() {
            try {
              const logResp = await fetch('/upload_log');
              if (logResp.ok) {
                const logJson = await logResp.json();
                if (ragLog && logJson.log !== undefined) ragLog.textContent = logJson.log;
              }
              const statusResp = await fetch('/build_status');
              if (statusResp.ok) {
                const statusJson = await statusResp.json();
                const state = statusJson.build_status && statusJson.build_status.state;
                if (state === 'success' || state === 'error') {
                  // 完成
                  clearInterval(poller);
                  ragUploadBtn.innerHTML = state === 'success' ? '构建完成' : '构建失败';
                  setTimeout(() => {
                    ragUploadBtn.innerHTML = originalHTML;
                    ragUploadBtn.classList.remove('btn-loading');
                    ragUploadBtn.disabled = false;
                  }, 1500);
                }
              }
            } catch (e) {
              console.error('轮询构建日志失败', e);
            }
          }
          // 立即执行一次并开始定时器
          pollOnce();
          poller = setInterval(pollOnce, pollInterval);
        } else {
          const msg = (result && result.message) ? result.message : (resp.statusText || '上传或构建失败');
          // 已有构建任务，显示强制按钮
          if (/已有构建任务正在进行/.test(msg)) {
            ragUploadBtn.innerHTML = '已有构建任务，点击强制重启';
            ragUploadBtn.disabled = false;
            ragUploadBtn.classList.remove('btn-loading');
            ragUploadBtn.onclick = async () => {
              ragUploadBtn.innerHTML = '<span class="spinner"></span>强制重启...';
              ragUploadBtn.disabled = true;
              const fd = new FormData();
              fd.append('files', file);
              fd.append('force', 'true');
              try {
                const r2 = await fetch('/upload_kb', { method: 'POST', body: fd });
                let j2 = null; try { j2 = await r2.json(); } catch(_){ }
                if (r2.ok && j2 && j2.status === 'success') {
                  ragUploadBtn.innerHTML = '<span class="spinner"></span>构建中...';
                  ragUploadBtn.classList.add('btn-loading');
                  ragUploadBtn.disabled = true;
                  // 轮询日志
                  const ragLog = document.getElementById('rag-log');
                  const pollInterval = 1000;
                  let poller = null;
                  async function pollOnce() {
                    try {
                      const logResp = await fetch('/upload_log');
                      if (logResp.ok) {
                        const logJson = await logResp.json();
                        if (ragLog && logJson.log !== undefined) ragLog.textContent = logJson.log;
                      }
                      const statusResp = await fetch('/build_status');
                      if (statusResp.ok) {
                        const statusJson = await statusResp.json();
                        const state = statusJson.build_status && statusJson.build_status.state;
                        if (state === 'success' || state === 'error' || state === 'cancelled') {
                          clearInterval(poller);
                          ragUploadBtn.innerHTML = state === 'success' ? '构建完成' : (state === 'cancelled' ? '已取消' : '构建失败');
                          setTimeout(() => {
                            ragUploadBtn.innerHTML = originalHTML;
                            ragUploadBtn.classList.remove('btn-loading');
                            ragUploadBtn.disabled = false;
                            ragUploadBtn.onclick = () => ragUploadFile.click();
                          }, 1500);
                        }
                      }
                    } catch (e) { console.error(e); }
                  }
                  pollOnce(); poller = setInterval(pollOnce, pollInterval);
                } else {
                  ragUploadBtn.innerHTML = '强制重启失败';
                  setTimeout(() => {
                    ragUploadBtn.innerHTML = originalHTML;
                    ragUploadBtn.classList.remove('btn-loading');
                    ragUploadBtn.disabled = false;
                    ragUploadBtn.onclick = () => ragUploadFile.click();
                  }, 2000);
                }
              } catch (e) {
                ragUploadBtn.innerHTML = '网络错误';
                setTimeout(() => {
                  ragUploadBtn.innerHTML = originalHTML;
                  ragUploadBtn.classList.remove('btn-loading');
                  ragUploadBtn.disabled = false;
                  ragUploadBtn.onclick = () => ragUploadFile.click();
                }, 1500);
              }
            };
          } else {
            ragUploadBtn.innerHTML = msg;
            setTimeout(() => {
              ragUploadBtn.innerHTML = originalHTML;
              ragUploadBtn.classList.remove('btn-loading');
              ragUploadBtn.disabled = false;
            }, 2500);
          }
        }
      } catch (err) {
        ragUploadBtn.innerHTML = '网络错误';
        setTimeout(() => {
          ragUploadBtn.innerHTML = originalHTML;
          ragUploadBtn.classList.remove('btn-loading');
          ragUploadBtn.disabled = false;
        }, 1500);
      }
      ragUploadFile.value = "";
    };
  }

  // ----------------------
  // 前端短片段合并（聚合）逻辑配置与辅助方法
  // ----------------------
  const AGGREGATE_STORAGE_KEY = 'ws_aggregate_config_v1';
  let aggregateConfig = { enabled: true, maxChars: 6, timeoutMs: 150 };
  try {
    const saved = localStorage.getItem(AGGREGATE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      aggregateConfig = Object.assign(aggregateConfig, parsed);
    }
  } catch (e) {
    console.warn('加载聚合配置失败', e);
  }

  let _aggregateBuffer = '';
  let _aggregateTimer = null;

  function _flushAggregate() {
    if (!_aggregateBuffer) return;
    // 确保已创建当前 AI 消息节点
    if (!hasReceivedFirstChunk || !currentAiMessage) {
      removeTypingIndicator();
      createAiMessage();
      hasReceivedFirstChunk = true;
    }
    currentAiMessageContent += _aggregateBuffer;
    renderMessageWithMath(currentAiMessage, currentAiMessageContent);
    _aggregateBuffer = '';
    if (_aggregateTimer) {
      clearTimeout(_aggregateTimer);
      _aggregateTimer = null;
    }
    scrollToBottomIfAtEnd();
  }

  function _scheduleAggregateFlush() {
    if (_aggregateTimer) clearTimeout(_aggregateTimer);
    _aggregateTimer = setTimeout(() => {
      _flushAggregate();
    }, Math.max(0, aggregateConfig.timeoutMs || 150));
  }

  // 将 flush/clear 暴露到 window，便于外部（例如全局 reset）调用（安全检查存在）
  try {
    window.__ws_flush_aggregate = _flushAggregate;
    window.__ws_clear_aggregate = function () {
      try {
        _aggregateBuffer = '';
        if (_aggregateTimer) { clearTimeout(_aggregateTimer); _aggregateTimer = null; }
      } catch (e) {}
    };
  } catch (e) {}

});

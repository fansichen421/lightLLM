function saveHistory(name) {
  localStorage.setItem(`historyMessages_${name}`, JSON.stringify(messageTree));
  let historyNames = JSON.parse(localStorage.getItem("historyNames")) || [];
  historyNames = historyNames.filter((item) => item != name);
  historyNames = [name, ...historyNames];
  localStorage.setItem("historyNames", JSON.stringify(historyNames));
}

function loadHistory(name) {
  let loadedMessageTree = JSON.parse(
    localStorage.getItem(`historyMessages_${name}`)
  );
  if (!loadedMessageTree) return;
  messageTree = MessageTree.fromJSON(loadedMessageTree); // 修改全局变量
  messages = messageTree.getMessages(); // 修改全局变量
  const chatHeader = document.getElementById("chat-header");
  messageTree.title = name; // 修改全局变量
  chatHeader.innerHTML = name;
  renderMessages();
}

function loadHistoryList() {
  let historyList = document.getElementById("history-list");
  historyList.innerHTML = "";
  let historyNames = JSON.parse(localStorage.getItem("historyNames")) || [];

  for (let name of historyNames) {
    let li = document.createElement("li");
    li.classList.add("history-item");

    // 创建历史记录名称
    let nameSpan = document.createElement("span");
    nameSpan.textContent = name;

    // 创建按钮容器
    let buttonsContainer = document.createElement("div");
    buttonsContainer.classList.add("history-item-buttons");

    // 创建编辑按钮
    let editBtn = document.createElement("button");
    editBtn.classList.add("edit-btn");
    editBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
      </svg>
    `;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const newName = prompt("输入新的名称:", name);
      if (newName && newName !== name) {
        editHistory(name, newName);
      }
    });

    // 创建删除按钮
    let deleteBtn = document.createElement("button");
    deleteBtn.classList.add("delete-btn");
    deleteBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`确定要删除 "${name}" 吗？`)) {
        deleteHistory(name);
        if (messageTree.title === name) {
          clearMessages();
        }
      }
    });

    // 组装元素
    buttonsContainer.appendChild(editBtn);
    buttonsContainer.appendChild(deleteBtn);
    li.appendChild(nameSpan);
    li.appendChild(buttonsContainer);

    // 将点击事件绑定到整个列表项
    li.addEventListener("click", () => loadHistory(name));

    // 添加悬停显示按钮的效果
    li.addEventListener("mouseenter", () => {
      buttonsContainer.style.display = "flex";
    });
    li.addEventListener("mouseleave", () => {
      buttonsContainer.style.display = "none";
    });

    historyList.appendChild(li);
  }
}

function deleteHistory(name) {
  let historyNames = JSON.parse(localStorage.getItem("historyNames")) || [];
  historyNames = historyNames.filter((item) => item != name);
  localStorage.setItem("historyNames", JSON.stringify(historyNames));
  localStorage.removeItem(`historyMessages_${name}`);
  loadHistoryList();
}

function editHistory(name, newName) {
  const data = localStorage.getItem(`historyMessages_${name}`);
  localStorage.setItem(`historyMessages_${newName}`, data);
  localStorage.removeItem(`historyMessages_${name}`);
  let historyNames = JSON.parse(localStorage.getItem("historyNames")) || [];
  historyNames = historyNames.map((item) => {
    if (item === name) return newName;
    else return name;
  });
  localStorage.setItem("historyNames", JSON.stringify(historyNames));
  loadHistoryList();
}

class MessageTree {
  constructor(title, root) {
    this.title = title;
    this.root = root;
    this.parentMap = [0];
    this.messageNodes = [root];
  }

  getMessages() {
    let messages = [];
    let node = this.root;
    while (node != null) {
      messages.push(node.toMessage());
      node = this.messageNodes[node.getActiveChild()];
    }

    return messages;
  }

  getLength() {
    return this.messageNodes.length;
  }

  pushMessage(
    index,
    { content, role = "user", tool_calls = null, tool_call_id = null }
  ) {
    const currentMessage = this.messageNodes[index];
    const newMessage = currentMessage.createChild(this.parentMap.length, {
      content,
      role: role,
      tool_calls: tool_calls,
      tool_call_id: tool_call_id,
    });
    this.messageNodes.push(newMessage);
    this.parentMap.push(index);
    return newMessage;
  }

  pushBack({ content, role = "user", tool_calls = null, tool_call_id = null }) {
    return this.pushMessage(this.getLength() - 1, {
      content: content,
      role: role,
      tool_calls: tool_calls,
      tool_call_id: tool_call_id,
    });
  }

  static fromMessages(messages) {
    if (!messages) return null;
    const root = new MessageNode(0, messages[0]);
    const tree = new MessageTree(null, root);
    for (let i = 1; i < messages.length; i++) {
      tree.pushMessage(i - 1, messages[i]);
    }
    return tree;
  }

  static fromJSON(data) {
    // 第一阶段：创建所有 MessageNode 实例
    const nodes = data.messageNodes.map((nodeData) => {
      const node = new MessageNode(nodeData.index, {
        content: nodeData.content,
        role: nodeData.role,
        tool_calls: nodeData.tool_calls,
        tool_call_id: nodeData.tool_call_id,
      });
      node.selectedChildIndex = nodeData.selectedChildIndex;
      return node;
    });

    // 第二阶段：重建 children 关系
    nodes.forEach((node, i) => {
      node.children = data.messageNodes[i].children;
    });

    // 创建 MessageTree 实例
    const rootNode = nodes.find((node) => node.index === 0);
    const tree = new MessageTree(data.title, rootNode);
    tree.messageNodes = nodes;
    tree.parentMap = data.parentMap;

    return tree;
  }
}

class MessageNode {
  constructor(
    index = 0,
    { content, role = "user", tool_calls = null, tool_call_id = null }
  ) {
    this.index = index;
    this.content = content;
    this.role = role;
    this.children = [];

    // 简化：只在AI节点存储选择状态
    if (role === "assistant") {
      this.selectedChildIndex = null; // 用户选择了哪个子分支
      this.tool_calls = tool_calls;
    }

    if (role === "tool") {
      this.tool_call_id = tool_call_id;
    }
  }

  createChild(
    index,
    { content, role = "user", tool_calls = null, tool_call_id = null }
  ) {
    const child = new MessageNode(index, {
      content,
      role: role,
      tool_calls: tool_calls,
      tool_call_id: tool_call_id,
    });
    this.children.push(index);
    this.selectedChildIndex = this.children.length - 1; // 预期行为：选中新创建的节点
    return child;
  }

  getActiveChild() {
    return this.children[this.selectedChildIndex];
  }

  toMessage() {
    if (this.role === "user") {
      return { role: "user", content: this.content };
    }
    if (this.role === "assistant") {
      return {
        role: "assistant",
        content: this.content,
        tool_calls: this.tool_calls,
      };
    }
    if (this.role === "tool") {
      return {
        role: "tool",
        content: this.content,
        tool_call_id: this.tool_call_id,
      };
    }
    if (this.role === "system") {
      return {
        role: "system",
        content: this.content,
      };
    }
  }
}

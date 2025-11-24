class CustomSelect {
  constructor(originalSelect) {
    this.originalSelect = originalSelect;
    this.createCustomSelect();
    this.bindEvents();
  }

  createCustomSelect() {
    // 隐藏原生 select
    this.originalSelect.style.display = "none";
    
    // 创建自定义HTML结构
    this.customSelect = document.createElement("div");
    this.customSelect.className = "custom-select";

    // 创建选中显示区域
    this.selectedDisplay = document.createElement("div");
    this.selectedDisplay.className = "select-selected";
    this.updateSelectedDisplay();

    // 创建选项容器
    this.optionsContainer = document.createElement("div");
    this.optionsContainer.className = "select-options";

    // 添加选项
    Array.from(this.originalSelect.options).forEach((option) => {
      const customOption = document.createElement("div");
      customOption.className = "select-option";
      customOption.textContent = option.text;
      customOption.dataset.value = option.value;
      this.optionsContainer.appendChild(customOption);
    });

    // 组装结构
    this.customSelect.appendChild(this.selectedDisplay);
    this.customSelect.appendChild(this.optionsContainer);

    // 插入到DOM中
    this.originalSelect.parentNode.insertBefore(
      this.customSelect,
      this.originalSelect.nextSibling
    );
  }

  bindEvents() {
    // 点击选中区域显示/隐藏选项
    this.selectedDisplay.addEventListener("click", () => {
      this.toggleOptions();
    });

    // 点击选项
    this.optionsContainer.addEventListener("click", (e) => {
      if (e.target.classList.contains("select-option")) {
        this.selectOption(e.target);
      }
    });

    // 点击外部关闭
    document.addEventListener("click", (e) => {
      if (!this.customSelect.contains(e.target)) {
        this.hideOptions();
      }
    });
  }

  toggleOptions() {
    this.isOpen = !this.isOpen;

    if (this.isOpen) {
      this.optionsContainer.classList.add("show");
    } else {
      this.optionsContainer.classList.remove("show");
    }
  }

  hideOptions() {
    this.isOpen = false;
    this.optionsContainer.classList.remove("show");
  }

  selectOption(optionElement) {
    const value = optionElement.dataset.value;

    // 更新原生select
    this.originalSelect.value = value;

    // 触发change事件
    this.originalSelect.dispatchEvent(new Event("change"));

    // 更新显示
    this.updateSelectedDisplay();
    this.hideOptions();
  }

  updateSelectedDisplay() {
    const selectedOption =
      this.originalSelect.options[this.originalSelect.selectedIndex];
    this.selectedDisplay.textContent = selectedOption.text;
  }

  destroy() {
    // 移除事件监听器
    this.selectedDisplay.removeEventListener("click", this.toggleOptions);
    this.optionsContainer.removeEventListener("click", this.handleOptionClick);
    document.removeEventListener("click", this.boundHideOptions);
    this.originalSelect.removeEventListener("change", this.handleNativeChange);

    // 移除自定义DOM元素
    this.customSelect.innerHTML = "";

    // 清理引用
    this.customSelect = null;
    this.selectedDisplay = null;
    this.optionsContainer = null;
    this.boundHideOptions = null;
  }

  refresh() {
    this.destroy();
    this.createCustomSelect();
    this.bindEvents();
  }
}

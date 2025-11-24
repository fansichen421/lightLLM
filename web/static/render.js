function renderMessageWithMath(element, content) {

  // ----  规范化反斜杠和常见实体 ----
  function decodeHtmlEntities(str) {
    const txt = document.createElement("textarea");
    txt.innerHTML = str;
    return txt.value;
  }
  function normalizeBackslashes(str) {
    str = decodeHtmlEntities(str);
    str = str.replace(/&amp;#92;/g, "\\").replace(/&#92;/g, "\\");
    // 把类似 \\\[ 或 \\\$ 中多重反斜杠折叠成单个（只在常见数学定界符前折叠）
    str = str.replace(/\\{2,}(?=[\[\]\(\)\$])/g, "\\");
    str = str.replace(/\\{2,}\$/g, "\\$");
    return str;
  }

  // ---- 占位存储 ----
  const mathStore = [];


  // 抽离并渲染块级数学 $$...$$ 和 \[...\]
  content = content
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => {
      const html = katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
      });
      const idx = mathStore.push(html) - 1;
      return `@@MATH_BLOCK_${idx}@@`;
    })
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => {
      const html = katex.renderToString(tex, {
        displayMode: true,
        throwOnError: false,
      });
      const idx = mathStore.push(html) - 1;
      return `@@MATH_BLOCK_${idx}@@`;
    });

  // 抽离标准行内 LaTeX \( ... \)
  content = content.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => {
    const html = katex.renderToString(tex, {
      displayMode: false,
      throwOnError: false,
    });
    const idx = mathStore.push(html) - 1;
    return `@@MATH_INLINE_${idx}@@`;
  }).replace(/\$([\s\S]+?)\$/g, (m, tex) => {
    const html = katex.renderToString(tex, {
      displayMode: false,
      throwOnError: false,
    });
    const idx = mathStore.push(html) - 1;
    return `@@MATH_INLINE_${idx}@@`;
  });

  // 最后把剩余交给 marked 渲染
  let html = marked.parse(content);

  // 恢复 math 占位符（它们已经是 HTML）
  html = html.replace(/@@MATH_BLOCK_(\d+)@@/g, (_, n) => mathStore[Number(n)]);
  html = html.replace(/@@MATH_INLINE_(\d+)@@/g, (_, n) => mathStore[Number(n)]);

  // 写回 DOM
  element.innerHTML = html;

  // 生成语法高亮
  element.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block);
  });

  // 为代码块和公式添加复制按钮
  element.querySelectorAll("pre code").forEach((block) => {
    // 避免重复添加按钮
    if (block.parentNode.querySelector(".copy-btn")) return;

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
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
      let textToCopy = "";
      if (block.tagName.toLowerCase() === "code") {
        textToCopy = block.innerText; // 代码块
      } else {
        textToCopy = block.innerText; // 数学公式
      }

      navigator.clipboard.writeText(textToCopy).then(() => {
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

    // 插入按钮
    if (block.tagName.toLowerCase() === "code") {
      block.parentNode.style.position = "relative";
      block.parentNode.appendChild(copyBtn);
    } else {
      block.style.position = "relative";
      block.appendChild(copyBtn);
    }
  });
}

'use strict';
/* ============================================================
   稿有样 Draftory · 小红书图文卡片（cards/cards.js）
   ------------------------------------------------------------
   流程：粘贴长文 → 按 260–320 字分页（优先段落/句号处断开）
        → 渲染 1080×1440 卡片（封面 + 内容卡）
        → html2canvas 导出 PNG（1x 1080×1440 / 2x 2160×2880）
   依赖 CDN：html2canvas 1.4.1
     https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js

   付费分级 v1：
   · Pro 状态读 localStorage 键 gaoyouyang-pro-v1（"1" = 已激活），
     与主程序共用同一键，file:// 同源互通。
   · 免费状态：卡片渲染时插入右下角水印元素 .card-watermark，
     水印作为卡片 DOM 的一部分被 html2canvas 一起绘制（非导出后合成）。
   · 每次生成卡片、每次导出之前都会重新读取该键，状态变化即时生效。
   · 免费状态点「2x 高清」不导出，只弹出页面内说明对话框。
   ============================================================ */
(function () {

  const $ = (id) => document.getElementById(id);
  const CARD_W = 1080, CARD_H = 1440;
  const TARGET_CHARS = 300;                 // 每页目标字数（用于估算页数）
  const MIN_CHARS = 260, MAX_CHARS = 320;   // 每页正文预算
  const SENT_END = '。！？!?…';   // 只认这几种句末标点，分号不算断句
  const CLOSERS = '”’」』）)》】"\'';
  const HARD_SPLIT_AT = '；;，,、：:';

  const PRO_KEY = 'gaoyouyang-pro-v1';      // 与主程序共用的 Pro 状态键
  const WATERMARK_TEXT = '稿有样 Draftory';

  const state = { cards: [], total: 0, title: '', busy: false, timer: 0, pro: false };

  /* ---------------- Pro 状态 ---------------- */
  function readPro() {
    try { return localStorage.getItem(PRO_KEY) === '1'; } catch (e) { return false; }
  }

  /* 水印是卡片 DOM 的一部分：免费状态插入，Pro 状态移除 */
  function applyWatermark(card, pro) {
    const mark = card.querySelector('.card-watermark');
    if (pro) {
      if (mark) mark.remove();
      return;
    }
    if (mark) return;
    card.appendChild(el('div', 'card-watermark', WATERMARK_TEXT));
  }

  function label2xAll() { return '全部 2x 高清导出'; }   // 锁标由 CSS .is-locked::before 提供

  function renderProState() {
    const text = $('proStateText');
    const wrap = $('proState');
    if (text) text.textContent = state.pro ? 'Pro · 无水印' : '免费版 · 导出带水印';
    if (wrap) wrap.classList.toggle('is-pro', state.pro);
    const link = $('proStateLink');
    if (link) link.hidden = state.pro;
    const all2x = $('exportAll2x');
    if (all2x && !state.busy) {
      all2x.textContent = label2xAll();
      all2x.classList.toggle('is-locked', !state.pro);
    }
    document.querySelectorAll('.card-tools .btn-2x').forEach((btn) => {
      btn.classList.toggle('is-locked', !state.pro);
      btn.title = state.pro ? '导出 2160×2880 高清 PNG' : 'Pro 专属：2x 高清导出（2160×2880）';
    });
  }

  /* 每次生成 / 每次导出前调用：重新读取 Pro 状态并同步卡片水印与文案 */
  function syncPro() {
    state.pro = readPro();
    state.cards.forEach((item) => applyWatermark(item.node, state.pro));
    document.querySelectorAll('.grid .card').forEach((card) => applyWatermark(card, state.pro));
    renderProState();
    return state.pro;
  }

  /* ---------------- 工具 ---------------- */
  const visLen = (s) => (s || '').replace(/\s/g, '').length;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  function status(msg) { $('status').textContent = msg; }

  /* ---------------- 文本整理 ---------------- */
  // 去掉常见的 Markdown 记号，让粘贴进来的文本变成干净的正文
  function cleanLine(line) {
    return (line || '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/^>\s*/, '')
      .replace(/^\s*[-*+•]\s+/, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/\s+$/, '')
      .trim();
  }

  function paragraphsOf(body) {
    return body
      .split('\n')
      .map(cleanLine)
      .filter((line) => visLen(line) > 0);
  }

  /* 断句：保留标点，遇到成对引号/括号收尾时并回上一句 */
  function splitSentences(para) {
    const out = [];
    let buf = '';
    for (let i = 0; i < para.length; i++) {
      const ch = para[i];
      if (!buf && CLOSERS.indexOf(ch) > -1 && out.length) { out[out.length - 1] += ch; continue; }
      buf += ch;
      if (SENT_END.indexOf(ch) > -1) {
        let j = i + 1;
        while (j < para.length && (SENT_END.indexOf(para[j]) > -1 || CLOSERS.indexOf(para[j]) > -1)) {
          buf += para[j]; j++;
        }
        i = j - 1;
        out.push(buf); buf = '';
      }
    }
    if (buf.trim()) out.push(buf);
    return out.length ? out : [para];
  }

  /* 超长无标点句子：退一步在逗号/顿号处切开，避免整段撑爆卡片 */
  function hardSplit(sentence) {
    const parts = [];
    let rest = sentence;
    while (visLen(rest) > MAX_CHARS) {
      const limit = Math.min(rest.length, MAX_CHARS + 20);
      let cut = -1;
      for (let i = limit; i > Math.floor(MAX_CHARS * 0.55); i--) {
        if (HARD_SPLIT_AT.indexOf(rest[i - 1]) > -1) { cut = i; break; }
      }
      if (cut < 0) cut = Math.min(rest.length, MAX_CHARS);
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest.trim()) parts.push(rest);
    return parts.length ? parts : [sentence];
  }

  /* 把段落拆成带段落归属的句子块 */
  function buildBlocks(paras) {
    const blocks = [];
    paras.forEach((para, pi) => {
      splitSentences(para).forEach((s) => blocks.push({ text: s, pi: pi }));
    });
    return blocks;
  }

  /* 分页：先按总量估算页数，再让每一页的"配额"随剩余字数和剩余页数动态调整，
     使各页字数尽量接近（避免前几页装满、最后一页只剩两行的残页）。
     断开位置只落在句末/段末，单页字数仍控制在 240–320 附近。 */
  function paginate(paras) {
    const blocks = buildBlocks(paras);
    const total = blocks.reduce((sum, b) => sum + visLen(b.text), 0);
    const pageCount = Math.max(1, Math.round(total / TARGET_CHARS));

    const pages = [];
    let cur = null, curLen = 0, emitted = 0;

    const pushPage = () => {
      if (!cur || !cur.length) return;
      pages.push(cur);
      emitted += curLen;
      cur = null; curLen = 0;
    };

    blocks.forEach((block) => {
      const pieces = visLen(block.text) > MAX_CHARS ? hardSplit(block.text) : [block.text];
      pieces.forEach((piece) => {
        const len = visLen(piece);
        const remainPages = Math.max(1, pageCount - pages.length);
        const quota = (total - emitted) / remainPages;       // 本页该装多少
        const stopAt = Math.max(MIN_CHARS, Math.min(MAX_CHARS, quota));
        const full = curLen >= stopAt * 0.94 && curLen + len > stopAt * 1.04;
        const over = curLen >= 252 && curLen + len > MAX_CHARS + 6;   // 硬上限兜底
        if (curLen > 0 && (full || over)) {
          pushPage();
        }
        if (!cur) cur = [];
        const last = cur[cur.length - 1];
        if (last && last.pi === block.pi) {
          last.text += piece;            // 同段落继续，不额外分段
        } else {
          cur.push({ pi: block.pi, text: piece });
        }
        curLen += len;
      });
    });
    pushPage();

    // 孤行处理：某页末尾只剩很短的一小截（< 26 字），挪到下一页并接回同段，
    // 避免卡片底部挂着「然后是词。」这种只有半句的残行。
    for (let i = 0; i < pages.length - 1; i++) {
      const page = pages[i], next = pages[i + 1];
      if (page.length < 2) continue;
      const tail = page[page.length - 1];
      const tailLen = visLen(tail.text);
      const nextLen = next.reduce((s, p) => s + visLen(p.text), 0);
      if (tailLen < 26 && nextLen + tailLen <= MAX_CHARS + 40) {
        page.pop();
        if (next[0] && next[0].pi === tail.pi) next[0].text = tail.text + next[0].text;
        else next.unshift(tail);
      }
    }
    return pages;
  }

  /* ---------------- 卡片渲染 ---------------- */
  function cardShell(kind, index, total) {
    const card = el('article', 'card ' + (kind === 'cover' ? 'is-cover' : 'is-content'));
    card.dataset.index = String(index);
    card.appendChild(el('div', 'card-paper'));
    card.appendChild(el('div', 'card-frame'));
    card.appendChild(el('div', 'card-corner'));
    card.appendChild(el('div', 'card-corner-2'));

    const inner = el('div', 'card-inner');
    const head = el('div', 'card-head');
    head.appendChild(el('span', 'dot'));
    head.appendChild(el('span', 'kicker', 'DRAFTORY'));
    head.appendChild(el('span', 'rule'));
    inner.appendChild(head);

    const foot = el('div', 'card-foot');
    foot.appendChild(el('span', 'foot-brand', WATERMARK_TEXT));
    foot.appendChild(el('span', 'foot-page', index + ' / ' + total));
    card.appendChild(inner);
    card.appendChild(foot);
    applyWatermark(card, state.pro);
    return { card: card, inner: inner };
  }

  function buildCover(title, sub, total) {
    const shell = cardShell('cover', 1, total);
    const orn = el('div', 'cover-orn');
    const orn2 = el('div', 'cover-orn-2');
    const orn3 = el('div', 'cover-orn-3');
    shell.card.appendChild(orn);
    shell.card.appendChild(orn2);
    shell.card.appendChild(orn3);

    const body = el('div', 'cover-body');
    body.appendChild(el('p', 'cover-eyebrow', '小红书图文 · 长文精选'));
    body.appendChild(el('h1', 'cover-title', title));
    body.appendChild(el('span', 'cover-rule'));
    body.appendChild(el('p', 'cover-sub', sub));
    shell.inner.appendChild(body);
    return shell.card;
  }

  function buildContent(pageParas, index, total) {
    const shell = cardShell('content', index, total);
    const wrap = el('div', 'body-wrap');
    const paras = el('div', 'paras');
    pageParas.forEach((p) => paras.appendChild(el('p', 'para', p.text)));
    wrap.appendChild(paras);
    shell.inner.appendChild(wrap);
    return shell.card;
  }

  /* 正文自适应：
     卡片挂载后用真实位置度量「最后一行」与「页脚细线」的间距，
     不足 24px 就逐级缩小字号（34 → 24），保证 320 字也不会压到页脚。 */
  function fitText() {
    document.querySelectorAll('.grid .card.is-content').forEach((card) => {
      const paras = card.querySelector('.paras');
      const foot = card.querySelector('.card-foot');
      if (!paras || !foot) return;
      const gap = () => foot.getBoundingClientRect().top - paras.getBoundingClientRect().bottom;
      let size = 34;
      paras.style.fontSize = size + 'px';
      while (gap() < 24 && size > 24) {
        size -= 1;
        paras.style.fontSize = size + 'px';
      }
      card.dataset.fontsize = String(size);
      card.dataset.gap = String(Math.round(gap()));
    });
  }

  /* ---------------- 解析输入 ---------------- */
  function parseSource() {
    const raw = $('source').value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!raw) return null;

    const lines = raw.split('\n');
    const firstIdx = lines.findIndex((l) => visLen(l) > 0);
    const firstLine = firstIdx > -1 ? cleanLine(lines[firstIdx]) : '';
    const manualTitle = $('title').value.trim();
    const manualSub = $('subtitle').value.trim();

    let title = manualTitle || firstLine || '未命名长文';
    if (title.length > 32) title = title.slice(0, 32) + '…';

    // 正文：第一行统一作为标题行使用（手填标题时同样剔除，避免封面与正文重复）
    const bodyLines = lines.slice();
    if (firstIdx > -1) bodyLines[firstIdx] = '';

    const body = bodyLines.join('\n');
    const paras = paragraphsOf(body);
    if (!paras.length) return null;

    const pages = paginate(paras);
    const total = pages.length + 1;
    const chars = visLen(paras.join(''));
    const sub = manualSub || ('全文 ' + chars + ' 字 · 共 ' + total + ' 张');

    return { title: title, sub: sub, pages: pages, chars: chars, total: total };
  }

  /* ---------------- 渲染整页 ---------------- */
  function render() {
    const data = parseSource();
    const grid = $('grid');
    grid.textContent = '';
    state.cards = [];

    if (!data) {
      state.total = 0; state.title = '';
      $('empty').style.display = '';
      $('mChars').textContent = '0';
      $('mCards').textContent = '0';
      $('mAvg').textContent = '0';
      $('exportAll').disabled = true;
      $('exportAll2x').disabled = true;
      status('等待输入…');
      $('stageHint').textContent = '第 1 张为封面卡，其余为内容卡';
      syncPro();
      return;
    }

    $('empty').style.display = 'none';
    state.title = data.title;
    state.total = data.total;
    state.cards = [];

    // 封面卡
    const cover = buildCover(data.title, data.sub, data.total);
    state.cards.push({ node: cover, label: '封面卡', chars: 0 });
    // 内容卡
    data.pages.forEach((page, i) => {
      const node = buildContent(page, i + 2, data.total);
      const n = page.reduce((sum, p) => sum + visLen(p.text), 0);
      state.cards.push({ node: node, label: '第 ' + (i + 2) + ' 张', chars: n });
    });

    state.cards.forEach((item, i) => {
      const slot = el('div', 'slot');
      const holder = el('div', 'card-holder');
      holder.appendChild(item.node);
      const tools = el('div', 'card-tools');
      const tag = el('span', 'tag');
      tag.innerHTML = i === 0
        ? '封面 · <b>' + data.total + '</b> 张'
        : item.label + ' · <b>' + item.chars + '</b> 字';
      const btns = el('div', 'btns');
      const btn = el('button', null, '导出 PNG');
      btn.type = 'button';
      btn.dataset.kind = '1x';
      btn.addEventListener('click', () => exportOne(i, btn, 1));
      const btn2x = el('button', 'btn-2x', '2x 高清');
      btn2x.type = 'button';
      btn2x.dataset.kind = '2x';
      btn2x.addEventListener('click', () => exportOne(i, btn2x, 2));
      btns.appendChild(btn);
      btns.appendChild(btn2x);
      tools.appendChild(tag);
      tools.appendChild(btns);
      slot.appendChild(holder);
      slot.appendChild(tools);
      grid.appendChild(slot);
    });

    fitText();
    fitCards();
    syncPro();

    const contentCount = data.pages.length;
    const avg = contentCount ? Math.round(data.chars / contentCount) : 0;
    $('mChars').textContent = data.chars;
    $('mCards').textContent = data.total;
    $('mAvg').textContent = avg;
    $('exportAll').disabled = false;
    $('exportAll2x').disabled = false;
    $('stageHint').textContent = '共 ' + data.total + ' 张 · 1 张封面 + ' + contentCount + ' 张内容卡';
    status('已生成 ' + data.total + ' 张卡片（封面 1 张 + 内容 ' + contentCount +
      ' 张），内容页平均 ' + avg + ' 字。单张可单独导出，也可一次全部导出。');
  }

  /* 预览缩放：卡片保持 1080×1440 真实尺寸，用 transform 缩到栅格宽度 */
  function fitCards() {
    document.querySelectorAll('.card-holder').forEach((holder) => {
      const card = holder.querySelector('.card');
      if (!card) return;
      const w = holder.clientWidth;
      if (!w) return;
      const scale = w / CARD_W;
      card.style.transform = 'scale(' + scale + ')';
      holder.style.height = Math.round(w * CARD_H / CARD_W) + 'px';
    });
  }

  /* ---------------- 导出 ---------------- */
  function fileSlug(name) {
    const s = (name || '卡片').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
    return (s || '卡片').slice(0, 28);
  }

  async function ensureRenderer() {
    if (typeof window.html2canvas === 'function') return true;
    toast('渲染库 html2canvas 未加载，请联网后刷新页面再导出');
    return false;
  }

  async function renderNode(cardNode, scale) {
    const stage = $('exportStage');
    const clone = cardNode.cloneNode(true);
    clone.style.transform = 'none';
    stage.appendChild(clone);
    // 等两帧，确保克隆节点完成布局
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const canvas = await window.html2canvas(clone, {
        width: CARD_W,
        height: CARD_H,
        scale: scale === 2 ? 2 : 1,      // 2x → 2160×2880
        backgroundColor: '#f8f3ea',
        useCORS: true,
        logging: false,
        removeContainer: true
      });
      return canvas;
    } finally {
      stage.removeChild(clone);
    }
  }

  function download(canvas, filename) {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------------- 免费版 2x 拦截说明对话框 ---------------- */
  let lastFocus = null;
  function openProModal() {
    const modal = $('proModal');
    if (!modal) return;
    lastFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const close = $('proModalClose');
    if (close) close.focus();
  }

  function closeProModal() {
    const modal = $('proModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
    lastFocus = null;
  }

  const sizeOf = (scale) => (scale === 2 ? '2160×2880' : '1080×1440');
  const suffixOf = (scale) => (scale === 2 ? '-2x' : '');

  async function exportOne(index, btn, scale) {
    scale = scale === 2 ? 2 : 1;
    if (state.busy) { toast('正在导出，请稍候…'); return; }
    const pro = syncPro();                        // 每次导出前重新读取 Pro 状态
    if (scale === 2 && !pro) { openProModal(); return; }   // 免费版：只弹说明，不导出
    if (!(await ensureRenderer())) return;
    const item = state.cards[index];
    if (!item) return;
    state.busy = true;
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
    try {
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
      const canvas = await renderNode(item.node, scale);
      const name = fileSlug(state.title) + '-' + String(index + 1).padStart(2, '0') + suffixOf(scale) + '.png';
      download(canvas, name);
      toast('已导出 ' + name + '（' + canvas.width + '×' + canvas.height + '）' + (pro ? '' : ' · 免费版含水印'));
    } catch (err) {
      toast('导出失败：' + (err && err.message ? err.message : '未知错误'));
    } finally {
      state.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = old || (scale === 2 ? '2x 高清' : '导出 PNG'); }
      renderProState();
    }
  }

  async function exportAll(scale) {
    scale = scale === 2 ? 2 : 1;
    if (state.busy) { toast('正在导出，请稍候…'); return; }
    if (!state.cards.length) { toast('还没有可导出的卡片'); return; }
    const pro = syncPro();                        // 每次导出前重新读取 Pro 状态
    if (scale === 2 && !pro) { openProModal(); return; }   // 免费版：只弹说明，不导出
    if (!(await ensureRenderer())) return;
    state.busy = true;
    const btn = scale === 2 ? $('exportAll2x') : $('exportAll');
    btn.disabled = true;
    const old = btn.textContent;
    try {
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
      for (let i = 0; i < state.cards.length; i++) {
        btn.textContent = '导出中 ' + (i + 1) + '/' + state.cards.length;
        const canvas = await renderNode(state.cards[i].node, scale);
        const name = fileSlug(state.title) + '-' + String(i + 1).padStart(2, '0') + suffixOf(scale) + '.png';
        download(canvas, name);
        await new Promise((r) => setTimeout(r, 320)); // 给浏览器留出写盘时间
      }
      toast('已导出 ' + state.cards.length + ' 张 PNG（' + sizeOf(scale) + '）' + (pro ? '' : ' · 免费版含水印') +
        '。若浏览器拦截多文件下载，请允许本站点的多次下载。');
    } catch (err) {
      toast('批量导出中断：' + (err && err.message ? err.message : '未知错误'));
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = scale === 2 ? label2xAll() : old;
      renderProState();
    }
  }

  /* ---------------- 示例文本（约 1500 字） ---------------- */
  const SAMPLE = [
    '为什么你的长文，读者总是读不完',
    '我观察过很多做得不错的账号。作者写得很认真，观点也扎实，结构上甚至做了三层小标题，可文章的完读率始终停在两成上下。他们通常把原因归结为「内容不够爆」，却忽略了一个更基础的事实：读者在手机屏幕上的耐心，是以秒为单位计算的，而不是以段为单位。',
    '一篇文章发出去，读者第一眼看到的从来不是论点，而是版式。字距是不是拥挤，段落是不是太长，重点有没有被标出来，这些小细节在三百毫秒之内就替他做了一个决定：继续往下滑，还是直接退出。',
    '所以当我重做自己的排版流程时，第一件事不是换字体，而是给文章装一套「呼吸系统」。做法很笨：每段不超过四行，每个论点之间至少留一个空行，每八百字插入一个小结，让眼睛有地方可以停下来喘口气。',
    '第二个改动是删。初稿写完之后，我会从头到尾读一遍，把所有「其实」「某种程度上」「在我看来」这类词删掉。它们看起来无害，实际上一直在稀释句子的力度。删完之后，同样一段话的字数通常能少三成，信息量却一点没减，读起来反而更快。',
    '第三个改动是把长句拆开。中文的句子一旦超过四十个字，读者的工作记忆就开始吃力。你得在他快要忘记主语的时候，及时给一个句号。句号不是停顿，是递给读者的一个台阶，让他能跟上你的思路继续走。',
    '还有一件事容易被忽略：留白也是内容。段落之间的空白不是浪费版面，而是给读者一次整理信息的机会。把八百字塞满一屏，看着信息量很大，实际上读者什么都留不下；分成三段，他至少能记住三个要点。',
    '做完这几件事之后，我发现了一个有点反直觉的现象：文章变短了，留言反而变多了。因为读得完，读者才有话可说；读不完，再好的观点也只是一段被手指划走的文字，连被误解的机会都没有。',
    '排版不是装饰，它更像是把作者的思考翻译成读者能接收的形式。一份好的排版应该像一条平整的路：读者走上去不会注意到路面，只会顺顺利利地到达终点。',
    '具体来说，我现在写一篇长文，会先列一张只有十行的骨架，每一行就是一个小标题。骨架定完再动笔，写的时候就不会跑偏，也不会为了凑字数而绕圈子。骨架是路标，字数只是结果。',
    '然后是标题。标题不要写结论，要写冲突。结论让人点头，冲突让人想点开。比如「如何提高完读率」是结论，「为什么你的长文没人读完」是冲突，后者显然更容易被手指选中。',
    '配图也值得说一句。很多人喜欢在文章里塞满截图和表情包，觉得这样显得丰富。其实图片的作用是让眼睛休息，不是填补空白。一段文字配一张图，节奏刚好；连续三张图，读者就会开始快速滑动，然后一路滑到底部。',
    '最后是结尾。结尾不要总结，总结等于告诉读者「你可以走了」。更好的做法是留一个问题，或者给一个明天就能做的小动作。让文章在他的生活里继续待一会儿，比让他在评论区夸你一句更有价值。',
    '我把这套流程整理成一张便签，贴在显示器边上：先骨架，再删词，然后拆句，最后留白。每次写完都照着过一遍，平均多花十五分钟，但一篇稿子的寿命会长很多。',
    '说到底，写作是把自己脑子里的东西搬出来，排版是把它摆到别人看得见的地方。搬运需要力气，摆放需要耐心，两件事都做到，文字才真正抵达。'
  ].join('\n\n');

  /* ---------------- 事件绑定 ---------------- */
  function scheduleRender() {
    clearTimeout(state.timer);
    state.timer = setTimeout(render, 450);
  }

  function init() {
    $('generate').addEventListener('click', render);
    $('exportAll').addEventListener('click', () => exportAll(1));
    $('exportAll2x').addEventListener('click', () => exportAll(2));
    $('demo').addEventListener('click', () => {
      $('source').value = SAMPLE;
      $('title').value = '';
      $('subtitle').value = '';
      render();
      toast('已填入示例长文（约 ' + visLen(SAMPLE.replace(/\n/g, '')) + ' 字）');
    });
    $('clear').addEventListener('click', () => {
      $('source').value = ''; $('title').value = ''; $('subtitle').value = '';
      render();
    });
    ['source', 'title', 'subtitle'].forEach((id) => {
      $(id).addEventListener('input', scheduleRender);
    });

    // 2x 未解锁说明对话框：关闭按钮 / 遮罩 / 稍后再说 / Esc
    const modal = $('proModal');
    if (modal) {
      $('proModalClose').addEventListener('click', closeProModal);
      $('proModalMask').addEventListener('click', closeProModal);
      $('proModalLater').addEventListener('click', closeProModal);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hidden) closeProModal();
      });
    }

    // 主页面激活 / 取消激活后，回到本页或切回标签时同步水印与 2x 可用性
    window.addEventListener('storage', (e) => {
      if (!e || e.key === PRO_KEY || e.key === null) syncPro();
    });
    window.addEventListener('focus', syncPro);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncPro(); });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitCards, 120);
    });

    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

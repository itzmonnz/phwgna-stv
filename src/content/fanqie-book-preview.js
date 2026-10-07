(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STVAIFanqieBookPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const cards = '.muye-home-top-rank-list-item,.muye-bottom-choiceness-item,.muye-bottom-rank-content .rank-item,.rank-book-item,.book-item,.muye-stack-book-list .book,.home-publish-list-item';
  const titles = '.muye-home-top-rank-list-item-info-name,.book-text .title,h3.title,.book-item-text .title,.book-name,.book-item-title';
  function state(document, section) {
    for (const script of document.querySelectorAll('script:not([src])')) {
      if (script.textContent.length > 2000000) continue;
      const match = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*\});/.exec(script.textContent);
      if (match) { try { return JSON.parse(match[1])[section] || {}; } catch (_) { return {}; } }
    }
    return {};
  }
  function book(record) {
    const id = String(record?.bookId || record?.book_id || '');
    const name = record?.bookName || record?.book_name;
    if (!/^\d{10,25}$/.test(id) || typeof name !== 'string' || !name.trim()) return null;
    let tags = [];
    try { tags = JSON.parse(record.categoryV2 || '[]').map(tag => tag.Name).filter(name => typeof name === 'string'); } catch (_) {}
    if (!tags.length && record.category) tags = [record.category];
    return { id, title: name.trim(), author: String(record.author || ''), tags: tags.slice(0,20), intro: String(record.abstract || ''), cover: record.thumbUri || record.thumb_url || '' };
  }
  function collect(value, output = [], depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8 || output.length >= 1000) return output;
    const found = book(value);
    if (found) output.push(found);
    else for (const child of Object.values(value)) collect(child, output, depth + 1);
    return output;
  }
  function install(document, { translate, loadBook, loadBookIndex, loadRankBooks, decodeName = source=>source, holdMs = 550,
    cardSelector = cards, titleSelector = titles, siteLabel = 'Fanqie', resolveBook, bookHref = id => `/page/${id}` } = {}) {
    const cards = cardSelector, titles = titleSelector;
    const view = document.defaultView;
    let gesture, timer, blocked, generation = 0, destroyed = false, indexRequest;
    const details = new Map();
    const host = document.createElement('div'); host.id = 'stvai-fanqie-book-preview';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial}*{box-sizing:border-box}dialog{position:fixed;inset:0;margin:auto;width:min(560px,calc(100vw - 28px));max-height:calc(100dvh - 40px);padding:0;border:1px solid rgba(255,255,255,.8);border-radius:24px;background:rgba(255,255,255,.96);color:#28323c;box-shadow:0 24px 80px rgba(25,35,45,.2);font:15px/1.65 Arial,sans-serif;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}dialog::backdrop{background:rgba(30,40,50,.3);backdrop-filter:blur(8px)}.content{padding:26px}.eyebrow{margin:0 40px 18px 0;font-size:11px;letter-spacing:.12em;color:#8a6b4f;text-transform:uppercase}.head{display:flex;gap:18px;align-items:flex-start}.cover{width:78px;height:106px;object-fit:cover;border-radius:10px;box-shadow:0 5px 14px rgba(30,40,50,.12);flex:none}h2{margin:0;font-size:22px;line-height:1.45;overflow-wrap:anywhere}.author{margin:8px 0 0;color:#687582;font-size:13px}.tags{display:flex;flex-wrap:wrap;gap:7px;margin:20px 0}.tag{padding:4px 10px;border-radius:8px;background:#f4f0eb;color:#78624d;font-size:12px;overflow-wrap:anywhere}.intro{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.label{font-size:12px;font-weight:bold;color:#687582;margin:24px 0 8px}.status{color:#86909a;font-size:12px;margin:16px 0}.open{display:block;text-align:center;background:#ba5a36;color:white;text-decoration:none;padding:12px;border-radius:12px;font-weight:bold}.open[hidden]{display:none}.close{position:absolute;right:14px;top:12px;width:40px;height:40px;border:0;border-radius:50%;background:#f1f2f3;color:#697581;font-size:24px;cursor:pointer}.close:focus-visible,.open:focus-visible{outline:3px solid #ca9676;outline-offset:3px}@media(max-width:600px){dialog{margin:auto auto 12px;border-radius:24px;width:calc(100vw - 20px)}.content{padding:24px 20px}h2{font-size:20px}}`;
    style.textContent += `dialog{overflow:hidden}.content{max-height:calc(100dvh - 40px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:auto;scrollbar-color:auto}.content::-webkit-scrollbar{width:5px;height:5px}.content::-webkit-scrollbar-track{background:transparent}.content::-webkit-scrollbar-thumb{background:rgba(100,110,120,.28);border-radius:999px}.content::-webkit-scrollbar-thumb:hover{background:rgba(100,110,120,.52)}.content::-webkit-scrollbar-button{display:none}.close{z-index:1}`;
    const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'Xem nhanh truyện');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'close'; close.textContent = '×'; close.setAttribute('aria-label', 'Đóng xem nhanh');
    const content = document.createElement('div'); content.className = 'content';
    const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text) node.textContent = text; return node; };
    const eyebrow = make('p','eyebrow',siteLabel + ' · Xem nhanh'), head = make('div','head'), cover = make('img','cover'); cover.alt = ''; cover.hidden = true;
    const heading = make('div','heading'), title = make('h2','title'), author = make('p','author'); heading.append(title,author); head.append(cover,heading);
    const tags = make('div','tags'), label = make('p','label','Giới thiệu'), intro = make('p','intro'), status = make('p','status'); status.setAttribute('role','status');
    const open = make('a','open','Mở truyện'); open.hidden = true;
    content.append(eyebrow,head,tags,label,intro,status,open); dialog.append(close,content); shadow.append(style,dialog); document.body.append(host);
    const dismiss = () => { generation++; if (dialog.open) dialog.close(); };
    close.addEventListener('click',dismiss);
    dialog.addEventListener('cancel',() => generation++);
    dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dismiss(); });
    const index = async () => {
      if (!indexRequest) indexRequest = Promise.resolve().then(()=>loadBookIndex?.()).then(data=>{if (!Array.isArray(data) || !data.length) {indexRequest=null;return [];}return data;}).catch(() => { indexRequest = null; return []; });
      return indexRequest;
    };
    const load = async (card, source) => {
      if (resolveBook) return resolveBook(card, source);
      const href = card.matches('a') ? card.getAttribute('href') : card.querySelector('a[href*="/page/"]')?.getAttribute('href');
      const match = /^\/page\/(\d{10,25})\/?$/.exec(href || '');
      const matches = [...new Map(collect(state(document,'home')).map(record=>[record.id,record])).values()].filter(record => record.title === source);
      let record = matches.length === 1 ? matches[0] : null;
      if (!record && !match && card.closest('.muye-bottom-rank-content')) {
        const item=card.closest('.muye-bottom-rank-view-item'),wrap=item?.parentElement;
        const header=document.querySelector('.muye-bottom-rank-header');
        const rank={index:wrap?[...wrap.children].indexOf(item):-1,gender:header?.children[1]?.classList.contains('selected')?2:1,mold:card.closest('.muye-bottom-rank-content-block.new')?1:2};
        const list=await loadRankBooks?.(rank);
        const node=card.querySelector(titles)||card;
        const candidates=(Array.isArray(list)?list:[]).filter(record=>decodeName(record.title,node)===source);
        if(candidates.length===1)record=candidates[0];
      }
      if (!record && !match) { const candidates = (await index()).filter(record=>record.title===source); if (candidates.length === 1) record = candidates[0]; }
      const id = match?.[1] || record?.id;
      if (!id) return null;
      if (!details.has(id)) {
        const promise = Promise.resolve().then(()=>loadBook?.(id)).then(result => result?.id === id ? result : null).catch(()=>null);
        details.set(id,promise); promise.then(result=>{ if (!result) details.delete(id); });
        while (details.size > 128) details.delete(details.keys().next().value);
      }
      return await details.get(id);
    };
    async function show(card) {
      const token = ++generation;
      const node = card.querySelector(titles) || card;
      const tooltip = node.getAttribute('title') || '';
      const source = tooltip.includes('Hachimi 40') ? tooltip.split('\n')[1] : (card.querySelector('img')?.alt || node.textContent.trim());
      title.textContent = node.textContent.trim(); author.textContent = ''; tags.replaceChildren(); cover.hidden = true; open.hidden = true;
      intro.textContent = 'Đang lấy giới thiệu…'; status.textContent = 'Chỉ tải thông tin truyện bạn đang xem.';
      if (!dialog.open) dialog.showModal();
      const record = await load(card,source);
      if (destroyed || token !== generation || !dialog.open) return;
      if (!record) { intro.textContent = 'Chưa lấy được thông tin truyện này. Đóng bảng rồi thử lại.'; status.textContent = ''; return; }
      const safeImage = /^https:\/\//.test(record.cover) ? record.cover : '';
      if (safeImage) { cover.src = safeImage; cover.hidden = false; }
      title.textContent = record.title; author.textContent = record.author; intro.textContent = record.intro || 'Trang chưa cung cấp giới thiệu.';
      open.href = bookHref(record.id); open.hidden = false;
      const tagNodes = record.tags.map(text=>make('span','tag',text)); tags.append(...tagNodes);
      const fields = [[title,record.title,'title'],[author,record.author,'author'],...tagNodes.map((node,i)=>[node,record.tags[i],'category']),[intro,record.intro,'introduction']].filter(([,source])=>source);
      status.textContent = translate ? 'Đang dịch thông tin bằng Hachimi 40…' : '';
      let missing = false;
      const errors = new Set();
      const safeReasons = new Set(['queue_full','disabled','invalid_source','provider_busy','provider_unreachable','provider_ui_changed','model_timeout','model_error','response_receipt_missing','response_mismatch','invalid_translation','provider_edited','model_unavailable']);
      delete host.dataset.translationErrors;
      await Promise.all(fields.map(async ([node,source,kind]) => {
        try { const result = await translate?.(source,kind); if (destroyed || token !== generation || !dialog.open) return; if (result?.text) node.textContent = result.text; else if (/[\u3400-\u9fff]/.test(source)) { missing = true; errors.add(safeReasons.has(result?.reason) ? result.reason : 'translation_unavailable'); } }
        catch (_) { missing = true; errors.add('provider_unreachable'); }
      }));
      if (!destroyed && token === generation && dialog.open) {
        host.dataset.translationErrors = [...errors].join(',');
        status.textContent = missing ? 'Một số phần chưa dịch được; đang giữ chữ gốc.' : 'Hachimi 40 · bản dịch được dùng lại từ cache khi có.';
        if (errors.size) status.textContent += ` (${[...errors].join(', ')})`;
      }
    }
    const cancel = () => { view.clearTimeout(timer); gesture = null; };
    const down = event => {
      cancel(); if (event.button !== 0 || event.isPrimary === false) return;
      const card = event.target.closest?.(cards); if (!card || card.closest('#stvai-fanqie-ui')) return;
      gesture = { card, x:event.clientX, y:event.clientY, id:event.pointerId };
      timer = view.setTimeout(() => { if (!gesture || !card.isConnected) return; blocked = { card, until:Infinity }; gesture = null; void show(card); },holdMs);
    };
    const move = event => { if (gesture && (event.pointerId !== gesture.id || Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>10)) cancel(); };
    const click = event => { if (blocked && Date.now()<blocked.until && blocked.card.contains(event.target)) { event.preventDefault(); event.stopImmediatePropagation(); blocked = null; } };
    const up = () => { if (blocked) blocked.until = Date.now()+800; cancel(); };
    const context = event => { if (gesture || blocked && Date.now()<blocked.until && blocked.card.contains(event.target)) { event.preventDefault(); } };
    document.addEventListener('pointerdown',down,true); document.addEventListener('pointermove',move,true);
    document.addEventListener('pointerup',up,true); document.addEventListener('pointercancel',up,true);
    document.addEventListener('scroll',cancel,true); document.addEventListener('click',click,true); document.addEventListener('contextmenu',context,true);
    const navigate = () => { cancel(); dismiss(); }; view.addEventListener('popstate',navigate);
    return { show, dismiss, destroy() { destroyed = true; navigate(); document.removeEventListener('pointerdown',down,true); document.removeEventListener('pointermove',move,true); document.removeEventListener('pointerup',up,true); document.removeEventListener('pointercancel',up,true); document.removeEventListener('scroll',cancel,true); document.removeEventListener('click',click,true); document.removeEventListener('contextmenu',context,true); view.removeEventListener('popstate',navigate); host.remove(); } };
  }
  return { install, state, book, collect, cards };
});

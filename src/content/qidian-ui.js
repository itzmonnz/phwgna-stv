(function(root,factory){
  const api=factory(root.STVAIQidianSites||(typeof require==='function'?require('../shared/qidian-sites.js'):null),root.STVAIFanqiePreferences||(typeof require==='function'?require('../shared/fanqie-preferences.js'):null),root.STVAIUI||(typeof require==='function'?require('./stv-ui.js'):null),root.STVAINameManager||(typeof require==='function'?require('./stv-name-manager.js'):null));
  if(typeof module==='object'&&module.exports)module.exports=api;
  else if(root.document && api.allowed(root.location.href))void api.start(root.document,root.chrome.runtime);
})(typeof globalThis!=='undefined'?globalThis:this,function(sites,prefs,ui,panels){
  'use strict';
  const fixed=new Map(Object.entries({
    '起点中文网':'Qidian · Khởi Điểm','起点女生网':'Qidian nữ','首页':'Trang chủ','我的书架':'Tủ sách','全部作品':'Tất cả truyện','作品分类':'Thể loại','排行':'Xếp hạng','完本':'Hoàn thành','完结':'Hoàn thành','免费':'Miễn phí','作家专区':'Tác giả','搜索':'Tìm kiếm','女生网':'Truyện nữ','客户端':'Ứng dụng','页游':'Game','登录':'Đăng nhập','注册':'Đăng ký','繁体版':'Phồn thể',
    '玄幻':'Huyền huyễn','奇幻':'Kỳ ảo','武侠':'Võ hiệp','仙侠':'Tiên hiệp','都市':'Đô thị','现实':'Hiện thực','军事':'Quân sự','历史':'Lịch sử','游戏':'Trò chơi','体育':'Thể thao','科幻':'Khoa học viễn tưởng','诸天无限':'Chư thiên vô hạn','悬疑灵异':'Bí ẩn, linh dị','轻小说':'Light novel','短篇':'Truyện ngắn',
    '更多':'Xem thêm','展开更多':'Xem thêm','展开':'Mở rộng','收起':'Thu gọn','分类':'Thể loại','全部分类':'Mọi thể loại','全部':'Tất cả','男生':'Truyện nam','女生':'Truyện nữ','标签':'Tag','属性':'Thuộc tính','字数':'Số chữ','品质':'Chất lượng','更新时间':'Cập nhật','签约作品':'Đã ký hợp đồng','精品小说':'Truyện chọn lọc','连载':'Đang ra','收费':'Trả phí','总收藏':'Lượt lưu','总字数':'Tổng số chữ','推荐票':'Phiếu đề cử','月票':'Phiếu tháng','人气排序':'Theo độ nổi bật',
    '本周强推':'Đề cử trong tuần','编辑推荐':'Biên tập đề cử','热门作品':'Truyện nổi bật','新书推荐':'Truyện mới','最近更新':'Mới cập nhật','完本精品':'Truyện hoàn thành chọn lọc','完本排行':'Xếp hạng hoàn thành','免费阅读':'Đọc miễn phí','限时免费':'Miễn phí có thời hạn','VIP章节免费读':'Đọc miễn phí chương VIP','全部小说':'Tất cả truyện',
    '人气榜单':'Bảng nổi bật','热门作品排行':'Xếp hạng truyện nổi bật','月票榜':'Bảng phiếu tháng','畅销榜':'Bảng bán chạy','留存榜':'Bảng giữ chân độc giả','阅读指数榜':'Bảng chỉ số đọc','书友榜':'Bảng độc giả','推荐榜':'Bảng đề cử','追读榜':'Bảng theo đọc','收藏榜':'Bảng lượt lưu','更新榜':'Bảng cập nhật','VIP收藏榜':'Bảng lượt lưu VIP','新书排行':'Xếp hạng truyện mới','签约新书榜':'Truyện mới ký hợp đồng','潜力榜':'Bảng tiềm năng','未签约新书榜':'Truyện mới chưa ký','其他排行':'Bảng khác','女生精选榜':'Truyện nữ chọn lọc','女生月票榜':'Phiếu tháng truyện nữ','榜单规则':'Quy tắc xếp hạng',
    '作品简介':'Giới thiệu','目录':'Mục lục','免费试读':'Đọc thử miễn phí','立即阅读':'Đọc ngay','加入书架':'Thêm vào tủ sách','书籍详情':'Chi tiết truyện','作品荣誉':'Thành tích','作者':'Tác giả','上一章':'Chương trước','下一章':'Chương sau','设置':'Cài đặt','书评':'Bình luận','本章说':'Bình luận chương','发表评论':'Gửi bình luận','订阅':'Mua chương','打赏':'Tặng thưởng','返回书页':'Về trang truyện'
  }));
  const blocked='script,style,noscript,svg,canvas,iframe,input,textarea,select,[contenteditable],code,pre,[data-stvai-qidian],#stvai-qidian-ui,#stvai-fanqie-book-preview,a[href*="/user/"],[class*="login"],[class*="account"],[class*="avatar"],[class*="nickname"],[class*="user-name"],[class*="username"],[class*="user-info"],[class*="payment"],[class*="charge"]';
  const kindOrder={ui:0,title:1,category:2,description:3,author:4,chapter:5,comment:6};
  function kindFor(el,route){
    const a=el.closest('a[href]'),href=a?.getAttribute('href')||'';
    if(el.closest('[class*="comment-content"],[class*="comment-text"],[class*="reply-content"]'))return 'comment';
    if(el.closest('.intro,.intro-detail,.book-intro,[class*="description"],[class*="summary"]') || (route==='reader'&&el.closest('.content p')))return 'description';
    if(/\/author\//.test(href)||el.closest('a.author,.author-name,.author-tags h1'))return 'author';
    if(/\/chapter\//.test(href) && !fixed.has(el.textContent.trim()) || el.closest('.volume-name') || (route==='reader'&&el.closest('h1.title')))return 'chapter';
    if(/\/book\/\d+/.test(href) && !fixed.has(el.textContent.trim()) || el.closest('.book-info h1,.bread_crumbs_book_name'))return 'title';
    if(el.closest('.work-filter,.classify-list,.category,.tag,.tags'))return 'category';
    return 'ui';
  }
  function createTranslator(document,send,onStatus=()=>{}){
    const view=document.defaultView,records=new Map();let generation=0,url=document.location.href,enabled=true,stopped=false,timer=null,timerDue=0,inflight=0,userRoot=null;
    function visible(el){const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.top<view.innerHeight&&r.right>0&&r.left<view.innerWidth;}
    function priority(r){return (userRoot?.contains(r.node.parentElement)?0:visible(r.node.parentElement)?10:20)+kindOrder[r.kind];}
    function schedule(delay=80){
      if(stopped)return;
      const due=Date.now()+delay;
      if(timer&&timerDue<=due)return;
      view.clearTimeout(timer);timerDue=due;
      timer=view.setTimeout(()=>{timer=null;timerDue=0;scan();},delay);
    }
    function restore(){for(const r of records.values())if(r.node.isConnected&&r.node.data===r.output)r.node.data=r.raw;}
    function apply(r,text){if(!enabled||!r.node.isConnected||r.node.data!==r.raw||r.generation!==generation)return;r.output=r.raw.replace(r.source,()=>text);r.node.data=r.output;}
    function report(){const remaining=[...records.values()].filter(r=>r.node.isConnected&&r.generation===generation&&!r.output);onStatus({pending:remaining.length,active:inflight,failed:remaining.filter(r=>r.failed).length});}
    function dispatch(r,p){
      r.pending=true;r.priority=p;inflight++;const token=generation;
      Promise.resolve().then(()=>send(r.source,r.kind,p)).then(result=>{
        if(stopped||token!==generation)return;
        if(result?.ok&&result.provider==='hachimi40'&&result.source===r.source&&typeof result.text==='string'&&result.text.trim()&&!/<0x[0-9a-f]{2}>|\ufffd/i.test(result.text)){r.failed=false;apply(r,result.text);}
        else {r.failed=true;r.retryAt=Date.now()+30000;}
      }).catch(()=>{r.failed=true;r.retryAt=Date.now()+30000;}).finally(()=>{r.pending=false;inflight--;if(!stopped){report();schedule(150);}});
    }
    function scan(){
      if(stopped||!enabled)return;
      if(url!==document.location.href){restore();url=document.location.href;generation++;userRoot=null;records.clear();}
      for(const [node] of records)if(!node.isConnected)records.delete(node);
      const route=sites.route(url);if(!route){report();return;}
      const walker=document.createTreeWalker(document.body,4);let node;
      while((node=walker.nextNode())){
        const el=node.parentElement,raw=node.data,source=raw.trim().replace(/^[\ue000-\uf8ff\s]+|[\ue000-\uf8ff\s]+$/gu,'');
        if(!el||el.closest(blocked)||!/[\u3400-\u9fff]/u.test(source))continue;
        let r=records.get(node);if(r&&(node.data===r.output||node.data===r.raw))continue;
        if(source.length>12000)continue;
        let kind=kindFor(el,route);
        if(source.length>240&&!['description','comment'].includes(kind))kind='description';
        // Do not translate chapter lists linked from catalog cards before opening a book.
        if(kind==='chapter'&&!['book','reader'].includes(route))continue;
        r={node,raw,source,kind,generation,output:null,pending:false,failed:false};records.set(node,r);
        const label=fixed.get(source);if(label)apply(r,label);
      }
      const waiting=[...records.values()].filter(r=>r.node.isConnected&&r.generation===generation&&!r.output&&r.node.data===r.raw).sort((a,b)=>priority(a)-priority(b));
      for(const r of waiting){
        const p=priority(r);
        if(r.pending){if(p<r.priority){r.priority=p;void Promise.resolve(send(r.source,r.kind,p)).catch(()=>{});}continue;}
        if(r.retryAt>Date.now())continue;
        if(inflight>=24 && p>=10 || inflight>=32)break;
        dispatch(r,p);
      }
      report();
      if(waiting.some(r=>r.retryAt>Date.now()))schedule(30000);
    }
    function user(event){const el=event.target?.closest?.('a,button,[role="button"],.book-mid-info,.book-info,.intro-detail,[role="dialog"]');if(!el||el.closest('#stvai-qidian-ui'))return;userRoot=el.closest('.book-mid-info,.book-info,[role="dialog"]')||el;for(const r of records.values())if(userRoot.contains(r.node.parentElement))r.retryAt=0;schedule(0);}
    const observer=new view.MutationObserver(()=>schedule());observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    const onScroll=()=>schedule(),onRoute=()=>schedule(0);
    document.addEventListener('pointerdown',user,true);document.addEventListener('focusin',user,true);
    view.addEventListener('scroll',onScroll,{passive:true,capture:true});view.addEventListener('resize',onScroll);view.addEventListener('popstate',onRoute);view.addEventListener('hashchange',onRoute);
    return {scan,setEnabled(value){if(enabled===value)return;enabled=value;generation++;if(!enabled)restore();records.clear();if(enabled)scan();else onStatus({disabled:true});},retry(){for(const r of records.values()){r.retryAt=0;r.failed=false;}scan();},destroy(){stopped=true;generation++;restore();observer.disconnect();view.clearTimeout(timer);document.removeEventListener('pointerdown',user,true);document.removeEventListener('focusin',user,true);view.removeEventListener('scroll',onScroll,true);view.removeEventListener('resize',onScroll);view.removeEventListener('popstate',onRoute);view.removeEventListener('hashchange',onRoute);},records};
  }
  async function start(document,runtime){
    if(!sites.allowed(document.location.href)||document.getElementById('stvai-qidian-ui'))return null;
    let preference;
    try{const result=await runtime.sendMessage({type:'STVAI_QIDIAN_UI_GET'});if(!result?.ok)throw new Error('settings');preference=prefs.normalize(result);}catch(_){return null;}
    const host=document.createElement('div');host.id='stvai-qidian-ui';host.style.cssText='position:relative;z-index:2147483200';
    const shadow=host.attachShadow({mode:'open'}),css=document.createElement('link');css.rel='stylesheet';css.href=runtime.getURL('src/content/stv.css');
    const style=document.createElement('style');style.textContent=':host{all:initial}.stvai-toolbar{left:12px;top:50%;max-width:calc(100vw / var(--stvai-ui-scale,1) - 24px);max-height:calc(100dvh / var(--stvai-ui-scale,1) - 24px)}.qidian-controls{display:grid;gap:10px}.qidian-controls p{font-size:12px;margin:0;color:var(--stvai-text-muted)}.qidian-controls select{padding:8px;background:var(--stvai-surface);color:var(--stvai-text);border:1px solid var(--stvai-border);border-radius:8px}';
    let drag;
    const save=async patch=>{const result=await runtime.sendMessage({type:'STVAI_QIDIAN_UI_SET',...patch});if(!result?.ok)toolbar.status.textContent='Chưa lưu được cài đặt Qidian.';};
    const toolbar=ui.createToolbar(document,{}, {initialCollapsed:preference.collapsed,onLayoutChange(anchor,icon){drag?.anchorTo(anchor,icon);},onCollapsedChange(collapsed){preference.collapsed=collapsed;void save({collapsed});}});
    toolbar.root.dataset.site='qidian';toolbar.root.setAttribute('aria-label','Phwgna Stv · Qidian');toolbar.root.style.setProperty('--stvai-ui-scale',String(preference.uiScale));
    toolbar.root.querySelector('.stvai-actions').remove();for(const node of [toolbar.names,toolbar.clearCache,toolbar.cacheConfirmation,toolbar.progress,toolbar.recoveryStatus,toolbar.miniProgress,toolbar.miniCompleteRing,toolbar.miniTomoe])node.remove();
    const controls=document.createElement('div');controls.className='qidian-controls';const label=document.createElement('p');label.textContent='Qidian · Hachimi 40';
    const toggle=document.createElement('button'),retry=document.createElement('button'),scale=document.createElement('select');toggle.className='stvai-button stvai-button--primary';retry.className='stvai-button stvai-button--quiet';retry.textContent='Thử lại phần chưa dịch';
    for(const value of prefs.scales){const option=document.createElement('option');option.value=String(value);option.textContent=`${value*100}%`;scale.append(option);}scale.value=String(preference.uiScale);scale.setAttribute('aria-label','Kích thước menu');
    controls.append(label,toggle,retry,scale);toolbar.root.querySelector('.stvai-menu-body').prepend(controls);shadow.append(css,style,toolbar.root);document.body.append(host);
    const layout=document.createElement('style');layout.dataset.stvaiQidian='layout';layout.textContent=`
      body,.nav-wrap,.main-nav-wrap,.read-content{font-family:"Segoe UI",Arial,"Microsoft YaHei",sans-serif!important}
      body,.nav-wrap{font-weight:500}
      .nav-wrap a,.main-nav-wrap a,.intro-detail p{font-weight:500!important}
      .main-nav-wrap li{width:auto!important;min-width:0}.main-nav-wrap .nav-list{display:flex;flex-wrap:wrap}.main-nav-wrap .nav-list a{padding-left:12px!important;padding-right:12px!important}
      .nav-left .cate-normal,.nav-left .cate-base{width:auto!important;flex:none}
      .nav-left .cate-normal li,.nav-left .cate-base li{width:auto!important;min-width:0;padding-left:8px!important;padding-right:8px!important}
      .nav-left .cate-normal-item{width:auto!important;white-space:nowrap}
      .work-filter li,.work-filter a,.rank-nav-list a{height:auto!important;white-space:normal!important;overflow-wrap:anywhere}
      .book-mid-info,.book-info,.book-info-detail,.rank-list .name-box{min-width:0}
      .book-mid-info h2,.book-info h1{height:auto!important;white-space:normal!important;overflow-wrap:anywhere;line-height:1.45!important}
      .book-mid-info .intro{height:auto!important;max-height:6em;overflow:hidden;line-height:1.5!important}
      .book-mid-info .author{height:auto!important;white-space:normal!important;overflow-wrap:anywhere}
      .book-info .tag{display:flex;flex-wrap:wrap;gap:6px;height:auto!important}.book-info .tag span,.book-info .tag a{margin:0!important;max-width:100%;white-space:normal;overflow-wrap:anywhere}
      .book-author,.book-information-normal,.book-info,.book-info-top{height:auto!important}
      .book-info .all-btn,.book-info .normal-btn{height:auto!important;display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .book-info .normal-btn{width:auto!important;max-width:100%}
      .book-info .blue-btn-detail{width:auto!important;min-width:88px;padding-left:10px!important;padding-right:10px!important;white-space:nowrap}
      .book-info .red-btn{width:auto!important;max-width:100%;padding-left:12px!important;padding-right:12px!important;white-space:normal;line-height:1.35}
      .ticket-text{height:auto!important;white-space:nowrap}
      .volume-name{height:auto!important;white-space:normal!important;line-height:1.5!important}
      .rank-list .name-box a{max-width:100%;overflow:hidden;text-overflow:ellipsis}
    `;
    const translator=createTranslator(document,(source,kind,priority)=>runtime.sendMessage({type:'STVAI_QIDIAN_TEXT_TRANSLATE',source,kind,priority}),state=>{toolbar.status.textContent=state.disabled?'Đang xem tiếng Trung gốc':state.pending?`Hachimi 40 · còn ${state.pending} mục · đang xử lý ${state.active}${state.failed?' · có mục chưa dịch được':''}`:'Đã dịch nội dung đã tải';});
    function applyPreference(next){const old=preference;preference=prefs.normalize(next);toggle.textContent=preference.language==='vi'?'Tiếng Việt · 中文':'中文 · Tiếng Việt';layout.disabled=preference.language!=='vi';toolbar.root.style.setProperty('--stvai-ui-scale',String(preference.uiScale));scale.value=String(preference.uiScale);if(old.uiScale!==preference.uiScale)drag?.setUiScale(preference.uiScale);if(JSON.stringify(old.position)!==JSON.stringify(preference.position))drag?.setPosition(preference.position);if(toolbar.root.dataset.collapsed!==String(preference.collapsed))toolbar.menuToggle.click();translator.setEnabled(preference.language==='vi');}
    document.head.append(layout);drag=panels.attachDraggable(toolbar.root,toolbar.dragHandles,{storage:{},margin:0,initialPosition:preference.position,getScale:()=>preference.uiScale,isAnimating:()=>toolbar.root.dataset.stvaiToolbarAnimating==='true',onInteraction:()=>toolbar.finishAnimation(),interactiveHandles:[toolbar.miniToggle],onPositionChange(position){preference.position=position;void save({position});}});
    const refresh=()=>drag.refresh();css.addEventListener('load',refresh);
    toggle.addEventListener('click',()=>{const language=preference.language==='vi'?'zh':'vi';applyPreference({...preference,language});void save({language});});retry.addEventListener('click',()=>translator.retry());scale.addEventListener('change',()=>{applyPreference({...preference,uiScale:Number(scale.value)});void save({uiScale:preference.uiScale});});toolbar.settings.addEventListener('click',()=>{void runtime.sendMessage({type:'STVAI_OPEN_OPTIONS',site:'qidian'});});
    const listener=message=>{if(message?.type==='STVAI_QIDIAN_UI_CHANGED')applyPreference(message.preferences);};runtime.onMessage?.addListener(listener);
    const previewApi=globalThis.STVAIFanqieBookPreview || (typeof require==='function'?require('./fanqie-book-preview.js'):null);
    const loaderApi=globalThis.STVAIQidianBookPreview || (typeof require==='function'?require('./qidian-book-preview.js'):null);
    const preview=previewApi.install(document,{
      cardSelector:'.book-mid-info,.book-info,.rank-list li,.book-list li',titleSelector:'h1,h2,h3,.name,a[href*="/book/"]',siteLabel:'Qidian',bookHref:id=>`https://www.qidian.com/book/${id}/`,resolveBook:loaderApi.createLoader(document),
      translate:async(source,kind)=>{
        if(preference.language==='zh'||!/[\u3400-\u9fff]/u.test(source))return {text:source};
        if(fixed.has(source))return {text:fixed.get(source)};
        const response=await runtime.sendMessage({type:'STVAI_QIDIAN_TEXT_TRANSLATE',source,kind,priority:kindOrder[kind]??3});
        return response?.ok&&response.source===source&&response.provider==='hachimi40'?{text:response.text}:{reason:response?.reason||'response_mismatch'};
      }
    });
    applyPreference(preference);translator.scan();
    return {translator,destroy(){preview.destroy();translator.destroy();runtime.onMessage?.removeListener(listener);css.removeEventListener('load',refresh);drag.destroy();toolbar.finishAnimation();host.remove();layout.remove();}};
  }
  return {allowed:sites.allowed,createTranslator,start,kindFor,fixed};
});

(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.STVAIQidianBookPreview=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function createLoader(document) {
    return async card => {
      const link=card.matches('a[href]')?card:card.querySelector('a[href*="/book/"]');
      let url;try{url=new URL(link?.getAttribute('href'),document.location.href);}catch(_){return null;}
      if(!['www.qidian.com','qidian.com'].includes(url.hostname)||url.protocol!=='https:'||!/^\/book\/\d+\/$/.test(url.pathname))return null;
      const text=selector=>card.querySelector(selector)?.textContent?.trim()||'';
      const title=text('h1,h2,h3,.name,a[href*="/book/"]')||link.textContent?.trim();
      if(!title)return null;
      const author=text('.author-name,a[href*="/author/"],.author');
      const intro=text('.intro-detail,.book-intro,.intro,[class*="description"],[class*="summary"]');
      const tags=[...card.querySelectorAll('.tag a,.tag span,.category a')].map(el=>el.textContent.trim()).filter(Boolean).slice(0,20);
      const image=card.querySelector('img');let cover='';
      try{const source=image?.getAttribute('data-src')||image?.getAttribute('src');const parsed=new URL(source,document.location.href);if(parsed.protocol==='https:')cover=parsed.href;}catch(_){}
      return {id:url.pathname.split('/')[2],title,author,intro,tags,cover};
    };
  }
  return {createLoader};
});

(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.STVAIQidianSites=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const hosts = ['www.qidian.com','qidian.com','my.qidian.com'];
  function allowed(url) {
    try { const u=new URL(url); return u.protocol==='https:' && hosts.includes(u.hostname)
      && (u.hostname==='my.qidian.com' ? /^\/author\/(?:light\/)?\d+\/?$/.test(u.pathname)
        : !/^\/(?:account|login|pay|charge|ajax|api)(?:\/|$)/.test(u.pathname)); } catch (_) { return false; }
  }
  function route(url) {
    if(!allowed(url)) return null;
    const u=new URL(url), p=u.pathname;
    if(u.hostname==='my.qidian.com')return 'author';
    if(/^\/chapter\//.test(p))return 'reader';
    if(/^\/book\//.test(p))return 'book';
    if(/^\/rank\//.test(p))return 'rank';
    if(/^\/finish\//.test(p))return 'finish';
    if(/^\/free\//.test(p))return 'free';
    if(/^\/soushu\//.test(p))return 'search';
    return p==='/'?'home':'catalog';
  }
  return {allowed,route,storageKey:'stvai-qidian-ui-v1'};
});

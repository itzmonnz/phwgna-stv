(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIFanqiePublicBooks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function sanitize(record) {
    const id = String(record?.bookId || record?.book_id || '');
    const title = record?.bookName || record?.book_name;
    if (!/^\d{10,25}$/.test(id) || typeof title !== 'string' || !title.trim() || title.length > 240) return null;
    let tags=[];try {tags=JSON.parse(record.categoryV2 || '[]').map(tag=>tag.Name).filter(name=>typeof name==='string' && name.length<=120);}catch(_){}
    if (!tags.length && typeof record.category==='string') tags=[record.category.slice(0,120)];
    const cover=record.thumbUri || record.thumb_url || '';
    return {id,title:title.trim(),author:String(record.author||'').slice(0,240),intro:String(record.abstract||'').slice(0,12000),tags:tags.slice(0,20),cover:typeof cover==='string' && /^https:\/\//.test(cover)?cover.slice(0,2000):''};
  }
  function createService({fetcher = globalThis.fetch}={}) {
    const cache=new Map();let config;
    async function read(path) {
      const url=new URL(path,'https://fanqienovel.com');
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
      try {
        const response=await fetcher(url.href,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal});
        if(!response.ok)return null;let text='';
        if(response.body?.getReader){const reader=response.body.getReader(),decoder=new TextDecoder();let size=0;
          try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();return null;}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
        }else{text=await response.text();if(text.length>2000000)return null;}
        return text;
      }catch(_){return null;}finally{clearTimeout(timer);}
    }
    function cached(key,work){if(cache.has(key))return cache.get(key);const task=Promise.resolve().then(work).catch(()=>null);cache.set(key,task);task.then(result=>{if(!result)cache.delete(key);});while(cache.size>128)cache.delete(cache.keys().next().value);return task;}
    async function request(bookId) {
      if (bookId!==undefined && !/^\d{10,25}$/.test(String(bookId))) return null;
      const key=bookId===undefined?'index':String(bookId);
      return cached(key,async()=>{
          const text=await read(bookId===undefined?'/api/author/misc/top_book_list/v1/?limit=200&offset=0':`/page/${bookId}`);if(!text)return null;
          if(bookId===undefined){const data=JSON.parse(text);return data.code===0?(data.book_list||[]).slice(0,200).map(sanitize).filter(Boolean):null;}
          const match=/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*\});/.exec(text);
          const result=match?sanitize(JSON.parse(match[1]).page):null;
          return result?.id===String(bookId)?result:null;
      });
    }
    async function rank({index,gender,mold}={}){
      if(!Number.isInteger(index)||index<0||index>39||![1,2].includes(gender)||![1,2].includes(mold))return null;
      if(!config)config=read('/api/config/list?config_key=serial_rank_category_list_common').then(text=>text?JSON.parse(text).data?.list:null).catch(()=>null);
      const list=await config;if(!Array.isArray(list)){config=null;return null;}
      const category=list.filter(item=>item.group?.includes(gender===1?'male':'female'))[index];
      if(!category||!/^\d{1,6}$/.test(String(category.id)))return null;
      return cached(`rank:${gender}:${mold}:${category.id}`,async()=>{const text=await read(`/api/rank/category/list?app_id=2503&rank_list_type=3&offset=0&limit=10&category_id=${category.id}&rank_version=&gender=${gender}&rankMold=${mold}`);if(!text)return null;const data=JSON.parse(text);return data.code===0?(data.data?.book_list||[]).slice(0,10).map(sanitize).filter(Boolean):null;});
    }
    return {request,rank};
  }
  return {createService,sanitize};
});

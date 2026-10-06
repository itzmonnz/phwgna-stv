(function attachTitles(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STVAIFanqieTitles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Genre vocabulary stays familiar; ordinary syntax uses Vietnamese meanings.
  const preferred = Object.fromEntries([
    ['我的', 'của ta'], ['我', 'ta'], ['你', 'ngươi'], ['他', 'hắn'], ['她', 'nàng'],
    ['我们', 'chúng ta'], ['他们', 'bọn họ'], ['你的', 'của ngươi'], ['她的', 'của nàng'],
    ['从今天开始', 'bắt đầu từ hôm nay'], ['开始', 'bắt đầu'], ['今天', 'hôm nay'],
    ['修仙', 'tu tiên'], ['修真', 'tu chân'], ['师兄', 'sư huynh'], ['师姐', 'sư tỷ'],
    ['师父', 'sư phụ'], ['师尊', 'sư tôn'], ['师妹', 'sư muội'], ['师弟', 'sư đệ'],
    ['系统', 'hệ thống'], ['开局', 'khởi đầu'], ['穿越', 'xuyên không'], ['重生', 'trọng sinh'],
    ['玄幻', 'huyền huyễn'], ['仙侠', 'tiên hiệp'], ['灵气', 'linh khí'], ['灵异', 'linh dị'],
    ['末世', 'tận thế'], ['无敌', 'vô địch'], ['无敌师父', 'sư phụ vô địch'],
    ['九个', 'chín'], ['有', 'có'], ['太', 'quá'], ['强', 'mạnh'], ['了', 'rồi'],
    ['的', 'của'], ['不', 'không'], ['不是', 'không phải'], ['竟然', 'vậy mà'],
    ['竟', 'vậy mà'], ['都', 'đều'], ['被', 'bị'], ['成为', 'trở thành'], ['只有', 'chỉ có'],
    ['一个', 'một'], ['这个', 'này'], ['什么', 'gì'], ['怎么', 'sao lại'],
    ['下山', 'xuống núi'], ['高手', 'cao thủ'], ['都市', 'đô thị'], ['天灾', 'thiên tai'],
    ['物资', 'vật tư'], ['求生', 'sinh tồn'], ['长生', 'trường sinh'], ['万界', 'vạn giới'],
    ['诸天', 'chư thiên'], ['混沌体', 'thể hỗn độn'], ['顿悟', 'đốn ngộ'],
    ['皇后', 'hoàng hậu'], ['谋反', 'mưu phản'], ['总裁', 'tổng tài'], ['赘婿', 'con rể ở rể'],
    ['战神', 'chiến thần'], ['男主', 'nam chính'], ['女主', 'nữ chính'], ['反派', 'phản diện'],
    ['打脸', 'vả mặt'], ['直播', 'livestream'], ['游戏', 'trò chơi'], ['小说', 'tiểu thuyết'],
    ['氪金', 'nạp tiền'], ['签到', 'điểm danh'], ['觉醒', 'thức tỉnh'], ['模拟器', 'máy mô phỏng']
  ]);
  function createEngine(rows = [], limit = 512, fontMaps = {}) {
    const words = new Map(rows);
    for (const [key, value] of Object.entries(preferred)) words.set(key, value);
    const cache = new Map();
    const han = /[\u3400-\u9fff]/;
    function segment(text) {
      const tokens = [];
      for (let i = 0; i < text.length;) {
        if (!han.test(text[i])) {
          let end = i + 1;
          while (end < text.length && !han.test(text[end])) end++;
          tokens.push(text.slice(i, end)); i = end; continue;
        }
        let found = false;
        for (let size = Math.min(12, text.length - i); size > 0; size--) {
          const key = text.slice(i, i + size), value = words.get(key);
          if (!value) continue;
          tokens.push(value); i += size; found = true; break;
        }
        if (!found) tokens.push(text[i++]);
      }
      return tokens.join(' ').replace(/\s+/g, ' ').replace(/\s*([，,：:！!？?。；;、…])\s*/g, '$1 ')
        .replace(/，/g, ',').replace(/：/g, ':').replace(/！/g, '!').replace(/？/g, '?').trim();
    }
    function convert(source, fontId) {
      if (typeof source !== 'string' || source.length > 240) return null;
      const font = fontMaps[fontId];
      if (font) source = Array.from(source, char => font[String(char.codePointAt(0))] || char).join('');
      // Never guess a private-use font code or translate half an unreadable title.
      if (/[\ue000-\uf8ff]/.test(source) || !han.test(source)) return null;
      const key = source.normalize('NFC').trim();
      if (cache.has(key)) {
        const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit;
      }
      let value;
      const fromToday = /^从今天开始(.+)$/.exec(key);
      const possessive = /^(我的|你的|他的|她的)(.+)$/.exec(key);
      if (fromToday) value = `bắt đầu ${segment(fromToday[1])} từ hôm nay`;
      else if (possessive) {
        // Move the possessor after the noun, before a predicate (太强了, ...).
        const noun = /^(.*?)(太|很|竟然|居然|是|不|有|会|能)(.+)$/.exec(possessive[2]);
        const owner = { 我的: 'của ta', 你的: 'của ngươi', 他的: 'của hắn', 她的: 'của nàng' }[possessive[1]];
        value = noun && noun[1] ? `${segment(noun[1])} ${owner} ${segment(noun[2] + noun[3])}`
          : `${segment(possessive[2])} ${owner}`;
      } else value = segment(key);
      value = value.charAt(0).toLocaleUpperCase('vi') + value.slice(1);
      const result = Object.freeze({ text: value, source: key, partial: han.test(value), version: 1 });
      cache.set(key, result);
      while (cache.size > limit) cache.delete(cache.keys().next().value);
      return result;
    }
    return Object.freeze({ convert, get cacheSize() { return cache.size; } });
  }
  async function loadEngine(runtime, fetcher) {
    const base = 'src/shared/fanqie-title-data/';
    const get = async path => {
      const url = new URL(runtime.getURL(base + path));
      if (url.protocol !== 'chrome-extension:' || url.pathname !== '/' + base + path)
        throw new Error('title_dictionary_nonlocal');
      const response = await fetcher(url.href, { credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('title_dictionary_unavailable');
      return response.json();
    };
    const index = await get('index.json');
    if (index.version !== 1 || !Number.isInteger(index.chunks) || index.chunks < 1 || index.chunks > 20)
      throw new Error('title_dictionary_invalid');
    const [chunks, libraryFont, searchFont] = await Promise.all([
      Promise.all(Array.from({ length: index.chunks }, (_, i) => get(`${i}.json`))),
      get('font-library.json'), get('font-search.json')
    ]);
    return createEngine(chunks.flat(), 512, { e26e946d8b2ccb7: libraryFont, c207f68a84deae3: searchFont });
  }
  return Object.freeze({ createEngine, loadEngine });
});

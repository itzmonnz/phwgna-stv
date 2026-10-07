(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STVAIHachimiText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const model = 'hachimi40';
  const kinds = Object.freeze(['title', 'introduction', 'author', 'chapter', 'description', 'comment']);
  function normalize(source, kind) {
    if (!kinds.includes(kind) || typeof source !== 'string' || source.length > (['introduction', 'description'].includes(kind) ? 12000 : kind === 'comment' ? 1200 : 240)) return null;
    const text = source.normalize('NFC').trim();
    return text && /[\u3400-\u9fff]/u.test(text) && !/[\ue000-\uf8ff]/u.test(text) ? text : null;
  }
  // Short segments stay safely below the model's context limit. Preserve separators.
  function segments(source, limit = 160) {
    const output = [];
    // Rare symbols such as ┃ and kaomoji are not reliable model vocabulary.
    // Preserve them verbatim and translate only the surrounding words.
    for (const paragraph of source.split(/(\n+|[^\x00-\x7f\u00a0-\u024f\u2000-\u206f\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+)/u)) {
      if (!paragraph) continue;
      if (/^\n+$/.test(paragraph) || /^[^\x00-\x7f\u00a0-\u024f\u2000-\u206f\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+$/u.test(paragraph)) { output.push({ separator: paragraph }); continue; }
      let remaining = paragraph;
      while (remaining.length > limit) {
        const head = remaining.slice(0, limit);
        const punctuation = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'), head.lastIndexOf('，'));
        const end = punctuation >= limit / 3 ? punctuation + 1 : limit;
        output.push({ source: remaining.slice(0, end) }); remaining = remaining.slice(end);
      }
      if (remaining) output.push({ source: remaining });
    }
    return output;
  }
  function prepare(source, kind) {
    let prefix = '';
    if (kind === 'chapter') {
      const latest = /^(?:最近更新：|Mới cập nhật:\s*)/.exec(source);
      if (latest) { prefix = 'Mới cập nhật: '; source = source.slice(latest[0].length); }
      const chapter = /^第\s*(\d+)\s*章\s*/.exec(source);
      if (chapter) { prefix += `Chương ${chapter[1]}: `; source = source.slice(chapter[0].length); }
    }
    const wrapped = kind === 'title';
    return { prefix, input: wrapped ? `《${source.replace(/^[《](.*)[》]$/s, '$1')}》` : source, wrapped };
  }
  function finish(text, prepared) {
    text = String(text || '').trim();
    if (prepared.wrapped) text = text.replace(/^[《“"「]([\s\S]*)[》”"」]$/, '$1').trim();
    return prepared.prefix + text;
  }
  function validOutput(value) {
    return typeof value === 'string' && Boolean(value.trim()) && !/<0x[0-9a-f]{2}>|<unk>|<pad>|<\/s>|\ufffd/i.test(value);
  }
  return Object.freeze({ model, kinds, normalize, segments, prepare, finish, validOutput });
});

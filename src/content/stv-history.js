(function (root, factory) {
  let retried = false;
  const loadNodeModule = typeof module === 'object' && module && typeof module.require === 'function'
    ? module.require.bind(module)
    : null;
  function attach() {
    if (root.STVAIHistoryContent) return root.STVAIHistoryContent;
    const codec = root.STVAINativeHistory
      || (loadNodeModule ? loadNodeModule('../shared/native-history.js') : null);
    const sites = root.STVAISites
      || (loadNodeModule ? loadNodeModule('../shared/stv-sites.js') : null);
    if (!codec || !sites) {
      if (!retried && typeof root.setTimeout === 'function') {
        retried = true;
        root.setTimeout(attach, 0);
      }
      return null;
    }
    const api = factory(codec, sites);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.STVAIHistoryContent = api;
    if (root.document && root.chrome?.runtime?.sendMessage && !root.STVAIHistoryObserver
      && root === root.top && sites.siteUrl(root.location.href)) {
      root.STVAIHistoryObserver = api.createObserver({ window: root });
      root.STVAIHistoryObserver.start();
    }
    return api;
  }
  attach();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (codec, sites) {
  'use strict';
  function bookRecord(document, raw) {
    const book = sites.parseChapter(document.URL, { chapterId: '_' });
    const parsed = codec.parse(raw);
    return book && parsed.ok ? parsed.records.find(r => String(r.host) === book.source && String(r.id) === book.bookId) : null;
  }
  function readProof(document, raw) {
    const chapter = currentChapter(document), record = bookRecord(document, raw);
    if (!chapter || !record || codec.current(record.current).chapterId !== chapter.chapterId) return false;
    const root = sites.chapterRoot(document, document.URL);
    // A native shelf confirmation plus loaded content, never a spinner or URL alone.
    return Boolean(root?.isConnected && !root.querySelector('.spinner-border,.loading,[aria-busy="true"]')
      && (root.querySelector('i[t]') || [...root.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 0)));
  }
  function currentChapter(document) {
    return sites.parseChapter(document.URL, { chapterId: sites.chapterRoot(document)?.getAttribute('cid') });
  }
  function paintToc(document, raw) {
    const book = sites.parseChapter(document.URL, { chapterId: '_' });
    if (!book || currentChapter(document)) return 'not_applicable';
    const container = document.querySelector('#chaptercontainerinner');
    if (!container) return 'history_toc_unrecognized';
    const record = bookRecord(document, raw);
    const current = record && codec.current(record.current).chapterId;
    if (current && !/^\d+$/.test(current)) return 'history_toc_unrecognized';
    let count = 0;
    for (const link of container.querySelectorAll('a.listchapitem[href]')) {
      const chapter = sites.parseChapter(link.href);
      if (!chapter || chapter.source !== book.source || chapter.bookId !== book.bookId || !/^\d+$/.test(chapter.chapterId)) continue;
      const value = BigInt(chapter.chapterId), last = current ? BigInt(current) : null;
      link.classList.toggle('chapreaded', last !== null && value < last);
      link.classList.toggle('chaplastreaded', last !== null && value === last);
      count++;
    }
    return count ? 'synced' : 'history_toc_unrecognized';
  }
  function displayText(value) {
    return String(value || '').replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  function paintRecent(document, raw) {
    const container = document.getElementById('tusach');
    if (!container) return 'not_applicable';
    const parsed = codec.parse(raw);
    if (!parsed.ok) return parsed.code;
    container.replaceChildren();
    if (!parsed.records.length) {
      container.textContent = 'Chưa đọc truyện nào, hãy bắt đầu đọc truyện để lưu';
    }
    for (const record of parsed.records.slice(0, 300)) {
      const position = codec.current(record.current);
      const row = document.createElement('div'); row.className = 'roundblock';
      const title = document.createElement('a'); title.className = 'title';
      title.href = `/truyen/${record.host}/1/${record.id}/`;
      title.append(displayText(record.name), document.createElement('br'), displayText(position.title).slice(0, 40));
      const buttons = document.createElement('div'); buttons.className = 'btngroup';
      const target = `/truyen/${record.host}/1/${record.id}/${position.chapterId}/`;
      const resume = document.createElement('button'); resume.className = 'btn'; resume.textContent = '…';
      resume.dataset.stvaiContinue = target;
      resume.addEventListener('click', () => document.defaultView.location.assign(target));
      const remove = document.createElement('button'); remove.className = 'btn'; remove.textContent = '✕';
      remove.addEventListener('click', () => {
        let live;
        try { live = codec.parse(document.defaultView.localStorage.getItem('tusach')); } catch (_) { return; }
        if (!live.ok) return;
        const next = live.records.filter(value => codec.key(value) !== codec.key(record)).map(JSON.stringify).join('~/~');
        try { document.defaultView.localStorage.setItem('tusach', next); } catch (_) { return; }
        paintRecent(document, next);
      });
      buttons.append(resume, remove); row.append(title, buttons); container.append(row);
    }
    container.style.visibility = 'visible';
    container.style.height = 'auto';
    return 'synced';
  }
  function createObserver({ window, send = message => window.chrome.runtime.sendMessage(message) }) {
    const document = window.document;
    const documentToken = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let ticket = '', url = '', route = '', navigation = 0, lastRaw, candidateRaw, revision = -1, readSent = false;
    let running = false, stopped = false, interval, observer;
    let status = 'idle', errorCode = 'none', count = 0, writes = 0, toc = 'not_applicable';
    let invalidRaw;
    const routeKey = () => `${window.location.href}|${currentChapter(document)?.chapterId || ''}`;
    const message = (action, fields = {}) => send({ type: 'STVAI_HISTORY_SYNC', action, ticket, documentToken,
      chapterId: currentChapter(document)?.chapterId || '', ...fields });
    function check(result) {
      if (!result?.ok) {
        // Error codes are fixed by our background; never retain returned text.
        const allowed = ['history_invalid_data', 'history_size_limit', 'history_stale_snapshot', 'history_write_busy', 'history_write_uncertain',
          'history_storage_unavailable', 'history_stale_document', 'history_read_mismatch', 'history_unauthorized'];
        allowed.push('history_insecure_origin');
        errorCode = allowed.includes(result?.code) ? result.code : 'history_unavailable';
        status = 'error';
        revision = -1;
        if (errorCode === 'history_stale_document') ticket = '';
        return false;
      }
      return true;
    }
    async function tick() {
      if (running || stopped || document.visibilityState === 'hidden') return;
      running = true;
      try {
        const nextRoute = routeKey();
        if (route !== nextRoute) {
          route = nextRoute;
          url = window.location.href; ticket = ''; lastRaw = undefined; candidateRaw = undefined; readSent = false; revision = -1;
          invalidRaw = undefined;
        }
        if (!sites.siteUrl(url)) return;
        if (!ticket) {
          const begun = await message('begin', { navigation: ++navigation, url });
          if (stopped || nextRoute !== routeKey()) return;
          if (!check(begun)) return;
          ticket = begun.ticket;
        }
        const capturedTicket = ticket;
        const stale = () => stopped || nextRoute !== routeKey() || capturedTicket !== ticket;
        const raw = window.localStorage.getItem('tusach');
        if (invalidRaw === raw) return;
        const parsed = codec.parse(raw);
        if (!parsed.ok) { invalidRaw = raw; check(parsed); return; }
        count = parsed.records.length;
        const read = !readSent && readProof(document, raw);
        if (raw !== lastRaw && lastRaw !== undefined && !read) {
          if (candidateRaw !== raw) {
            candidateRaw = raw;
            status = 'synced'; errorCode = 'none';
            toc = paintToc(document, raw);
            return;
          }
          candidateRaw = undefined;
        } else candidateRaw = undefined;
        const response = raw !== lastRaw || read
          ? await message('observe', { raw, read }) : await message('poll', { revision });
        if (stale() || !check(response)) return;
        lastRaw = raw;
        if (read) readSent = true;
        status = 'synced'; errorCode = 'none';
        toc = paintToc(document, raw);
        if (response.unchanged) return;
        revision = response.revision;
        // Never manufacture the evidence of a real reading event by first
        // copying the current book's position into a still-loading chapter.
        if (currentChapter(document) && !readSent) { revision = -1; return; }
        const merged = codec.mergeRaw(raw, response.records || []);
        if (merged === (raw || '') && response.needsCleanup !== true) return;
        // The revision is not reconciled until its native write succeeds.
        const targetRevision = revision;
        revision = -1;
        if (window.localStorage.getItem('tusach') !== raw) return;
        const prepared = await message('prepare', { raw, revision: targetRevision });
        if (!check(prepared) || prepared.unchanged) return;
        const settle = action => message(action, { ticket: capturedTicket, token: prepared.token, raw: prepared.raw });
        if (stale() || window.localStorage.getItem('tusach') !== raw) { await settle('aborted'); return; }
        // The two reads and synchronous set form a local compare-and-set;
        // background has already persisted the original backup and intent.
        if (!codec.parse(prepared.raw).ok) { check({ code: 'history_invalid_data' }); return; }
        try { window.localStorage.setItem('tusach', prepared.raw); }
        catch (error) { await settle('aborted'); throw error; }
        paintRecent(document, prepared.raw);
        lastRaw = prepared.raw; candidateRaw = undefined; writes++;
        const applied = await settle('applied');
        if (stale()) return;
        toc = paintToc(document, window.localStorage.getItem('tusach'));
        if (check(applied)) revision = prepared.revision;
      } catch (_) { status = 'error'; errorCode = 'history_storage_unavailable'; }
      finally { running = false; }
    }
    function onStorage(event) { if (event.key === 'tusach' || event.key === null) void tick(); }
    function onPageShow(event) {
      if (event.persisted) { ticket = ''; lastRaw = undefined; readSent = false; revision = -1; }
      void tick();
    }
    function repaint() {
      if (!stopped && document.visibilityState !== 'hidden') {
        try { toc = paintToc(document, window.localStorage.getItem('tusach')); } catch (_) { /* Next tick reports safely. */ }
      }
    }
    function onProbe(request, sender, reply) {
      if (request?.type !== 'STVAI_HISTORY_DOCUMENT_PROBE') return false;
      if (sender.id !== window.chrome?.runtime?.id || sender.tab) return false;
      try {
        const raw = window.localStorage.getItem('tusach');
        reply({ documentToken, url: window.location.href, raw, chapterId: currentChapter(document)?.chapterId || '',
          readChapterId: readProof(document, raw) ? currentChapter(document).chapterId : '' });
      }
      catch (_) { reply({ documentToken, url: window.location.href, unavailable: true }); }
      return false;
    }
    function start() {
      if (interval || stopped) return;
      window.addEventListener('storage', onStorage);
      window.addEventListener('pageshow', onPageShow);
      document.addEventListener('visibilitychange', tick);
      window.chrome?.runtime?.onMessage?.addListener(onProbe);
      // Only child-list changes: class updates do not trigger ourselves.
      observer = new window.MutationObserver(repaint);
      observer.observe(document, { childList: true, subtree: true });
      interval = window.setInterval(tick, 1000);
      void tick();
    }
    function stop() {
      stopped = true; window.clearInterval(interval); observer?.disconnect();
      window.removeEventListener('storage', onStorage); window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', tick);
      window.chrome?.runtime?.onMessage?.removeListener(onProbe);
    }
    function snapshot() { return { status, errorCode, recordCount: count, writeCount: writes, toc }; }
    return Object.freeze({ start, stop, tick, snapshot });
  }
  return Object.freeze({ createObserver, readProof, paintToc, paintRecent });
});

/* Replaces the original local Node.js /api proxy with Java + OkHttp. */
(() => {
  const pending = new Map();
  let seq = 0;
  window.__nativeHttpDone = (id, raw) => {
    const done = pending.get(String(id));
    if (!done) return;
    pending.delete(String(id));
    let result;
    try { result = JSON.parse(raw); } catch (e) { done.reject(e); return; }
    if (!result.ok) { done.reject(new Error(result.error || 'Lỗi gọi API')); return; }
    const status = Number(result.status || 0);
    const text = result.text == null ? '' : String(result.text);
    done.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: result.headers || {},
      text: async () => text,
      json: async () => JSON.parse(text)
    });
  };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
    let url;
    try { url = new URL(rawUrl, location.href); } catch (_) { return nativeFetch(input, init); }
    if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const id = String(++seq);
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    const headers = {};
    const sourceHeaders = init.headers || (input && input.headers);
    if (sourceHeaders && typeof sourceHeaders.forEach === 'function') sourceHeaders.forEach((v, k) => headers[k] = v);
    else if (sourceHeaders && typeof sourceHeaders === 'object') Object.assign(headers, sourceHeaders);
    const body = init.body == null ? '' : String(init.body);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        if (!window.AndroidBridge || !AndroidBridge.requestOneLink) throw new Error('Không tìm thấy Java Bridge');
        AndroidBridge.requestOneLink(id, method, url.pathname + url.search, JSON.stringify(headers), body);
      } catch (e) { pending.delete(id); reject(e); }
    });
  };
})();

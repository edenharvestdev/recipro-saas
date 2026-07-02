// ตัวเชื่อม REST API ของ Recipro (แทน supabase-js) — แนบ JWT + auto refresh เมื่อ 401
(function () {
  const cfg = window.RECIPRO_CONFIG || {};
  // "" = ต่อ API โดเมนเดียวกัน (cloud) · "MOCK"/placeholder/ไม่กำหนด = โหมดจำลอง
  const rawBase = cfg.API_BASE_URL;
  const isMockCfg = rawBase == null || /^(MOCK|YOUR-API)/i.test(String(rawBase));
  const BASE = isMockCfg ? '' : String(rawBase).replace(/\/$/, '');
  const K_ACCESS = 'recipro_access';
  const K_REFRESH = 'recipro_refresh';

  const getAccess = () => localStorage.getItem(K_ACCESS);
  const getRefresh = () => localStorage.getItem(K_REFRESH);
  function setTokens(a, r) {
    if (a) localStorage.setItem(K_ACCESS, a);
    if (r) localStorage.setItem(K_REFRESH, r);
  }
  function clearTokens() {
    localStorage.removeItem(K_ACCESS);
    localStorage.removeItem(K_REFRESH);
  }

  async function tryRefresh() {
    const rt = getRefresh();
    if (!rt) return false;
    try {
      const r = await fetch(BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!r.ok) return false;
      const d = await r.json();
      if (d.accessToken) { localStorage.setItem(K_ACCESS, d.accessToken); return true; }
      return false;
    } catch (_) { return false; }
  }

  async function raw(method, path, body, retried) {
    const headers = { 'Content-Type': 'application/json' };
    const t = getAccess();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (window.RECIPRO_SHOP_OVERRIDE) headers['X-Shop-Id'] = window.RECIPRO_SHOP_OVERRIDE;
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (netErr) {
      netErr.isNetworkError = true;
      throw netErr;
    }
    if (res.status === 401 && !retried && getRefresh()) {
      if (await tryRefresh()) return raw(method, path, body, true);
    }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  window.API = {
    base: BASE,
    isConfigured: !isMockCfg,
    get: (p) => raw('GET', p),
    post: (p, b) => raw('POST', p, b),
    patch: (p, b) => raw('PATCH', p, b),
    put: (p, b) => raw('PUT', p, b),
    del: (p) => raw('DELETE', p),
    setTokens, clearTokens, getAccess, getRefresh,
    async login(email, password) {
      const d = await raw('POST', '/auth/login', { email, password });
      setTokens(d.accessToken, d.refreshToken);
      return d;
    },
    me: () => raw('GET', '/auth/me'),
    logout: () => clearTokens(),
  };
})();

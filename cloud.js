/*
  TOYBOX — cloud.js
  Your account: signing in, and keeping your library and song files online
  (with Supabase), so they show up on any device you sign in on.

  Only your account can read your files: the database and storage rules
  (supabase-setup.sql) only let a signed-in person open their own folder.
*/

const Cloud = (() => {
  // Your Supabase project. The publishable key is meant to be public; the rules keep your songs private.
  const CONFIG = {
    url: 'https://nwrqnajygqalkvtqexbg.supabase.co',
    key: 'sb_publishable_K6f_cgZ6rPA43rCdi0-Kvg_MTVYAM6z', // the publishable key (safe to be public)
  };
  // (Tests can point ToyBox at a stand-in server by setting window.TOYBOX_CLOUD before this file loads.)
  if (window.TOYBOX_CLOUD) Object.assign(CONFIG, window.TOYBOX_CLOUD);
  const BUCKET = 'songs';
  const SESSION_KEY = 'toybox-session';

  let session = null; // { access_token, refresh_token, expires_at, user: { id, email } }

  const enabled = () => Boolean(CONFIG.url && CONFIG.key);
  const user = () => (session && session.user) || null;

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
  }
  function keepSession(next) {
    session = next;
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private browsing: signed in until closed */ }
  }

  // Turn Supabase's error replies into plain words.
  function friendly(status, body) {
    const text = String((body && (body.msg || body.error_description || body.message || body.error)) || '').toLowerCase();
    if (text.includes('invalid login') || text.includes('invalid_grant')) return 'That email and password don’t match.';
    if (text.includes('already registered') || text.includes('already exists')) return 'There’s already an account with that email. Sign in instead.';
    if (text.includes('signups not allowed') || text.includes('signup is disabled')) return 'New accounts are turned off for this ToyBox.';
    if (text.includes('password') && (text.includes('least') || text.includes('weak') || text.includes('short'))) return 'Use a password with at least 6 characters.';
    if (text.includes('email') && text.includes('invalid')) return 'That email address doesn’t look right.';
    if (text.includes('not confirmed')) return 'This account still needs its email confirmed.';
    if (status === 413 || text.includes('too large') || text.includes('exceeded the maximum')) return 'too-large';
    if (status === 401 || status === 403) return 'Your sign-in has expired. Sign in again.';
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : `Something went wrong (${status}).`;
  }

  async function request(path, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) {
    if (!enabled()) throw new Error('Accounts aren’t set up yet.');
    let response;
    try {
      const h = { apikey: CONFIG.key, ...headers };
      if (auth) h.Authorization = `Bearer ${await accessToken()}`;
      if (body !== undefined && !(body instanceof Blob)) h['Content-Type'] = 'application/json';
      response = await fetch(CONFIG.url.replace(/\/$/, '') + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : (body instanceof Blob ? body : JSON.stringify(body)),
      });
    } catch (e) {
      if (e && e.message && e.message.startsWith('Your sign-in')) throw e;
      throw new Error('No internet connection.');
    }
    if (!response.ok) {
      let data = null;
      try { data = await response.json(); } catch (e) { /* not JSON */ }
      const error = new Error(friendly(response.status, data));
      error.status = response.status;
      throw error;
    }
    if (raw) return response;
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // ---------- Signing in ----------
  function fromAuthReply(data) {
    if (!data || !data.access_token) return null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: { id: data.user.id, email: data.user.email },
    };
  }

  async function signUp(email, password) {
    const data = await request('/auth/v1/signup', { method: 'POST', auth: false, body: { email, password } });
    const next = fromAuthReply(data);
    if (!next) throw new Error('Your account needs its email confirmed. Turn off “Confirm email” in Supabase, then sign in.');
    keepSession(next);
    return user();
  }

  async function signIn(email, password) {
    const data = await request('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
    keepSession(fromAuthReply(data));
    return user();
  }

  async function accessToken() {
    if (!session) throw new Error('Your sign-in has expired. Sign in again.');
    const soon = Date.now() / 1000 + 60;
    if (session.expires_at > soon) return session.access_token;
    const data = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false, body: { refresh_token: session.refresh_token },
    }).catch((e) => {
      if (e.status === 400 || e.status === 401) keepSession(null);
      throw e.status ? new Error('Your sign-in has expired. Sign in again.') : e;
    });
    keepSession(fromAuthReply(data));
    return session.access_token;
  }

  async function signOut() {
    try { await request('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* signed out here either way */ }
    keepSession(null);
  }

  // ---------- Your library (projects, song names, order...) ----------
  async function getLibrary() {
    const rows = await request(`/rest/v1/libraries?select=data,updated_at&user_id=eq.${user().id}`);
    return rows && rows[0] ? rows[0].data : null;
  }

  async function putLibrary(data) {
    await request('/rest/v1/libraries', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: user().id, data, updated_at: new Date().toISOString() },
    });
  }

  // ---------- Your files (songs and cover photos) ----------
  const pathOf = (fileName) => `${user().id}/${encodeURIComponent(fileName)}`;

  async function listFiles() {
    const names = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await request(`/storage/v1/object/list/${BUCKET}`, {
        method: 'POST', body: { prefix: user().id, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } },
      });
      for (const item of page || []) if (item && item.name) names.push(item.name);
      if (!page || page.length < 1000) break;
    }
    return names;
  }

  async function upload(fileName, blob) {
    await request(`/storage/v1/object/${BUCKET}/${pathOf(fileName)}`, {
      method: 'POST',
      headers: { 'x-upsert': 'true', 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
  }

  async function download(fileName) {
    const response = await request(`/storage/v1/object/authenticated/${BUCKET}/${pathOf(fileName)}`, { raw: true });
    return response.blob();
  }

  async function removeFiles(fileNames) {
    if (!fileNames.length) return;
    await request(`/storage/v1/object/${BUCKET}`, {
      method: 'DELETE', body: { prefixes: fileNames.map((f) => `${user().id}/${f}`) },
    });
  }

  loadSession();
  return { enabled, user, signUp, signIn, signOut, getLibrary, putLibrary, listFiles, upload, download, removeFiles, CONFIG };
})();

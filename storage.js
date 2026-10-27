/*
  TOYBOX — storage.js
  Where ToyBox keeps your songs.

  • In the iPhone app: real files inside the app's own folder. iOS keeps them
    safe and includes them in your phone's backups.
  • In a web browser (for testing on a computer): the browser's IndexedDB box.

  The rest of the app doesn't care which one is used. It just calls Store.something().
*/

const Store = (() => {
  const cap = window.Capacitor;
  const isNative = Boolean(cap && cap.isNativePlatform && cap.isNativePlatform());
  const FS = isNative ? cap.Plugins.Filesystem : null;
  const Share = isNative ? cap.Plugins.Share : null;

  const DIR = 'DATA';                 // the app's private folder
  const LIBRARY = 'toybox/library.json';
  const urlCache = new Map();         // file name -> playable URL

  // ---------- Helpers ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function safeName(name) {
    return (name || 'song').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'song';
  }

  // ---------- Web version (IndexedDB) ----------
  let db = null;
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('toybox-app', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta');
        req.result.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function idb(storeName, mode, job) {
    return new Promise((resolve, reject) => {
      const req = job(db.transaction(storeName, mode).objectStore(storeName));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- The jobs the app can ask for ----------
  async function init() {
    if (isNative) {
      try { await FS.mkdir({ path: 'toybox/media', directory: DIR, recursive: true }); } catch (e) { /* already there */ }
    } else {
      db = await openDb();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    }
  }

  // Everything except the sound files: projects, song names, lengths, waveforms.
  async function loadLibrary() {
    let text = null;
    if (isNative) {
      try { text = (await FS.readFile({ path: LIBRARY, directory: DIR, encoding: 'utf8' })).data; } catch (e) { text = null; }
    } else {
      text = await idb('meta', 'readonly', (s) => s.get('library'));
    }
    if (!text) return { projects: [], tracks: [] };
    try {
      const data = JSON.parse(text);
      return { projects: data.projects || [], tracks: data.tracks || [] };
    } catch (e) {
      return { projects: [], tracks: [] };
    }
  }

  async function saveLibrary(projects, tracks) {
    const text = JSON.stringify({ version: 1, projects, tracks });
    if (isNative) {
      await FS.writeFile({ path: LIBRARY, directory: DIR, data: text, encoding: 'utf8', recursive: true });
    } else {
      await idb('meta', 'readwrite', (s) => s.put(text, 'library'));
    }
  }

  // Save a sound or picture file. Big files are written in pieces so the phone doesn't run out of memory.
  async function saveFile(fileName, blob) {
    if (isNative) {
      const path = 'toybox/media/' + fileName;
      const PIECE = 3 * 1024 * 1024; // 3 MB at a time
      if (blob.size === 0) {
        await FS.writeFile({ path, directory: DIR, data: '', recursive: true });
      }
      for (let start = 0; start < blob.size; start += PIECE) {
        const data = await blobToBase64(blob.slice(start, start + PIECE));
        if (start === 0) await FS.writeFile({ path, directory: DIR, data, recursive: true });
        else await FS.appendFile({ path, directory: DIR, data });
      }
    } else {
      await idb('files', 'readwrite', (s) => s.put(blob, fileName));
    }
    urlCache.delete(fileName);
  }

  // A web address the <audio> or <img> tag can load.
  async function fileUrl(fileName) {
    if (urlCache.has(fileName)) return urlCache.get(fileName);
    let url = null;
    if (isNative) {
      const { uri } = await FS.getUri({ path: 'toybox/media/' + fileName, directory: DIR });
      url = cap.convertFileSrc(uri);
    } else {
      const blob = await idb('files', 'readonly', (s) => s.get(fileName));
      if (blob) url = URL.createObjectURL(blob);
    }
    if (url) urlCache.set(fileName, url);
    return url;
  }

  async function deleteFile(fileName) {
    const cached = urlCache.get(fileName);
    if (cached && cached.startsWith('blob:')) URL.revokeObjectURL(cached);
    urlCache.delete(fileName);
    try {
      if (isNative) await FS.deleteFile({ path: 'toybox/media/' + fileName, directory: DIR });
      else await idb('files', 'readwrite', (s) => s.delete(fileName));
    } catch (e) { /* already gone */ }
  }

  // Send a song somewhere else: AirDrop, Messages, Files, another music app...
  async function shareFile(fileName, niceName) {
    const outName = safeName(niceName) + fileName.slice(fileName.lastIndexOf('.'));
    if (isNative) {
      const copy = await FS.copy({ from: 'toybox/media/' + fileName, directory: DIR, to: outName, toDirectory: 'CACHE' });
      const uri = copy && copy.uri ? copy.uri : (await FS.getUri({ path: outName, directory: 'CACHE' })).uri;
      await Share.share({ title: niceName, files: [uri] });
      return 'shared';
    }
    const blob = await idb('files', 'readonly', (s) => s.get(fileName));
    if (!blob) throw new Error('missing');
    const file = new File([blob], outName, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: niceName });
      return 'shared';
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = outName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    return 'downloaded';
  }

  return { isNative, init, loadLibrary, saveLibrary, saveFile, fileUrl, deleteFile, shareFile };
})();

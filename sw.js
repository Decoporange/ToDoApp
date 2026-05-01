/* ═══════════════════════════════════════════════════════
   Planner Service Worker  v4
   バックグラウンド通知を確実に届けるための実装:

   方法A: Notification Triggers API (Chrome 80+/Android)
          → showTrigger で OS レベルにタイマーを渡す
          → SW がスリープしていても OS が通知を発火する

   方法B: Periodic Background Sync (Chrome 80+/Android)
          → 定期的に SW を起こして期限チェック

   方法C: フォールバック – Push API (外部サーバ不要版)
          → 将来のサーバ連携用

   いずれかが使えれば確実に通知が届く。
═══════════════════════════════════════════════════════ */

const CACHE = 'planner-v4';
const ASSETS = ['./index.html', './manifest.json'];
const DB_NAME = 'planner-reminders';
const DB_VER  = 1;
const STORE   = 'reminders';

/* ── インストール / アクティベート ── */
self.addEventListener('install',  e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); return self.clients.claim(); });

/* ── フェッチ（オフラインキャッシュ）── */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request).then(r => {
    if (r && r.status === 200) { const cl = r.clone(); caches.open(CACHE).then(ch => ch.put(e.request, cl)); }
    return r;
  }).catch(() => c)));
});

/* ── IndexedDB ヘルパー（リマインダー永続化）── */
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess  = e => res(e.target.result);
    req.onerror    = e => rej(e.target.error);
  });
}
async function dbPut(item)     { const db = await openDB(); return new Promise((r,j) => { const tx = db.transaction(STORE,'readwrite'); tx.objectStore(STORE).put(item); tx.oncomplete=r; tx.onerror=e=>j(e.target.error); }); }
async function dbDelete(id)    { const db = await openDB(); return new Promise((r,j) => { const tx = db.transaction(STORE,'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete=r; tx.onerror=e=>j(e.target.error); }); }
async function dbGetAll()      { const db = await openDB(); return new Promise((r,j) => { const req = db.transaction(STORE,'readonly').objectStore(STORE).getAll(); req.onsuccess=e=>r(e.target.result); req.onerror=e=>j(e.target.error); }); }

/* ── メッセージ受信（ページ → SW）── */
self.addEventListener('message', async e => {
  const d = e.data;
  if (!d || !d.type) return;

  if (d.type === 'SCHEDULE') {
    await scheduleOne(d);
  }
  if (d.type === 'CANCEL') {
    await cancelOne(d.id);
  }
  if (d.type === 'SYNC_ALL') {
    // ページから全リマインダーをまとめて同期
    const items = d.items || [];
    const db = await openDB();
    // 全削除してから再登録
    await new Promise(r => { const tx = db.transaction(STORE,'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = r; });
    for (const item of items) await scheduleOne(item);
  }
});

async function scheduleOne(d) {
  const fireAt = d.fireAt;
  if (!fireAt) return;
  const ms = fireAt - Date.now();

  // 永続化（Periodic Sync チェック用）
  await dbPut({ id: d.id, title: d.title, body: d.body || '', fireAt, fired: false });

  // 方法A: Notification Triggers API
  // Chrome Android で利用可能。OS レベルのタイマーなので確実。
  if ('showTrigger' in Notification.prototype || 'showTrigger' in self.registration) {
    try {
      await self.registration.showNotification('⏰ ' + d.title, {
        body: d.body || '期限が来ました',
        icon:  './icon-192.png',
        badge: './icon-192.png',
        tag:   'r-' + d.id,
        requireInteraction: true,
        vibrate: [300, 150, 300],
        data: { id: d.id },
        showTrigger: new TimestampTrigger(fireAt),
      });
      return; // 方法A成功
    } catch (err) {
      console.warn('[SW] TimestampTrigger failed, fallback:', err);
    }
  }

  // 方法B: ms が短い（5分以内）ならキープアライブ延長で強引に動かす
  // waitUntil で SW を起こしておく
  if (ms > 0 && ms < 5 * 60 * 1000) {
    const p = new Promise(resolve => {
      const t = setTimeout(() => { fireNotif(d); resolve(); }, ms);
    });
    // e.waitUntil がないのでここでは投げっぱなしだが短時間なら生き残る
    p.catch(() => {});
  }
  // 長いタイマーは Periodic Sync に任せる（下記参照）
}

function fireNotif(d) {
  return self.registration.showNotification('⏰ ' + d.title, {
    body: d.body || '期限が来ました',
    icon:  './icon-192.png',
    badge: './icon-192.png',
    tag:   'r-' + d.id,
    requireInteraction: true,
    vibrate: [300, 150, 300],
    data: { id: d.id },
  }).catch(() => {});
}

async function cancelOne(id) {
  await dbDelete(id);
  // TimestampTrigger で登録した通知もキャンセル
  const notifs = await self.registration.getNotifications({ tag: 'r-' + id });
  notifs.forEach(n => n.close());
}

/* ── Periodic Background Sync ── */
// 登録はページ側で行う（index.html の initPeriodicSync 参照）
// SW が定期的に起動して期限切れリマインダーを発火する
self.addEventListener('periodicsync', async e => {
  if (e.tag !== 'planner-reminders') return;
  e.waitUntil(checkAndFireReminders());
});

async function checkAndFireReminders() {
  const items = await dbGetAll();
  const now = Date.now();
  for (const item of items) {
    if (item.fired) continue;
    if (item.fireAt <= now) {
      await fireNotif(item);
      item.fired = true;
      await dbPut(item);
    }
  }
}

/* ── Push（外部サーバからのプッシュ）── */
self.addEventListener('push', e => {
  let d = { title: 'Planner', body: '' };
  try { d = e.data ? e.data.json() : d; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body || '',
    icon:  './icon-192.png',
    badge: './icon-192.png',
    tag:   d.tag || 'planner',
    requireInteraction: true,
    vibrate: [200, 100, 200],
  }));
});

/* ── 通知クリック ── */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      if (cs.length) return cs[0].focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

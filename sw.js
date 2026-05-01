const CACHE='planner-v3';
const ASSETS=['./index.html','./manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));return self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(c=>{if(c)return c;return fetch(e.request).then(r=>{if(r&&r.status===200){const cl=r.clone();caches.open(CACHE).then(ch=>ch.put(e.request,cl))}return r}).catch(()=>c)}))});
self.addEventListener('push',e=>{let d={title:'Planner',body:''};try{d=e.data?e.data.json():d}catch(_){}e.waitUntil(self.registration.showNotification(d.title,{body:d.body||'',icon:'./icon-192.png',badge:'./icon-192.png',tag:d.tag||'planner',requireInteraction:true,vibrate:[200,100,200]}))});
const pending={};
self.addEventListener('message',e=>{
  const d=e.data;if(!d||!d.type)return;
  if(d.type==='SCHEDULE'){
    const ms=d.fireAt-Date.now();
    if(pending[d.id])clearTimeout(pending[d.id]);
    if(ms<=0){fire(d);return}
    pending[d.id]=setTimeout(()=>{fire(d);delete pending[d.id]},ms);
  }
  if(d.type==='CANCEL'){
    if(pending[d.id]){clearTimeout(pending[d.id]);delete pending[d.id]}
    self.registration.getNotifications({tag:'r-'+d.id}).then(ns=>ns.forEach(n=>n.close()));
  }
});
function fire(d){self.registration.showNotification('⏰ '+d.title,{body:d.body||'期限が来ました',icon:'./icon-192.png',badge:'./icon-192.png',tag:'r-'+d.id,requireInteraction:true,vibrate:[300,150,300],data:{id:d.id}}).catch(()=>{})}
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{if(cs.length)return cs[0].focus();return self.clients.openWindow('./index.html')}))});

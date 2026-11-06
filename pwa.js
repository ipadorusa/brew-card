// pwa.js: 서비스 워커 등록과 새 버전 안내. 브루 카드(card.js)와 원두 노트(library.js)가 같이 쓴다.
// 열어 둔 사이 새 서비스 워커가 자리를 잡으면 #upd 안내를 띄운다. 앱으로 돌아올 때마다 새 버전을 확인한다.

export function registerSW() {
  document.getElementById('bUpd').addEventListener('click', () => location.reload());
  if (!('serviceWorker' in navigator)) return;
  const had = !!navigator.serviceWorker.controller; // 처음 설치될 때는 안내하지 않는다
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) document.getElementById('upd').hidden = false; });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

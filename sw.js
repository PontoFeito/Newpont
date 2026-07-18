const CACHE_NAME = 'controle-ponto-v3';
const ASSETS = [
  './controle_de_ponto.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro: sempre tenta buscar a versão mais nova do servidor.
// Só usa a cópia salva no aparelho se não houver internet no momento.
//
// IMPORTANTE: só participamos de pedidos do NOSSO PRÓPRIO site (mesma
// origem). Pedidos para outros domínios (Firebase, Firestore, Google,
// etc.) passam direto sem serem interceptados — o Firestore usa um tipo
// de conexão que fica "aberta" esperando resposta, e se a gente tentar
// re-empacotar esse pedido aqui, ele trava sem nunca dar erro nem sucesso.
self.addEventListener('fetch', (event) => {
  if(!event.request.url.startsWith(self.location.origin)){
    return; // deixa o navegador cuidar normalmente, sem interceptar
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Service Worker for SMon PWA
const CACHE_NAME = 'smon-v1.0.0';
const OFFLINE_URL = '/offline.html';

// Assets to cache for offline use
const STATIC_CACHE_URLS = [
  '/',
  '/offline.html',
  '/manifest.json',
  '/css/app.css',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/date-fns@2.29.3/index.min.js'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Install event');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_CACHE_URLS);
      })
      .catch((error) => {
        console.error('[SW] Cache installation failed:', error);
      })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate event');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache when offline
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        return fetch(event.request)
          .then((response) => {
            // Don't cache API calls or non-successful responses
            if (event.request.url.includes('/api/') ||
                !response.ok ||
                response.type !== 'basic') {
              return response;
            }

            // Cache successful responses
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });

            return response;
          })
          .catch(() => {
            // Return offline page for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match(OFFLINE_URL);
            }
          });
      })
  );
});

// Push event - handle push notifications
self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event);

  let data = {};
  if (event.data) {
    data = event.data.json();
  }

  const options = {
    body: data.body || 'New notification from SMon',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      timestamp: Date.now()
    },
    requireInteraction: true,
    silent: false,
    tag: data.tag || 'smon-notification'
  };

  // Custom notification title based on type
  let title = 'SMon Alert';
  if (data.type) {
    switch (data.type) {
      case 'device_down':
        title = '🚨 Device Down Alert';
        break;
      case 'device_up':
        title = '✅ Device Up Alert';
        break;
      case 'high_cpu':
        title = '⚠️ High CPU Alert';
        break;
      case 'ping_down':
        title = '🔴 Ping Target Down';
        break;
      case 'ping_up':
        title = '🟢 Ping Target Up';
        break;
      case 'high_latency':
        title = '🐌 High Latency Alert';
        break;
      default:
        title = '📢 SMon Notification';
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification click:', event);

  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Check if there's already a window/tab open with the target URL
        for (let client of windowClients) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }

        // If not, open a new window/tab
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// Background sync for offline data
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'sync-offline-data') {
    event.waitUntil(syncOfflineData());
  }
});

// Function to sync offline data when back online
async function syncOfflineData() {
  try {
    // Get offline data from IndexedDB
    const offlineData = await getOfflineData();

    if (offlineData && offlineData.length > 0) {
      console.log('[SW] Syncing offline data:', offlineData.length, 'items');

      // Send offline data to server
      for (const data of offlineData) {
        try {
          await fetch('/api/sync-offline-data', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
          });
        } catch (error) {
          console.error('[SW] Failed to sync item:', error);
        }
      }

      // Clear synced data
      await clearOfflineData();
      console.log('[SW] Offline data synced successfully');
    }
  } catch (error) {
    console.error('[SW] Background sync failed:', error);
  }
}

// IndexedDB helpers for offline data storage
function getOfflineData() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('smon-offline-db', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['offline-data'], 'readonly');
      const store = transaction.objectStore('offline-data');
      const getAllRequest = store.getAll();

      getAllRequest.onsuccess = () => resolve(getAllRequest.result);
      getAllRequest.onerror = () => reject(getAllRequest.error);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('offline-data')) {
        db.createObjectStore('offline-data', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

function clearOfflineData() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('smon-offline-db', 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['offline-data'], 'readwrite');
      const store = transaction.objectStore('offline-data');
      const clearRequest = store.clear();

      clearRequest.onsuccess = () => resolve();
      clearRequest.onerror = () => reject(clearRequest.error);
    };
  });
}
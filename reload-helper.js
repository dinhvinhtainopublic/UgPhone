/**
 * reload-helper.js
 * File hỗ trợ quá trình reload iframe hoạt động ổn định 100%
 */

(function() {
  'use strict';

  // Namespace cho helper
  window.UgPhoneReloadHelper = {
    
    // Lưu trữ trạng thái
    state: {
      isReloading: false,
      reloadAttempts: 0,
      maxAttempts: 5,
      lastReloadTime: 0,
      loadTimeouts: []
    },

    // Khởi tạo
    init: function() {
      this.setupStorageListener();
      this.setupNetworkMonitor();
      this.setupPerformanceMonitor();
      this.cleanupOldData();
      this.preventMultipleReloads();
    },

    // Lắng nghe thay đổi storage
    setupStorageListener: function() {
      window.addEventListener('storage', (e) => {
        if (e.key === 'ugphone_reloaded' && e.newValue === 'true') {
          console.log('[UgPhone] Reload signal detected from another tab');
        }
      });
    },

    // Theo dõi trạng thái mạng
    setupNetworkMonitor: function() {
      if ('connection' in navigator) {
        navigator.connection.addEventListener('change', () => {
          const conn = navigator.connection;
          console.log(`[UgPhone] Network changed: ${conn.effectiveType}`);
          
          // Nếu mạng yếu, tăng timeout
          if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') {
            sessionStorage.setItem('ugphone_slow_network', 'true');
          } else {
            sessionStorage.removeItem('ugphone_slow_network');
          }
        });
      }

      // Theo dõi online/offline
      window.addEventListener('online', () => {
        console.log('[UgPhone] Network back online');
        sessionStorage.setItem('ugphone_network_status', 'online');
      });

      window.addEventListener('offline', () => {
        console.log('[UgPhone] Network offline');
        sessionStorage.setItem('ugphone_network_status', 'offline');
      });
    },

    // Theo dõi hiệu suất tải trang
    setupPerformanceMonitor: function() {
      if ('performance' in window) {
        window.addEventListener('load', () => {
          setTimeout(() => {
            const perfData = performance.getEntriesByType('navigation')[0];
            if (perfData) {
              const loadTime = perfData.loadEventEnd - perfData.fetchStart;
              console.log(`[UgPhone] Page load time: ${loadTime}ms`);
              sessionStorage.setItem('ugphone_last_load_time', loadTime.toString());
            }
          }, 0);
        });
      }
    },

    // Dọn dẹp dữ liệu cũ
    cleanupOldData: function() {
      const now = Date.now();
      const keys = Object.keys(sessionStorage);
      
      keys.forEach(key => {
        if (key.startsWith('ugphone_')) {
          const item = sessionStorage.getItem(key);
          
          // Xóa các timestamp cũ hơn 1 giờ
          if (key.includes('_time') && !isNaN(item)) {
            const timestamp = parseInt(item);
            if (now - timestamp > 3600000) { // 1 giờ
              sessionStorage.removeItem(key);
              console.log(`[UgPhone] Cleaned up old data: ${key}`);
            }
          }
        }
      });
    },

    // Ngăn chặn reload nhiều lần
    preventMultipleReloads: function() {
      const lastReload = sessionStorage.getItem('ugphone_reload_time');
      if (lastReload) {
        const timeSinceReload = Date.now() - parseInt(lastReload);
        
        // Nếu reload trong vòng 2 giây, có thể là lỗi
        if (timeSinceReload < 2000) {
          this.state.reloadAttempts++;
          sessionStorage.setItem('ugphone_reload_attempts', this.state.reloadAttempts.toString());
          
          // Nếu reload quá nhiều, dừng lại
          if (this.state.reloadAttempts >= this.state.maxAttempts) {
            console.error('[UgPhone] Too many reload attempts, stopping');
            sessionStorage.removeItem('ugphone_reloaded');
            return false;
          }
        } else {
          // Reset attempts nếu đã qua 2 giây
          this.state.reloadAttempts = 0;
          sessionStorage.setItem('ugphone_reload_attempts', '0');
        }
      }
      return true;
    },

    // Force reload iframe với fallback và 404 detection
    forceReloadIframe: function(iframe, url, retryCount = 0) {
      const maxRetries = 3;
      
      return new Promise((resolve, reject) => {
        const timeout = sessionStorage.getItem('ugphone_slow_network') === 'true' ? 60000 : 30000;
        let loaded = false;
        let checking404 = false;

        // Clear iframe trước khi load (nếu retry)
        if (retryCount > 0) {
          iframe.src = 'about:blank';
          setTimeout(() => {
            iframe.src = url;
          }, 300);
        } else {
          iframe.src = url;
        }

        // Check 404 error sau 3 giây
        const check404Timeout = setTimeout(() => {
          if (!loaded && !checking404) {
            checking404 = true;
            try {
              const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
              const bodyText = iframeDoc.body ? iframeDoc.body.innerText.toLowerCase() : '';
              
              if (bodyText.includes('404') || bodyText.includes('does not exist') || bodyText.includes('not found')) {
                console.warn(`[UgPhone] 404 Error detected (attempt ${retryCount + 1}/${maxRetries})`);
                
                if (retryCount < maxRetries) {
                  clearTimeout(timeoutId);
                  iframe.removeEventListener('load', onLoad);
                  iframe.removeEventListener('error', onError);
                  
                  // Retry sau 1 giây
                  setTimeout(() => {
                    this.forceReloadIframe(iframe, url, retryCount + 1)
                      .then(resolve)
                      .catch(reject);
                  }, 1000);
                } else {
                  reject(new Error('404 Error: Max retries reached'));
                }
              }
            } catch (e) {
              // Cross-origin - không thể kiểm tra, giả sử OK
              console.log('[UgPhone] Cross-origin iframe, assuming loaded');
              loaded = true;
              resolve();
            }
          }
        }, 3000);

        // Timeout handler
        const timeoutId = setTimeout(() => {
          if (!loaded) {
            console.warn('[UgPhone] Iframe load timeout, retrying...');
            
            if (retryCount < maxRetries) {
              clearTimeout(check404Timeout);
              iframe.removeEventListener('load', onLoad);
              iframe.removeEventListener('error', onError);
              
              this.forceReloadIframe(iframe, url, retryCount + 1)
                .then(resolve)
                .catch(reject);
            } else {
              reject(new Error('Timeout: Max retries reached'));
            }
          }
        }, timeout);

        this.state.loadTimeouts.push(timeoutId);
        this.state.loadTimeouts.push(check404Timeout);

        // Load handler
        const onLoad = () => {
          // Đợi thêm 2 giây để kiểm tra 404
          setTimeout(() => {
            if (!checking404) {
              loaded = true;
              clearTimeout(timeoutId);
              clearTimeout(check404Timeout);
              iframe.removeEventListener('load', onLoad);
              console.log('[UgPhone] Iframe loaded successfully');
              resolve();
            }
          }, 2000);
        };

        // Error handler
        const onError = () => {
          console.error(`[UgPhone] Load error (attempt ${retryCount + 1}/${maxRetries})`);
          clearTimeout(timeoutId);
          clearTimeout(check404Timeout);
          iframe.removeEventListener('error', onError);
          
          if (retryCount < maxRetries) {
            setTimeout(() => {
              this.forceReloadIframe(iframe, url, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, 1000);
          } else {
            reject(new Error('Load error: Max retries reached'));
          }
        };

        iframe.addEventListener('load', onLoad, { once: true });
        iframe.addEventListener('error', onError, { once: true });
      });
    },

    // Preload resources
    preloadResources: function() {
      // Preconnect to proxy domain
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = 'https://uproxy.online';
      document.head.appendChild(link);

      // DNS prefetch
      const dns = document.createElement('link');
      dns.rel = 'dns-prefetch';
      dns.href = 'https://uproxy.online';
      document.head.appendChild(dns);
    },

    // Lưu trạng thái session
    saveSessionState: function() {
      const state = {
        timestamp: Date.now(),
        scrollPosition: window.scrollY,
        reloadCount: this.state.reloadAttempts,
        networkStatus: sessionStorage.getItem('ugphone_network_status') || 'unknown'
      };
      
      sessionStorage.setItem('ugphone_session_state', JSON.stringify(state));
    },

    // Khôi phục trạng thái session
    restoreSessionState: function() {
      const stateStr = sessionStorage.getItem('ugphone_session_state');
      if (stateStr) {
        try {
          const state = JSON.parse(stateStr);
          console.log('[UgPhone] Session state restored:', state);
          return state;
        } catch (e) {
          console.error('[UgPhone] Failed to restore session state:', e);
        }
      }
      return null;
    },

    // Clear tất cả timeouts
    clearAllTimeouts: function() {
      this.state.loadTimeouts.forEach(id => clearTimeout(id));
      this.state.loadTimeouts = [];
    },

    // Reset helper
    reset: function() {
      this.clearAllTimeouts();
      this.state.reloadAttempts = 0;
      this.state.isReloading = false;
      sessionStorage.removeItem('ugphone_reloaded');
      sessionStorage.removeItem('ugphone_reload_time');
      sessionStorage.removeItem('ugphone_reload_attempts');
    },

    // Log debug info
    debug: function() {
      console.log('[UgPhone] Helper State:', {
        reloadAttempts: this.state.reloadAttempts,
        isReloading: this.state.isReloading,
        sessionStorage: {
          reloaded: sessionStorage.getItem('ugphone_reloaded'),
          reloadTime: sessionStorage.getItem('ugphone_reload_time'),
          loadStart: sessionStorage.getItem('ugphone_load_start'),
          loaded: sessionStorage.getItem('ugphone_loaded'),
          networkStatus: sessionStorage.getItem('ugphone_network_status')
        }
      });
    }
  };

  // Auto init khi DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.UgPhoneReloadHelper.init();
    });
  } else {
    window.UgPhoneReloadHelper.init();
  }

  // Preload resources
  window.UgPhoneReloadHelper.preloadResources();

  // Cleanup khi trang đóng
  window.addEventListener('beforeunload', () => {
    window.UgPhoneReloadHelper.saveSessionState();
    window.UgPhoneReloadHelper.clearAllTimeouts();
  });

  // Expose helper globally
  console.log('[UgPhone] Reload Helper initialized');
})();
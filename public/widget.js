/* UpsellBoost Storefront Widget v1.0 */
(function() {
  'use strict';

  // ── Config ──
  var API_BASE = 'https://upsellboost-production.up.railway.app';
  var SHOP = window.Shopify && window.Shopify.shop ? window.Shopify.shop : '';
  if (!SHOP) return; // Not on a Shopify storefront

  var WIDGET_ID = 'ub-widget';
  var SHOWN_KEY = 'ub_shown_' + new Date().toDateString();
  var offers = [];
  var settings = {};

  // ── Styles (scoped to avoid theme conflicts) ──
  function injectStyles() {
    if (document.getElementById('ub-styles')) return;
    var css = document.createElement('style');
    css.id = 'ub-styles';
    css.textContent = [
      '#ub-overlay { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:999998; opacity:0; transition:opacity 0.3s; }',
      '#ub-overlay.ub-show { opacity:1; }',
      '#ub-popup { position:fixed; bottom:0; left:50%; transform:translateX(-50%) translateY(100%); width:95%; max-width:460px; background:#fff; border-radius:16px 16px 0 0; box-shadow:0 -4px 30px rgba(0,0,0,0.15); z-index:999999; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; transition:transform 0.35s cubic-bezier(0.4,0,0.2,1); padding:0; overflow:hidden; }',
      '#ub-popup.ub-show { transform:translateX(-50%) translateY(0); }',
      '#ub-popup * { box-sizing:border-box; margin:0; padding:0; }',
      '.ub-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px 12px; border-bottom:1px solid #f0f0f0; }',
      '.ub-header h3 { font-size:16px; font-weight:700; color:#1a1a1a; }',
      '.ub-close { background:none; border:none; font-size:22px; color:#999; cursor:pointer; padding:4px 8px; line-height:1; }',
      '.ub-close:hover { color:#333; }',
      '.ub-carousel { display:flex; overflow-x:auto; scroll-snap-type:x mandatory; gap:12px; padding:16px 20px; scrollbar-width:none; -ms-overflow-style:none; }',
      '.ub-carousel::-webkit-scrollbar { display:none; }',
      '.ub-card { flex:0 0 85%; scroll-snap-align:start; background:#fafafa; border-radius:12px; border:1px solid #eee; padding:16px; display:flex; gap:14px; align-items:center; }',
      '.ub-card img { width:80px; height:80px; object-fit:cover; border-radius:10px; background:#eee; flex-shrink:0; }',
      '.ub-card-info { flex:1; min-width:0; }',
      '.ub-card-title { font-size:14px; font-weight:600; color:#1a1a1a; margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '.ub-card-price { font-size:13px; color:#666; margin-bottom:8px; }',
      '.ub-card-price .ub-original { text-decoration:line-through; color:#999; margin-right:6px; }',
      '.ub-card-price .ub-sale { color:#e53935; font-weight:700; }',
      '.ub-card-discount { display:inline-block; background:#fff3e0; color:#e65100; font-size:11px; font-weight:600; padding:2px 8px; border-radius:99px; margin-bottom:8px; }',
      '.ub-add-btn { display:block; width:100%; padding:10px 0; background:#1a1a1a; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; transition:background 0.2s; }',
      '.ub-add-btn:hover { background:#333; }',
      '.ub-add-btn.ub-adding { background:#666; pointer-events:none; }',
      '.ub-add-btn.ub-added { background:#2e7d32; }',
      '.ub-timer { text-align:center; padding:8px 20px 16px; font-size:12px; color:#e65100; font-weight:600; }',
      '.ub-dots { display:flex; justify-content:center; gap:6px; padding:0 0 12px; }',
      '.ub-dot { width:6px; height:6px; border-radius:50%; background:#ddd; transition:background 0.2s; }',
      '.ub-dot.ub-active { background:#1a1a1a; }',
      '.ub-footer { padding:8px 20px 16px; text-align:center; }',
      '.ub-skip { background:none; border:none; color:#999; font-size:12px; cursor:pointer; font-family:inherit; text-decoration:underline; }',
      '.ub-urgency { font-size:11px; color:#e53935; font-weight:600; margin-bottom:4px; }',
      /* Cart page inline widget */
      '#ub-cart-widget { margin:16px 0; padding:20px; background:#fafafa; border:1px solid #eee; border-radius:12px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }',
      '#ub-cart-widget h4 { font-size:15px; font-weight:700; margin-bottom:12px; color:#1a1a1a; }',
      '#ub-cart-widget .ub-carousel { padding:0; }',
      '@media(max-width:480px) { .ub-card { flex:0 0 92%; } .ub-card img { width:64px; height:64px; } }',
    ].join('\n');
    document.head.appendChild(css);
  }

  // ── API calls ──
  function fetchOffers(cartData, callback) {
    var lineItems = (cartData.items || []).map(function(item) {
      return { product_id: String(item.product_id), variant_id: String(item.variant_id), product_type: item.product_type || '', quantity: item.quantity };
    });
    var body = JSON.stringify({
      shop: SHOP,
      order_total: (cartData.total_price / 100).toFixed(2),
      is_cod: false,
      line_items: lineItems
    });
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + '/api/offer-multi', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4 && xhr.status === 200) {
        try { callback(JSON.parse(xhr.responseText)); } catch(e) { callback({ offers: [] }); }
      }
    };
    xhr.onerror = function() { callback({ offers: [] }); };
    xhr.send(body);
  }

  function fetchCart(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/cart.js', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4 && xhr.status === 200) {
        try { callback(JSON.parse(xhr.responseText)); } catch(e) { callback(null); }
      }
    };
    xhr.onerror = function() { callback(null); };
    xhr.send();
  }

  function addToCart(variantId, quantity, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/cart/add.js', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) callback(xhr.status === 200);
    };
    xhr.onerror = function() { callback(false); };
    xhr.send(JSON.stringify({ items: [{ id: parseInt(variantId), quantity: quantity || 1 }] }));
  }

  function trackEvent(eventData) {
    var body = JSON.stringify(Object.assign({ shop: SHOP, date: new Date().toISOString() }, eventData));
    var xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + '/api/events', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(body);
  }

  // ── Timer ──
  function startTimer(el, minutes) {
    var total = minutes * 60;
    function tick() {
      if (total <= 0) { el.textContent = 'Offer expired!'; return; }
      var m = Math.floor(total / 60);
      var s = total % 60;
      el.textContent = '⏰ Offer expires in ' + m + ':' + (s < 10 ? '0' : '') + s;
      total--;
      setTimeout(tick, 1000);
    }
    tick();
  }

  // ── Format price ──
  function formatMoney(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function calcDiscount(price, pct) {
    var p = parseFloat(price);
    return (p - (p * pct / 100)).toFixed(2);
  }

  // ── Render popup ──
  function showPopup(offerList) {
    if (!offerList || offerList.length === 0) return;
    if (sessionStorage.getItem(SHOWN_KEY)) return; // Don't show twice per session per day

    injectStyles();

    // Overlay
    var overlay = document.createElement('div');
    overlay.id = 'ub-overlay';
    document.body.appendChild(overlay);

    // Popup container
    var popup = document.createElement('div');
    popup.id = 'ub-popup';

    // Header
    var header = '<div class="ub-header">' +
      '<h3>🎁 ' + (offerList.length > 1 ? 'Recommended for you' : 'Complete your order') + '</h3>' +
      '<button class="ub-close" onclick="document.getElementById(\'ub-popup\').classList.remove(\'ub-show\');document.getElementById(\'ub-overlay\').classList.remove(\'ub-show\');setTimeout(function(){var p=document.getElementById(\'ub-popup\');var o=document.getElementById(\'ub-overlay\');if(p)p.remove();if(o)o.remove();},350);">&times;</button>' +
      '</div>';

    // Cards
    var cards = '<div class="ub-carousel" id="ub-carousel">';
    offerList.forEach(function(offer, i) {
      var origPrice = parseFloat(offer.original_price);
      var discPrice = calcDiscount(offer.original_price, offer.discount_pct);
      var imgSrc = offer.image_url || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect fill="%23eee" width="80" height="80"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%23999" font-size="12">No image</text></svg>';

      cards += '<div class="ub-card" data-index="' + i + '">';
      cards += '<img src="' + imgSrc + '" alt="' + (offer.product_name || 'Product') + '" loading="lazy">';
      cards += '<div class="ub-card-info">';
      if (offer.urgency_text) cards += '<div class="ub-urgency">' + offer.urgency_text + '</div>';
      cards += '<div class="ub-card-title">' + (offer.product_name || 'Special offer') + '</div>';
      if (offer.discount_pct > 0) {
        cards += '<span class="ub-card-discount">' + offer.discount_pct + '% OFF</span>';
        cards += '<div class="ub-card-price"><span class="ub-original">$' + origPrice.toFixed(2) + '</span><span class="ub-sale">$' + discPrice + '</span></div>';
      } else {
        cards += '<div class="ub-card-price">$' + origPrice.toFixed(2) + '</div>';
      }
      cards += '<button class="ub-add-btn" data-variant="' + (offer.variant_id || '') + '" data-product="' + offer.product_id + '" data-name="' + (offer.product_name || '') + '" data-price="' + discPrice + '" data-rule="' + (offer.trigger_rule || '') + '">Add to cart</button>';
      cards += '</div></div>';
    });
    cards += '</div>';

    // Dots (if multiple)
    var dots = '';
    if (offerList.length > 1) {
      dots = '<div class="ub-dots">';
      offerList.forEach(function(_, i) { dots += '<span class="ub-dot' + (i === 0 ? ' ub-active' : '') + '"></span>'; });
      dots += '</div>';
    }

    // Timer
    var timer = '<div class="ub-timer" id="ub-timer"></div>';

    // Footer
    var footer = '<div class="ub-footer"><button class="ub-skip" id="ub-skip">No thanks, continue shopping</button></div>';

    popup.innerHTML = header + cards + dots + timer + footer;
    document.body.appendChild(popup);

    // Animate in
    setTimeout(function() {
      overlay.classList.add('ub-show');
      popup.classList.add('ub-show');
    }, 50);

    // Start timer (default 10 min)
    var timerEl = document.getElementById('ub-timer');
    if (timerEl) startTimer(timerEl, 10);

    // Track impression
    trackEvent({ type: 'shown', products: offerList.map(function(o) { return o.product_name; }).join(', '), rule: offerList[0].trigger_rule || 'unknown' });
    sessionStorage.setItem(SHOWN_KEY, '1');

    // Carousel dot tracking
    var carousel = document.getElementById('ub-carousel');
    if (carousel && offerList.length > 1) {
      carousel.addEventListener('scroll', function() {
        var scrollLeft = carousel.scrollLeft;
        var cardWidth = carousel.firstElementChild ? carousel.firstElementChild.offsetWidth + 12 : 300;
        var activeIndex = Math.round(scrollLeft / cardWidth);
        var allDots = popup.querySelectorAll('.ub-dot');
        allDots.forEach(function(d, i) { d.classList.toggle('ub-active', i === activeIndex); });
      });
    }

    // Add to cart buttons
    popup.querySelectorAll('.ub-add-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var variantId = btn.getAttribute('data-variant');
        var productName = btn.getAttribute('data-name');
        var price = btn.getAttribute('data-price');
        var rule = btn.getAttribute('data-rule');
        if (!variantId) return;

        btn.textContent = 'Adding...';
        btn.classList.add('ub-adding');

        addToCart(variantId, 1, function(success) {
          if (success) {
            btn.textContent = '✓ Added!';
            btn.classList.remove('ub-adding');
            btn.classList.add('ub-added');
            trackEvent({ type: 'accepted', product: productName, variant_id: variantId, revenue: price, rule: rule });
            // Auto-close after 1.5s
            setTimeout(function() { closePopup(); }, 1500);
          } else {
            btn.textContent = 'Failed — try again';
            btn.classList.remove('ub-adding');
            setTimeout(function() { btn.textContent = 'Add to cart'; }, 2000);
          }
        });
      });
    });

    // Skip button
    var skipBtn = document.getElementById('ub-skip');
    if (skipBtn) {
      skipBtn.addEventListener('click', function() {
        trackEvent({ type: 'declined', products: offerList.map(function(o) { return o.product_name; }).join(', '), rule: offerList[0].trigger_rule || 'unknown' });
        closePopup();
      });
    }

    // Overlay close
    overlay.addEventListener('click', function() { closePopup(); });
  }

  function closePopup() {
    var popup = document.getElementById('ub-popup');
    var overlay = document.getElementById('ub-overlay');
    if (popup) popup.classList.remove('ub-show');
    if (overlay) overlay.classList.remove('ub-show');
    setTimeout(function() {
      if (popup) popup.remove();
      if (overlay) overlay.remove();
    }, 350);
  }

  // ── Cart page inline widget ──
  function showCartWidget(offerList) {
    if (!offerList || offerList.length === 0) return;
    injectStyles();

    var container = document.createElement('div');
    container.id = 'ub-cart-widget';

    var html = '<h4>🛒 You might also like</h4>';
    html += '<div class="ub-carousel">';
    offerList.forEach(function(offer) {
      var origPrice = parseFloat(offer.original_price);
      var discPrice = calcDiscount(offer.original_price, offer.discount_pct);
      var imgSrc = offer.image_url || '';

      html += '<div class="ub-card">';
      if (imgSrc) html += '<img src="' + imgSrc + '" alt="' + (offer.product_name || '') + '" loading="lazy">';
      html += '<div class="ub-card-info">';
      html += '<div class="ub-card-title">' + (offer.product_name || 'Product') + '</div>';
      if (offer.discount_pct > 0) {
        html += '<span class="ub-card-discount">' + offer.discount_pct + '% OFF</span>';
        html += '<div class="ub-card-price"><span class="ub-original">$' + origPrice.toFixed(2) + '</span><span class="ub-sale">$' + discPrice + '</span></div>';
      } else {
        html += '<div class="ub-card-price">$' + origPrice.toFixed(2) + '</div>';
      }
      html += '<button class="ub-add-btn" data-variant="' + (offer.variant_id || '') + '" data-name="' + (offer.product_name || '') + '" data-price="' + discPrice + '" data-rule="' + (offer.trigger_rule || '') + '">Add to cart</button>';
      html += '</div></div>';
    });
    html += '</div>';
    container.innerHTML = html;

    // Insert before checkout button on cart page
    var cartForm = document.querySelector('form[action="/cart"]') || document.querySelector('.cart') || document.querySelector('[data-cart]');
    if (cartForm) {
      cartForm.parentNode.insertBefore(container, cartForm.nextSibling);
    } else {
      // Fallback: insert before footer or at end of main
      var main = document.querySelector('main') || document.querySelector('.main-content') || document.body;
      main.appendChild(container);
    }

    // Add to cart buttons
    container.querySelectorAll('.ub-add-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var variantId = btn.getAttribute('data-variant');
        var productName = btn.getAttribute('data-name');
        var price = btn.getAttribute('data-price');
        var rule = btn.getAttribute('data-rule');
        if (!variantId) return;
        btn.textContent = 'Adding...';
        btn.classList.add('ub-adding');
        addToCart(variantId, 1, function(success) {
          if (success) {
            btn.textContent = '✓ Added!';
            btn.classList.remove('ub-adding');
            btn.classList.add('ub-added');
            trackEvent({ type: 'accepted', product: productName, variant_id: variantId, revenue: price, rule: rule, channel: 'cart_widget' });
            setTimeout(function() { location.reload(); }, 1200);
          } else {
            btn.textContent = 'Failed';
            btn.classList.remove('ub-adding');
            setTimeout(function() { btn.textContent = 'Add to cart'; }, 2000);
          }
        });
      });
    });

    trackEvent({ type: 'shown', channel: 'cart_widget', products: offerList.map(function(o) { return o.product_name; }).join(', ') });
  }

  // ── Intercept Add-to-Cart for popup ──
  function interceptAddToCart() {
    // Listen for Shopify's AJAX add-to-cart events
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function() {
        var url = arguments[0];
        if (typeof url === 'string' && url.includes('/cart/add')) {
          var result = origFetch.apply(this, arguments);
          result.then(function() {
            setTimeout(function() { triggerPopup(); }, 800);
          }).catch(function() {});
          return result;
        }
        return origFetch.apply(this, arguments);
      };
    }

    // Also intercept XHR-based add-to-cart
    var origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (method === 'POST' && url && url.includes('/cart/add')) {
        this.addEventListener('load', function() {
          setTimeout(function() { triggerPopup(); }, 800);
        });
      }
      return origXHROpen.apply(this, arguments);
    };

    // Also intercept form submissions to /cart/add
    document.addEventListener('submit', function(e) {
      var form = e.target;
      if (form && form.action && form.action.includes('/cart/add')) {
        // Let the form submit, then show popup on next page
        sessionStorage.setItem('ub_show_popup', '1');
      }
    });
  }

  function triggerPopup() {
    if (sessionStorage.getItem(SHOWN_KEY)) return;
    fetchCart(function(cart) {
      if (!cart || !cart.items || cart.items.length === 0) return;
      fetchOffers(cart, function(data) {
        if (data.offers && data.offers.length > 0) {
          showPopup(data.offers);
        }
      });
    });
  }

  // ── Main init ──
  function init() {
    var path = window.location.pathname;

    // Cart page — show inline widget
    if (path === '/cart' || path.startsWith('/cart')) {
      fetchCart(function(cart) {
        if (!cart || !cart.items || cart.items.length === 0) return;
        fetchOffers(cart, function(data) {
          if (data.offers && data.offers.length > 0) {
            showCartWidget(data.offers);
          }
        });
      });
    }

    // Check if we should show popup (from form-based add-to-cart redirect)
    if (sessionStorage.getItem('ub_show_popup')) {
      sessionStorage.removeItem('ub_show_popup');
      setTimeout(function() { triggerPopup(); }, 500);
    }

    // Intercept AJAX add-to-cart on all pages
    interceptAddToCart();
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

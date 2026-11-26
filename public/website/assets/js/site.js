/* Nexuzy PMS — homepage interactions */
(() => {
  'use strict';

  const screens = [
    { file: 'dashboard.png', title: 'Operations dashboard', category: 'operations', label: 'Dashboard', alt: 'Nexuzy PMS dashboard with occupancy, room rack, collections and arrivals.' },
    { file: 'front-desk.png', title: 'Front desk & in-house stays', category: 'front-desk', label: 'Front desk', alt: 'Front desk view with occupied stays, expected arrivals and check-in action.' },
    { file: 'reservation-app.png', title: 'Reservations workspace', category: 'front-desk', label: 'Reservations', alt: 'Reservations workspace for searching and managing hotel bookings.' },
    { file: 'reservation-booking.png', title: 'Create a reservation', category: 'front-desk', label: 'Booking form', alt: 'New reservation form with guest, stay dates, room and payment details.' },
    { file: 'rooms-and-rates.png', title: 'Rooms, types and rates', category: 'operations', label: 'Rooms & HK', alt: 'Manage room types and nightly room rates in Nexuzy PMS.' },
    { file: 'restaurant-menu.png', title: 'Menu management', category: 'restaurant', label: 'Restaurant', alt: 'Restaurant menu manager with dishes, prices, category and tax settings.' },
    { file: 'restaurant-tables.png', title: 'Table bookings & advances', category: 'restaurant', label: 'Table booking', alt: 'Advance table booking form with guest, time, table, guests and advance payment.' },
    { file: 'restaurant-order.png', title: 'Restaurant POS & KDS', category: 'restaurant', label: 'POS & KDS', alt: 'Restaurant POS order screen with menu, cart and kitchen display workflow.' },
    { file: 'advance-booking-bill.png', title: 'Advance booking receipt', category: 'restaurant', label: 'Advance receipt', alt: 'Printable advance table-booking receipt for a restaurant reservation.' },
    { file: 'billing-gst-folio.png', title: 'Guest folios & payments', category: 'billing', label: 'Billing', alt: 'Guest folio with itemised room and restaurant charges, payments and balance.' },
    { file: 'gst-invoice.png', title: 'India GST tax invoice', category: 'billing', label: 'GST invoice', alt: 'Printable India GST tax invoice with tax breakdown and hotel details.' },
    { file: 'expenses.png', title: 'Hotel expense ledger', category: 'operations', label: 'Expenses', alt: 'Hotel expense ledger for recording operating costs and payment methods.' },
    { file: 'profit-loss-audit.png', title: 'Profit, GST & audit trail', category: 'operations', label: 'Reports', alt: 'Profit and loss report with GST breakdown, department revenue and audit log.' },
    { file: 'settings.png', title: 'Settings, backups & integrations', category: 'operations', label: 'Settings', alt: 'Settings screen with portable backup, Google Drive, SMTP and system configuration.' },
    { file: 'setup-step-1.png', title: 'First-run setup: property', category: 'setup', label: 'Setup · 01', alt: 'First-run setup wizard for hotel name, address and property details.' },
    { file: 'setup-step-2.png', title: 'First-run setup: operations', category: 'setup', label: 'Setup · 02', alt: 'First-run setup wizard for banking, tax and master administrator credentials.' },
    { file: 'setup-complete.png', title: 'Property ready', category: 'setup', label: 'Complete', alt: 'Setup complete confirmation screen in Nexuzy PMS.' }
  ];

  const gallery = document.querySelector('[data-gallery]');
  const countNode = document.querySelector('[data-gallery-count]');
  const filters = [...document.querySelectorAll('[data-filter]')];
  const mobileToggle = document.querySelector('[data-mobile-toggle]');
  const mobileMenu = document.querySelector('[data-mobile-menu]');
  const header = document.querySelector('.site-header');
  let activeFilter = 'all';
  let lightboxItems = [];
  let lightboxIndex = 0;

  const lightbox = document.getElementById('lightbox');
  const lightboxImage = document.querySelector('[data-lightbox-image]');
  const lightboxTitle = document.querySelector('[data-lightbox-title]');
  const lightboxCounter = document.querySelector('[data-lightbox-counter]');
  const lightboxPrev = document.querySelector('[data-lightbox-prev]');
  const lightboxNext = document.querySelector('[data-lightbox-next]');
  let lastLightboxTrigger = null;

  function renderScreens() {
    if (!gallery) return;
    gallery.innerHTML = screens.map((screen, index) => `
      <article class="shot-card reveal" data-category="${screen.category}" data-title="${screen.title}">
        <button class="shot-button" type="button" data-shot-index="${index}" aria-label="Open ${screen.title} screenshot">
          <span class="shot-media">
            <img src="assets/screenshots/${screen.file}" alt="${screen.alt}" loading="lazy" decoding="async">
          </span>
        </button>
        <div class="shot-meta">
          <div class="shot-title">
            <strong>${screen.title}</strong>
            <span>${screen.label}</span>
          </div>
          <span class="shot-arrow" aria-hidden="true">
            <svg class="icon"><use href="#icon-arrow-up-right"></use></svg>
          </span>
        </div>
      </article>
    `).join('');
  }

  function updateGallery() {
    if (!gallery) return;
    const cards = [...gallery.querySelectorAll('.shot-card')];
    let visible = 0;
    cards.forEach((card) => {
      const match = activeFilter === 'all' || card.dataset.category === activeFilter;
      card.hidden = !match;
      if (match) visible += 1;
    });
    if (countNode) countNode.innerHTML = `<strong>${visible}</strong> of ${screens.length} screens`;
    filters.forEach((button) => {
      const isActive = button.dataset.filter === activeFilter;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
  }

  function setFilter(filter) {
    activeFilter = filter;
    updateGallery();
  }

  function renderLightbox() {
    if (!lightbox || !lightboxImage) return;
    const item = lightboxItems[lightboxIndex];
    if (!item) return;
    lightboxImage.src = item.src;
    lightboxImage.alt = item.alt || item.title;
    lightboxTitle.textContent = item.title;
    lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
    if (lightboxPrev) lightboxPrev.disabled = lightboxItems.length < 2;
    if (lightboxNext) lightboxNext.disabled = lightboxItems.length < 2;
  }

  function openLightbox(items, index, trigger) {
    if (!lightbox || !items.length) return;
    lightboxItems = items;
    lightboxIndex = index;
    lastLightboxTrigger = trigger || null;
    renderLightbox();
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
    lightbox.querySelector('[data-lightbox-close]')?.focus();
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    if (lastLightboxTrigger) lastLightboxTrigger.focus();
    lastLightboxTrigger = null;
  }

  function stepLightbox(direction) {
    if (lightboxItems.length < 2) return;
    lightboxIndex = (lightboxIndex + direction + lightboxItems.length) % lightboxItems.length;
    renderLightbox();
  }

  function openFromGallery(index, trigger) {
    const visibleButtons = [...gallery.querySelectorAll('.shot-button')]
      .filter((button) => !button.closest('.shot-card').hidden);
    const items = visibleButtons.map((button) => {
      const screen = screens[Number(button.dataset.shotIndex)];
      return {
        src: `assets/screenshots/${screen.file}`,
        title: screen.title,
        alt: screen.alt
      };
    });
    const visibleIndex = visibleButtons.indexOf(trigger);
    openLightbox(items, visibleIndex >= 0 ? visibleIndex : index, trigger);
  }

  function setupReveals() {
    const revealItems = [...document.querySelectorAll('.reveal')];
    if (!revealItems.length) return;
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealItems.forEach((item) => item.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
    revealItems.forEach((item) => observer.observe(item));
  }

  function setupMobileMenu() {
    if (!mobileToggle || !mobileMenu) return;
    const close = () => {
      mobileMenu.classList.remove('is-open');
      mobileToggle.setAttribute('aria-expanded', 'false');
    };
    mobileToggle.addEventListener('click', () => {
      const open = !mobileMenu.classList.contains('is-open');
      mobileMenu.classList.toggle('is-open', open);
      mobileToggle.setAttribute('aria-expanded', String(open));
    });
    mobileMenu.querySelectorAll('a').forEach((link) => link.addEventListener('click', close));
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1060) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
  }

  function setupHeader() {
    if (!header) return;
    const update = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  renderScreens();
  updateGallery();
  setupReveals();
  setupMobileMenu();
  setupHeader();

  filters.forEach((button) => {
    button.addEventListener('click', () => setFilter(button.dataset.filter));
  });

  gallery?.addEventListener('click', (event) => {
    const button = event.target.closest('.shot-button');
    if (!button) return;
    openFromGallery(Number(button.dataset.shotIndex), button);
  });

  lightbox?.addEventListener('click', (event) => {
    if (event.target.closest('[data-lightbox-close]') || event.target.closest('[data-lightbox-backdrop]')) {
      closeLightbox();
      return;
    }
    if (event.target.closest('[data-lightbox-prev]')) stepLightbox(-1);
    if (event.target.closest('[data-lightbox-next]')) stepLightbox(1);
  });

  document.addEventListener('keydown', (event) => {
    if (!lightbox?.classList.contains('is-open')) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') stepLightbox(-1);
    if (event.key === 'ArrowRight') stepLightbox(1);
  });

  document.querySelectorAll('[data-year]').forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
})();

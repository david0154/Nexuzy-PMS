/* Nexuzy PMS — illustrated field guide interactions */
(() => {
  'use strict';

  const body = document.body;
  const sidebar = document.querySelector('[data-docs-sidebar]');
  const overlay = document.querySelector('[data-docs-overlay]');
  const sidebarToggle = document.querySelector('[data-docs-toggle]');
  const searchInput = document.querySelector('[data-doc-search]');
  const searchStatus = document.querySelector('[data-search-status]');
  const clearSearch = document.querySelector('[data-clear-search]');
  const searchEmpty = document.querySelector('[data-search-empty]');
  const sections = [...document.querySelectorAll('[data-doc-section]')];
  const tocLinks = [...document.querySelectorAll('[data-toc-link]')];
  const progressBar = document.querySelector('[data-progress-bar]');
  let activeSectionId = '';
  let lastLightboxTrigger = null;
  let lightboxItems = [];
  let lightboxIndex = 0;
  let scrollFrame = null;

  const lightbox = document.getElementById('lightbox');
  const lightboxImage = document.querySelector('[data-lightbox-image]');
  const lightboxTitle = document.querySelector('[data-lightbox-title]');
  const lightboxCounter = document.querySelector('[data-lightbox-counter]');
  const lightboxPrev = document.querySelector('[data-lightbox-prev]');
  const lightboxNext = document.querySelector('[data-lightbox-next]');

  function closeSidebar() {
    sidebar?.classList.remove('is-open');
    overlay?.classList.remove('is-open');
    sidebarToggle?.setAttribute('aria-expanded', 'false');
    body.classList.remove('docs-menu-open');
  }

  function openSidebar() {
    sidebar?.classList.add('is-open');
    overlay?.classList.add('is-open');
    sidebarToggle?.setAttribute('aria-expanded', 'true');
    body.classList.add('docs-menu-open');
  }

  function toggleSidebar() {
    if (sidebar?.classList.contains('is-open')) closeSidebar();
    else openSidebar();
  }

  function updateSearch() {
    const query = (searchInput?.value || '').trim().toLowerCase();
    let visible = 0;
    sections.forEach((section) => {
      const match = !query || section.textContent.toLowerCase().includes(query);
      section.hidden = !match;
      if (match) visible += 1;
    });

    tocLinks.forEach((link) => {
      const targetId = link.getAttribute('href')?.slice(1);
      const target = targetId ? document.getElementById(targetId) : null;
      link.classList.toggle('is-hidden', Boolean(target?.hidden));
    });

    if (searchStatus) {
      if (!query) {
        searchStatus.innerHTML = `${sections.length} sections in this guide`;
      } else {
        searchStatus.innerHTML = `<strong>${visible}</strong> ${visible === 1 ? 'section' : 'sections'} matching “${escapeHtml(query)}”`;
      }
    }
    searchEmpty?.classList.toggle('is-visible', Boolean(query) && visible === 0);
    clearSearch?.classList.toggle('is-visible', Boolean(query));

    if (visible > 0 && query && activeSectionId) {
      const active = document.getElementById(activeSectionId);
      if (active?.hidden) {
        activeSectionId = '';
        tocLinks.forEach((link) => link.classList.remove('is-active'));
      }
    }
  }

  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char]));
  }

  function clearDocSearch() {
    if (!searchInput) return;
    searchInput.value = '';
    updateSearch();
    searchInput.focus();
  }

  function updateProgress() {
    if (!progressBar) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const value = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
    progressBar.style.width = `${value}%`;
  }

  function updateActiveSection() {
    if (!sections.length) return;
    const probe = window.scrollY + 220;
    let current = sections[0];
    sections.forEach((section) => {
      if (!section.hidden && section.offsetTop <= probe) current = section;
    });
    if (!current || current.hidden || current.id === activeSectionId) return;
    activeSectionId = current.id;
    tocLinks.forEach((link) => {
      link.classList.toggle('is-active', link.getAttribute('href') === `#${activeSectionId}`);
    });
  }

  function onScroll() {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = null;
      updateProgress();
      updateActiveSection();
    });
  }

  function renderLightbox() {
    if (!lightboxImage) return;
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
    body.classList.add('lightbox-open');
    closeSidebar();
    lightbox.querySelector('[data-lightbox-close]')?.focus();
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    body.classList.remove('lightbox-open');
    if (lastLightboxTrigger) lastLightboxTrigger.focus();
    lastLightboxTrigger = null;
  }

  function stepLightbox(direction) {
    if (lightboxItems.length < 2) return;
    lightboxIndex = (lightboxIndex + direction + lightboxItems.length) % lightboxItems.length;
    renderLightbox();
  }

  function collectLightboxItems() {
    return [...document.querySelectorAll('[data-lightbox]')].map((button) => {
      const img = button.querySelector('img');
      return {
        src: button.dataset.src || img?.getAttribute('src') || '',
        title: button.dataset.title || img?.alt || 'Nexuzy PMS screenshot',
        alt: button.dataset.alt || img?.alt || ''
      };
    });
  }

  function setupLightbox() {
    const figures = [...document.querySelectorAll('[data-lightbox]')];
    figures.forEach((trigger) => {
      trigger.addEventListener('click', () => {
        const all = collectLightboxItems();
        const index = figures.indexOf(trigger);
        openLightbox(all, Math.max(0, index), trigger);
      });
    });

    lightbox?.addEventListener('click', (event) => {
      if (event.target.closest('[data-lightbox-close]') || event.target.closest('[data-lightbox-backdrop]')) {
        closeLightbox();
        return;
      }
      if (event.target.closest('[data-lightbox-prev]')) stepLightbox(-1);
      if (event.target.closest('[data-lightbox-next]')) stepLightbox(1);
    });
  }

  function setupCopyButtons() {
    document.querySelectorAll('[data-copy-target]').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        if (!target) return;
        const text = target.textContent;
        try {
          await navigator.clipboard.writeText(text);
          const original = button.innerHTML;
          button.textContent = 'Copied';
          window.setTimeout(() => { button.innerHTML = original; }, 1600);
        } catch {
          button.textContent = 'Select';
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });
    });
  }

  sidebarToggle?.addEventListener('click', toggleSidebar);
  overlay?.addEventListener('click', closeSidebar);
  sidebar?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeSidebar));

  tocLinks.forEach((link) => {
    link.addEventListener('click', () => {
      const target = link.getAttribute('href')?.slice(1);
      if (!target) return;
      activeSectionId = target;
      tocLinks.forEach((item) => item.classList.toggle('is-active', item === link));
    });
  });

  searchInput?.addEventListener('input', updateSearch);
  clearSearch?.addEventListener('click', clearDocSearch);
  searchInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') clearDocSearch();
  });

  document.querySelectorAll('[data-print]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (lightbox?.classList.contains('is-open')) closeLightbox();
      else closeSidebar();
    }
    if (!lightbox?.classList.contains('is-open')) return;
    if (event.key === 'ArrowLeft') stepLightbox(-1);
    if (event.key === 'ArrowRight') stepLightbox(1);
  });

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 800) closeSidebar();
    onScroll();
  });

  document.querySelectorAll('[data-year]').forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });

  setupLightbox();
  setupCopyButtons();
  updateSearch();
  updateProgress();
  updateActiveSection();
})();

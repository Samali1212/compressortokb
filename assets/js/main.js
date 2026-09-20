
/* Main Navigation, Theme Toggle & FAQ Accordion - Compress To KB */
document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // Mobile Nav Toggle
  var menuBtn = document.getElementById('mobile-menu-btn');
  var mobileNav = document.getElementById('mobile-nav');
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener('click', function () {
      var isOpen = mobileNav.classList.toggle('active');
      mobileNav.hidden = !isOpen;
      menuBtn.setAttribute('aria-expanded', isOpen);
      menuBtn.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    });

    document.addEventListener('click', function (e) {
      if (!mobileNav.contains(e.target) && !menuBtn.contains(e.target) && mobileNav.classList.contains('active')) {
        mobileNav.classList.remove('active');
        mobileNav.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.setAttribute('aria-label', 'Open menu');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && mobileNav.classList.contains('active')) {
        mobileNav.classList.remove('active');
        mobileNav.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn.setAttribute('aria-label', 'Open menu');
      }
    });
  }

  // Theme Toggle
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var current = document.documentElement.getAttribute('data-theme') || 'light';
      var next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
    });
  }

  // More Tools Dropdown (Desktop)
  var moreBtn = document.getElementById('more-tools-btn');
  var moreDropdown = document.getElementById('more-tools-dropdown');
  if (moreBtn && moreDropdown) {
    moreBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var isOpen = moreDropdown.classList.toggle('active');
      moreBtn.setAttribute('aria-expanded', isOpen);
    });

    document.addEventListener('click', function (e) {
      if (!moreDropdown.contains(e.target) && !moreBtn.contains(e.target) && moreDropdown.classList.contains('active')) {
        moreDropdown.classList.remove('active');
        moreBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && moreDropdown.classList.contains('active')) {
        moreDropdown.classList.remove('active');
        moreBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // FAQ Accordion
  var faqButtons = document.querySelectorAll('.faq-toggle');
  faqButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.closest('.faq-item');
      if (!item) return;
      var isExpanded = btn.getAttribute('aria-expanded') === 'true';
      var panelId = btn.getAttribute('aria-controls');
      var panel = document.getElementById(panelId);
      if (!panel) return;

      // Close all other items
      document.querySelectorAll('.faq-item.active').forEach(function (openItem) {
        if (openItem !== item) {
          openItem.classList.remove('active');
          var openBtn = openItem.querySelector('.faq-toggle');
          if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
        }
      });

      // Toggle current
      item.classList.toggle('active');
      btn.setAttribute('aria-expanded', String(!isExpanded));
    });
  });
}());

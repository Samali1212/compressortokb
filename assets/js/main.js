/* ===================================================
   Compress To KB - Main Global JavaScript (main.js)
   =================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // 1. Theme Toggle
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      try {
        localStorage.setItem('theme', newTheme);
      } catch (e) {}
    });
  }

  // 2. Mobile Menu Toggle
  const mobileMenuBtn = document.getElementById('mobile-menu-btn');
  const mobileNav = document.getElementById('mobile-nav');

  if (mobileMenuBtn && mobileNav) {
    mobileMenuBtn.addEventListener('click', () => {
      const isExpanded = mobileMenuBtn.getAttribute('aria-expanded') === 'true';
      mobileMenuBtn.setAttribute('aria-expanded', !isExpanded);
      mobileNav.classList.toggle('active');
      if (mobileNav.hasAttribute('hidden')) {
        mobileNav.removeAttribute('hidden');
      } else {
        mobileNav.setAttribute('hidden', '');
      }
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!mobileNav.contains(e.target) && !mobileMenuBtn.contains(e.target) && mobileNav.classList.contains('active')) {
        mobileNav.classList.remove('active');
        mobileNav.setAttribute('hidden', '');
        mobileMenuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // 3. FAQ Accordion Toggle
  const faqToggles = document.querySelectorAll('.faq-toggle');
  faqToggles.forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const faqItem = toggle.closest('.faq-item');
      const isExpanded = toggle.getAttribute('aria-expanded') === 'true';

      // Close other open FAQs if needed (Optional: smooth UX)
      document.querySelectorAll('.faq-item.active').forEach((item) => {
        if (item !== faqItem) {
          item.classList.remove('active');
          const btn = item.querySelector('.faq-toggle');
          if (btn) btn.setAttribute('aria-expanded', 'false');
        }
      });

      // Toggle current
      if (isExpanded) {
        faqItem.classList.remove('active');
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        faqItem.classList.add('active');
        toggle.setAttribute('aria-expanded', 'true');
      }
    });
  });
});

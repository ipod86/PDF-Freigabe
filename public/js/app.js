// ─── app.js ──────────────────────────────────────────────────────────────────
// Client-seitiges JavaScript – PDF-Freigabetool
// getCsrfToken() und csrfFetch() sind im Header definiert (inline)
// ──────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  const CSRF = getCsrfToken();

  // ─── Mobile Sidebar Toggle ────────────────────────────────────────────────
  const toggle = document.getElementById('mobileToggle');
  const sidebar = document.getElementById('sidebar');

  if (toggle && sidebar) {
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
  }

  // ─── Toast Auto-Hide ─────────────────────────────────────────────────────
  const toast = document.getElementById('toast');
  if (toast) {
    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s, transform 0.3s';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ─── Tooltips für Comment-Icons ───────────────────────────────────────────
  document.querySelectorAll('.comment-icon[title]').forEach(el => {
    el.addEventListener('mouseenter', function (e) {
      const tip = document.createElement('div');
      tip.className = 'custom-tooltip';
      tip.textContent = this.getAttribute('title');
      tip.style.cssText = `
        position:fixed;background:#1a1d26;color:#fff;padding:8px 14px;
        border-radius:6px;font-size:0.8rem;max-width:280px;z-index:9999;
        pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.2);
      `;
      document.body.appendChild(tip);
      const r = this.getBoundingClientRect();
      tip.style.left = (r.left + r.width / 2 - tip.offsetWidth / 2) + 'px';
      tip.style.top = (r.top - tip.offsetHeight - 8) + 'px';
      this._tooltip = tip;
    });
    el.addEventListener('mouseleave', function () {
      if (this._tooltip) { this._tooltip.remove(); this._tooltip = null; }
    });
  });

  // ─── Search ───────────────────────────────────────────────────────────────
  const searchInput = document.querySelector('.search-box input');
  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const status = searchInput.dataset.status;
        let url = '/dashboard?q=' + encodeURIComponent(searchInput.value);
        if (status) url += '&status=' + status;
        window.location.href = url;
      }
    });
  }

  // ─── Zeilen klickbar ──────────────────────────────────────────────────────
  document.querySelectorAll('.data-table .job-link').forEach(link => {
    const row = link.closest('tr');
    if (row) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', (e) => {
        if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input') || e.target.closest('.col-actions') || e.target.closest('.col-check')) return;
        link.click();
      });
    }
  });

  // ─── Copy to Clipboard ────────────────────────────────────────────────────
  document.querySelectorAll('.copy-input').forEach(input => {
    input.addEventListener('click', function () {
      this.select();
      navigator.clipboard.writeText(this.value).then(() => {
        const orig = this.style.borderColor;
        this.style.borderColor = '#10b981';
        setTimeout(() => { this.style.borderColor = orig; }, 1500);
      });
    });
  });

  // ─── Keyboard Shortcuts ───────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Nicht in Input-Feldern
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    // N = Neue Freigabe
    if (e.key === 'n' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      window.location.href = '/jobs/create';
    }
    // D = Dashboard
    if (e.key === 'd' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      window.location.href = '/dashboard';
    }
    // / = Suche fokussieren
    if (e.key === '/' && searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BENACHRICHTIGUNGS-BADGE (Polling)
  // ═══════════════════════════════════════════════════════════════════════════
  const notifLink = document.querySelector('.notification-link');

  if (notifLink) {
    setInterval(async () => {
      try {
        const res = await fetch('/api/notifications?unread=1');
        const items = await res.json();
        // Immer frisch suchen (nicht cachen)
        const existing = notifLink.querySelector('.notif-count-badge');
        if (items.length > 0) {
          if (existing) {
            existing.textContent = items.length > 9 ? '9+' : items.length;
          } else {
            const b = document.createElement('span');
            b.className = 'notif-count-badge';
            b.textContent = items.length > 9 ? '9+' : items.length;
            notifLink.appendChild(b);
          }
        } else if (existing) {
          existing.remove();
        }
      } catch { /* ignore */ }
    }, 60000);
  }

});

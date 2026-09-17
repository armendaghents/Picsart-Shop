export default function Footer({ t }) {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="site-footer-grid">
        <div className="site-footer-brand">
          <img className="brand-mark" src="/picsart-logo.jpeg" alt="Picsart" />
          <div>
            <strong>Picsart Shop</strong>
            <p>{t.tagline}</p>
          </div>
        </div>
      </div>

      <div className="site-footer-bottom">
        <span>© {year} Picsart Shop. {t.rightsReserved}</span>
      </div>
    </footer>
  );
}

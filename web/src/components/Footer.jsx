export default function Footer({ t }) {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="site-footer-grid">
        <div className="site-footer-brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>Atlas</strong>
            <p>{t.tagline}</p>
          </div>
        </div>

        <div className="site-footer-column">
          <h4>Shop</h4>
          <a href="#">All products</a>
          <a href="#">Categories</a>
          <a href="#">New arrivals</a>
        </div>

        <div className="site-footer-column">
          <h4>Support</h4>
          <a href="#">Contact us</a>
          <a href="#">Shipping & returns</a>
          <a href="#">FAQ</a>
        </div>

        <div className="site-footer-column">
          <h4>Company</h4>
          <a href="#">About</a>
          <a href="#">Terms of service</a>
          <a href="#">Privacy policy</a>
        </div>
      </div>

      <div className="site-footer-bottom">
        <span>© {year} Atlas. All rights reserved.</span>
      </div>
    </footer>
  );
}

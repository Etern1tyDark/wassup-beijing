import { useContext } from 'react';
import { Icon, type IconName } from './icons';
import { LanguageContext, useT, type StringKey } from './i18n';
import { href, scrollToSection } from './route';
import { useTheme } from './theme';

/**
 * The public home page: what Stonks is, why it is safe, and one way into the
 * demo. Everything here is static; the live product is behind "Launch demo".
 * The figures quoted are the recorded results in evidence/results.md.
 */

const FEATURES: Array<{ icon: IconName; title: StringKey; body: StringKey }> = [
  { icon: 'sparkle', title: 'home.f1Title', body: 'home.f1Body' },
  { icon: 'shield', title: 'home.f2Title', body: 'home.f2Body' },
  { icon: 'check', title: 'home.f3Title', body: 'home.f3Body' },
  { icon: 'undo', title: 'home.f4Title', body: 'home.f4Body' },
  { icon: 'eye', title: 'home.f5Title', body: 'home.f5Body' },
  { icon: 'link', title: 'home.f6Title', body: 'home.f6Body' },
];

const STEPS: Array<{ icon: IconName; title: StringKey; body: StringKey }> = [
  { icon: 'chat', title: 'home.step1Title', body: 'home.step1Body' },
  { icon: 'eye', title: 'home.step2Title', body: 'home.step2Body' },
  { icon: 'check', title: 'home.step3Title', body: 'home.step3Body' },
];

const STATS: Array<{ value: string; label: StringKey }> = [
  { value: '43/43', label: 'home.stat1' },
  { value: '8/8', label: 'home.stat2' },
  { value: '0', label: 'home.stat3' },
  { value: '6', label: 'home.stat4' },
];

const SECURITY_POINTS: StringKey[] = ['home.sec1', 'home.sec2', 'home.sec3', 'home.sec4'];

const TIERS: Array<{ tier: string; text: StringKey }> = [
  { tier: 'T0', text: 'home.tier0' },
  { tier: 'T1', text: 'home.tier1' },
  { tier: 'T2', text: 'home.tier2' },
  { tier: 'T3', text: 'home.tier3' },
];

const NAV: Array<{ section: string; label: StringKey }> = [
  { section: 'features', label: 'home.navFeatures' },
  { section: 'how', label: 'home.navHow' },
  { section: 'security', label: 'home.navSecurity' },
];

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M3 17l6-6 4 4 8-8M15 7h6v6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function LaunchLink({
  hasData,
  large = false,
  testId,
}: {
  hasData: boolean;
  large?: boolean;
  testId: string;
}) {
  const t = useT();
  return (
    <a className={`btn btn-primary${large ? ' btn-large' : ''}`} href={href('demo')} data-testid={testId}>
      {hasData ? t('home.openDashboard') : t('home.launch')}
      <Icon name="send" size={16} />
    </a>
  );
}

/** A still picture of the approval card, so the first screen shows the product, not a promise. */
function ProductPreview() {
  const t = useT();
  return (
    <div className="preview" role="img" aria-label={t('home.previewLabel')}>
      <div className="preview-card" aria-hidden="true">
        <div className="preview-head">
          <span className="approval-icon">
            <Icon name="shield" />
          </span>
          <div>
            <span className="eyebrow">{t('approval.needed')}</span>
            <strong>
              <code>earmark.create</code> <span className="tier tier-t2">T2</span>
            </strong>
          </div>
        </div>
        <p className="preview-summary">
          Set aside Rp 3.000.000 as “Medical reserve”. The money stays in your account.
        </p>
        <div className="preview-rows">
          <span>{t('balances.safeToSpend')}</span>
          <span>Rp 7.987.506</span>
          <span className="delta delta-down">↓ Rp 4.987.506</span>
          <span>{t('balances.freeCash')}</span>
          <span>Rp 12.228.931</span>
          <span className="delta delta-down">↓ Rp 9.228.931</span>
          <span>{t('runway.title')}</span>
          <span>2.7</span>
          <span className="delta delta-down">↓ 2.3</span>
        </div>
        <ul className="preview-checks">
          <li>
            <Icon name="check" size={13} /> <code>amount &lt;= freeCash</code>
          </li>
          <li>
            <Icon name="check" size={13} /> <code>amount &lt;= perActionCap</code>
          </li>
          <li>
            <Icon name="check" size={13} /> <code>reviewDate is set</code>
          </li>
        </ul>
        <div className="preview-actions">
          <span className="preview-approve">
            <Icon name="check" size={14} /> {t('approval.approve')}
          </span>
          <span className="preview-reject">{t('approval.reject')}</span>
        </div>
      </div>
      <div className="preview-float preview-float-top" aria-hidden="true">
        <span className="eyebrow">{t('runway.title')}</span>
        <strong>80 {t('home.days')}</strong>
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="preview-spark">
          <path d="M0 18 L12 14 L22 16 L30 6 L38 9 L52 10 L64 12 L74 15 L86 20 L100 26" />
        </svg>
      </div>
      <div className="preview-float preview-float-bottom" aria-hidden="true">
        <span className="dot" />
        <span>
          <strong>{t('home.previewChain')}</strong>
          <code>sha256:550fd0f0…</code>
        </span>
      </div>
    </div>
  );
}

export function HomePage({ hasData }: { hasData: boolean }) {
  const t = useT();
  const { language, setLanguage } = useContext(LanguageContext);
  const { theme, toggle } = useTheme();
  const themeLabel = theme === 'dark' ? t('app.themeLight') : t('app.themeDark');

  return (
    <div className="home" data-testid="home">
      <header className="home-nav">
        <a className="brand brand-link" href={href('home')} onClick={() => scrollToSection(null)}>
          <BrandMark />
          <span className="brand-text">
            <strong>{t('app.brand')}</strong>
            <span>{t('app.brandSub')}</span>
          </span>
        </a>
        <nav className="home-links" aria-label={t('nav.label')}>
          {NAV.map((item) => (
            <a
              key={item.section}
              href={href('home', item.section)}
              onClick={() => scrollToSection(item.section)}
            >
              {t(item.label)}
            </a>
          ))}
        </nav>
        <div className="actions home-nav-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={toggle}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button
            type="button"
            className="icon-button"
            data-testid="home-language-toggle"
            aria-label={t('app.language')}
            title={t('app.language')}
            onClick={() => setLanguage(language === 'en' ? 'id' : 'en')}
          >
            <Icon name="globe" />
          </button>
          <LaunchLink hasData={hasData} testId="launch-demo-nav" />
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="hero-badge">
              <span className="dot" aria-hidden="true" />
              {t('home.badge')}
            </p>
            <h1 className="hero-title">
              {t('home.titleLead')} <span className="hero-accent">{t('home.titleAccent')}</span>
            </h1>
            <p className="hero-lede">{t('home.lede')}</p>
            <div className="actions hero-actions">
              <LaunchLink hasData={hasData} large testId="launch-demo" />
              <a className="btn btn-large" href={href('home', 'how')} onClick={() => scrollToSection('how')}>
                {t('home.ctaSecondary')}
              </a>
            </div>
            <ul className="hero-trust">
              {(['home.trust1', 'home.trust2', 'home.trust3'] as const).map((key) => (
                <li key={key}>
                  <Icon name="check" size={15} /> {t(key)}
                </li>
              ))}
            </ul>
          </div>
          <ProductPreview />
        </section>

        <section className="stats" aria-label="Results">
          {STATS.map((stat) => (
            <div key={stat.label} className="stat">
              <strong>{stat.value}</strong>
              <span>{t(stat.label)}</span>
            </div>
          ))}
        </section>

        <section id="features" className="home-section">
          <header className="home-section-head">
            <p className="eyebrow">{t('home.navFeatures')}</p>
            <h2>{t('home.featuresTitle')}</h2>
            <p>{t('home.featuresSub')}</p>
          </header>
          <ul className="feature-grid">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="feature">
                <span className="card-icon" aria-hidden="true">
                  <Icon name={feature.icon} />
                </span>
                <h3>{t(feature.title)}</h3>
                <p>{t(feature.body)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="how" className="home-section">
          <header className="home-section-head">
            <p className="eyebrow">{t('home.navHow')}</p>
            <h2>{t('home.howTitle')}</h2>
          </header>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="step">
                <span className="step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="step-icon" aria-hidden="true">
                  <Icon name={step.icon} />
                </span>
                <h3>{t(step.title)}</h3>
                <p>{t(step.body)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="security" className="home-section security-band">
          <div className="security-copy">
            <p className="eyebrow">{t('home.secEyebrow')}</p>
            <h2>{t('home.secTitle')}</h2>
            <p>{t('home.secBody')}</p>
            <ul className="security-points">
              {SECURITY_POINTS.map((key) => (
                <li key={key}>
                  <Icon name="shield" size={16} />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="tier-ladder">
            <strong>{t('home.tiersTitle')}</strong>
            <ol>
              {TIERS.map((item) => (
                <li key={item.tier}>
                  <span className={`tier tier-${item.tier.toLowerCase()}`}>{item.tier}</span>
                  <span>{t(item.text)}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="cta-band">
          <h2>{t('home.ctaTitle')}</h2>
          <p>{t('home.ctaBody')}</p>
          <LaunchLink hasData={hasData} large testId="launch-demo-cta" />
        </section>
      </main>

      <footer className="home-footer">
        <span className="brand">
          <BrandMark />
          <strong>{t('app.brand')}</strong>
        </span>
        <p>{t('home.footer')}</p>
      </footer>
    </div>
  );
}

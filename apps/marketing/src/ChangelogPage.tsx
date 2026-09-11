// input: Full release-note HTML generated from the desktop's versioned Markdown
// output: On-site release archive with permanent version anchors
// pos: Public /changelog/ page

export type ReleaseNote = { version: string; html: string };

export function ChangelogPage({ releases }: { releases: ReleaseNote[] }) {
  return (
    <section
      className="section changelog changelog-page"
      id="release-history"
      aria-labelledby="changelog-title"
    >
      <div className="container">
        <h1 className="section-heading" id="changelog-title">更新日志</h1>
        <p className="changelog-intro">每一次改进，都记录在这里。</p>
        <div className="release-layout">
          <nav className="release-nav" aria-label="历史版本">
            {releases.map(({ version }) => (
              <a key={version} href={`#v${version}`}>v{version}</a>
            ))}
          </nav>
          <div className="release-history">
            {releases.map(({ version, html }) => (
              <article className="release-entry" id={`v${version}`} key={version} aria-labelledby={`title-v${version}`}>
                <h2 id={`title-v${version}`}><a href={`#v${version}`}>v{version}</a></h2>
                {/* HTML is rendered and sanitized by react-markdown at build time. */}
                <div className="release-content" dangerouslySetInnerHTML={{ __html: html }} />
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

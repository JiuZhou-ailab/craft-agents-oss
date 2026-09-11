// input: Curated published Storyflow release summaries
// output: Standalone release history with links to full release notes
// pos: Public /changelog/ page

// Release summaries are curated from the existing release notes and verified tags.
const releases = [
  {
    version: "0.21.3",
    date: "2026-09-09",
    title: "待回答问题可恢复，文件操作更完整",
  },
  {
    version: "0.21.2",
    date: "2026-09-08",
    title: "长对话更流畅，搜索直达正文",
  },
  { version: "0.21.1", date: "2026-09-07", title: "会话排序与项目归属更清楚" },
  { version: "0.21.0", date: "2026-09-07", title: "定时任务与文件预览更新" },
];

export function ChangelogPage() {
  return (
    <section
      className="section changelog changelog-page"
      id="release-history"
      aria-labelledby="changelog-title"
    >
      <div className="container">
        <h1 className="section-heading" id="changelog-title">
          更新日志
        </h1>
        <p className="changelog-intro">
          Storyflow 的版本更新。选择一个版本，查看完整发布说明。
        </p>
        <div className="release-grid">
          {releases.map((release) => (
            <a
              className="release-card"
              key={release.version}
              href={`https://github.com/JiuZhou-ailab/storyflow/releases/tag/v${release.version}`}
            >
              <div>
                <span className="release-version">{release.version}</span>
                <time dateTime={release.date}>{release.date}</time>
              </div>
              <h2>{release.title}</h2>
            </a>
          ))}
        </div>
        <a
          className="text-arrow"
          href="https://github.com/JiuZhou-ailab/storyflow/releases"
        >
          查看全部更新 →
        </a>
      </div>
    </section>
  );
}

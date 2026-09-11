// input: Storyflow release links, local product screenshots, and promo video
// output: Chinese product landing page and in-site tutorial navigation
// pos: React surface for the public marketing route

import { useEffect, useRef, useState, type ReactNode } from "react";

import { downloadOptions as releaseDownloadOptions } from "./downloads";
import { DocsPage } from "./DocsPage";
import {
  WritingDemo,
  ReviewExcerpt,
  ProjectDemo,
  SkillsDemo,
} from "./WritingDemo";

const assets = {
  dataResults: "/reference-assets/storyflow-data-results.webp",
  skills: "/reference-assets/storyflow-skills-detail.webp",
  reviewDiff: "/reference-assets/storyflow-review-diff.png",
  versionHistory: "/reference-assets/storyflow-version-history.png",
};

const docsPath = "/docs/";
const landingPath = "/";

type PageTarget = {
  pathname: string;
  hash: string;
};

const faqs = [
  {
    question: "它和普通 AI 聊天窗口有什么区别？",
    answer:
      "普通聊天只保留对话。Storyflow 以真实项目文件为中心：正文、设定、大纲、素材和 Agent 改动都留在同一个桌面项目里。",
  },
  {
    question: "适合哪些创作项目？",
    answer:
      "网文、长篇、短篇和连载，尤其适合需要持续维护人物、设定、时间线和前文状态的项目。",
  },
  {
    question: "Agent 会直接改我的正文吗？",
    answer:
      "会，但只有在允许写入的执行模式中才会操作。修改会写入项目文件，同时保留差异审阅和版本恢复；你可以接受、拒绝或继续调整。",
  },
  {
    question: "大纲、人物、设定能一起管理吗？",
    answer:
      "可以。项目目录原生显示真实文件，你可以按自己的方式组织正文、大纲、人物、设定和素材。",
  },
  {
    question: "可以让它连续写多个章节吗？",
    answer:
      "可以。你可以把章节目标交给 Agent 分步执行；结果写入项目文件，并在会话中保留执行记录。",
  },
  {
    question: "本地项目是否等于离线模型？",
    answer:
      "不等于。作品文件保存在你选择的本地目录；模型请求会发送给你配置的服务商。",
  },
] as const;

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

function Icon({ name }: { name: string }) {
  if (name === "download") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
    );
  }

  if (name === "play") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="10" opacity="0.3" />
        <path d="M10 7.5v9l6-4.5-6-4.5z" />
      </svg>
    );
  }

  if (name === "windows") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function Header({ isDocsPage }: { isDocsPage: boolean }) {
  return (
    <header className="site-header" id="site-header">
      <div className="header-inner">
        <a
          className="header-mark"
          href={landingPath}
          aria-label="Storyflow"
          data-storyflow-page-link="true"
        >
          <img src="/apple-touch-icon.png" alt="" />
          <span>Storyflow</span>
        </a>
        <nav className="header-nav" aria-label="页面导航">
          <a href="/#workflow" data-storyflow-page-link="true">
            理解产品
          </a>
          <a
            href={docsPath}
            aria-current={isDocsPage ? "page" : undefined}
            data-storyflow-page-link="true"
          >
            新手教程
          </a>
          <a href="/#downloads" data-storyflow-page-link="true">
            下载
          </a>
        </nav>
        <div className="header-actions">
          <a
            className="button button-ghost header-docs-button"
            href={docsPath}
            data-storyflow-page-link="true"
          >
            文档
          </a>
          <a
            className="button button-primary button-sm header-download-desktop"
            href="/#downloads"
            data-storyflow-page-link="true"
          >
            下载
          </a>
          <a
            className="button button-primary button-sm header-download-mobile"
            href="/docs/#install"
            data-storyflow-page-link="true"
          >
            下载
          </a>
        </div>
      </div>
    </header>
  );
}

function useDownloadLabel() {
  const [label, setLabel] = useState("下载 macOS 版本");

  useEffect(() => {
    setLabel(
      /Windows/i.test(navigator.userAgent)
        ? "下载 Windows 版本"
        : "下载 macOS 版本",
    );
  }, []);

  return label;
}

function DownloadMenu({ marked = false }: { marked?: boolean }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const label = useDownloadLabel();
  const optionsId = marked ? "installer-options" : "installer-options-footer";

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div
      className="download-menu"
      ref={menuRef}
      id={marked ? "downloads" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          menuRef.current?.querySelector("button")?.focus();
        }
      }}
    >
      <button
        className="button button-primary"
        type="button"
        aria-expanded={open}
        aria-controls={optionsId}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
        <span className="button-icon" aria-hidden="true">
          <Icon name="download" />
        </span>
      </button>
      {open ? (
        <div className="download-popover" id={optionsId}>
          {releaseDownloadOptions.map((option) => (
            <a download href={option.href} key={option.id}>
              <Icon
                name={option.platform === "Windows" ? "windows" : "apple"}
              />
              <span>
                {option.label}
                <small>{option.detail}</small>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProductWindow({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={`product-window ${className}`.trim()}>
      <div className="product-chrome">
        <span className="product-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="product-title">{title}</span>
      </div>
      <div className="product-body">{children}</div>
    </figure>
  );
}

function Hero() {
  const [writingActive, setWritingActive] = useState(false);
  const activateWindow = (event: React.SyntheticEvent) => {
    setWritingActive(
      Boolean((event.target as Element).closest(".hero-primary-window")),
    );
  };
  return (
    <section className="section hero">
      <div className="container">
        <div className="hero-copy">
          <h1>Storyflow 是小说创作者的 AI 写作工作台。</h1>
          <div className="button-row">
            <div className="hero-desktop-cta">
              <DownloadMenu marked />
            </div>
            <a
              className="button button-primary hero-mobile-cta"
              href={docsPath}
              data-storyflow-page-link="true"
            >
              跟着教程开始
              <span className="button-icon" aria-hidden="true">
                →
              </span>
            </a>
            <a
              className="button button-secondary hero-desktop-cta"
              href={docsPath}
              data-storyflow-page-link="true"
            >
              跟着教程开始
              <span className="button-icon" aria-hidden="true">
                →
              </span>
            </a>
          </div>
        </div>
        <div
          className={`hero-stage${writingActive ? " writing-active" : ""}`}
          onPointerDownCapture={activateWindow}
          onFocusCapture={activateWindow}
        >
          <div className="hero-primary-window">
            <WritingDemo />
          </div>
          <ProductWindow
            title="Storyflow · 改动审阅"
            className="hero-secondary-window"
          >
            <ReviewExcerpt />
          </ProductWindow>
        </div>
      </div>
    </section>
  );
}

function ProductCapture({
  src,
  alt,
  detail = "",
}: {
  src: string;
  alt: string;
  detail?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className={`product-capture ${detail}`}>
      <a
        className="capture-viewport"
        href={src}
        target="_blank"
        rel="noreferrer"
        aria-label={`查看完整截图：${alt}`}
      >
        {failed ? (
          <p className="capture-fallback">
            {alt}。截图暂未加载，你仍可通过下方教程了解操作。
          </p>
        ) : (
          <img
            src={src}
            alt={alt}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        )}
      </a>
      <figcaption>
        <span>{alt}</span>
        <a href={src} target="_blank" rel="noreferrer">
          完整截图 ↗
        </a>
      </figcaption>
    </figure>
  );
}

function FeatureBand({
  id,
  title,
  body,
  href,
  linkLabel,
  media,
  reverse = false,
}: {
  id?: string;
  title: string;
  body: string;
  href: string;
  linkLabel: string;
  media: ReactNode;
  reverse?: boolean;
}) {
  const isPageLink = href.startsWith("/") && !href.startsWith("/http");

  return (
    <section className="section feature-section" id={id}>
      <div className="container">
        <article
          className={reverse ? "feature-card is-reverse" : "feature-card"}
        >
          <div className="feature-copy">
            <h2>{title}</h2>
            <p>{body}</p>
            <a
              className="text-arrow"
              href={href}
              data-storyflow-page-link={isPageLink ? "true" : undefined}
            >
              {linkLabel}
            </a>
          </div>
          <div className="feature-media">{media}</div>
        </article>
      </div>
    </section>
  );
}

function LandingPage() {
  return (
    <>
      <Hero />
      {/* Customer proof is blocked on real customer material; see implementation notes. */}

      <FeatureBand
        id="workflow"
        title="Agent 把创作目标写成正文"
        body="把章节目标交给 Agent，让正文在项目中形成，而你专注于创作中的判断。"
        href="/docs/#first-task"
        linkLabel="跟着教程开始 →"
        media={<WritingDemo label="创作过程演示" />}
      />

      <FeatureBand
        id="review"
        title="先探索，再执行"
        body="先讨论方向，再让 Agent 修改文件。查看具体增删，决定接受还是拒绝。"
        href="/docs/#review-changes"
        linkLabel="了解改动审阅 →"
        reverse
        media={
          <ProductWindow title="Storyflow · 改动审阅" className="review-window">
            <div className="review-heading">每处修改，由你决定</div>
            <ReviewExcerpt />
            <a
              className="capture-source"
              href={assets.reviewDiff}
              target="_blank"
              rel="noreferrer"
            >
              查看真实审阅界面 ↗
            </a>
          </ProductWindow>
        }
      />

      <FeatureBand
        id="context"
        title="人物、设定和前文都在同一项目"
        body="让 Agent 带着作品的上下文继续写。正文、人物与创作要求，始终是你自己的文件。"
        href="/#workflow"
        linkLabel="理解产品 →"
        media={<ProjectDemo />}
      />

      <FeatureBand
        id="skills"
        title="把写作方法沉淀为 Skills"
        body="把拆书、规划和审查方法带进下一次创作。按项目复用，随时查看和编辑。"
        href={docsPath}
        linkLabel="查看新手教程 →"
        reverse
        media={<SkillsDemo />}
      />

      {/* Testimonials and team section require supplied, attributable materials. */}
      <section className="section frontier" aria-labelledby="frontier-title">
        <div className="container">
          <h2 className="section-heading" id="frontier-title">
            围绕同一份作品持续推进
          </h2>
          <div className="frontier-grid">
            <article className="info-card">
              <h3>把方法留在项目里</h3>
              <p>把需要的 Skill 用到当前任务，下次创作继续使用。</p>
              <a
                className="text-arrow"
                href="/#skills"
                data-storyflow-page-link="true"
              >
                了解 Skills ↗
              </a>
              <ProductCapture
                src={assets.skills}
                alt="可查看和编辑的 Skill 方法"
                detail="capture-skills"
              />
            </article>
            <article className="info-card">
              <h3>把资料带进创作</h3>
              <p>在会话中查询榜单和资料，让参考内容服务于这次写作。</p>
              <a
                className="text-arrow"
                href="/docs/#header-tools"
                data-storyflow-page-link="true"
              >
                了解数据源 ↗
              </a>
              <ProductCapture
                src={assets.dataResults}
                alt="会话中的榜单查询结果"
                detail="capture-data"
              />
            </article>
            <article className="info-card">
              <h3>为作品留一个版本</h3>
              <p>保存本地版本节点，随时回看，必要时恢复更早的内容。</p>
              <a
                className="text-arrow"
                href="/docs/#review-changes"
                data-storyflow-page-link="true"
              >
                了解版本管理 ↗
              </a>
              <ProductCapture
                src={assets.versionHistory}
                alt="本地版本历史与恢复入口"
                detail="capture-history"
              />
            </article>
          </div>
        </div>
      </section>
      <section
        className="section changelog"
        id="changelog"
        aria-labelledby="changelog-title"
      >
        <div className="container">
          <h2 className="section-heading" id="changelog-title">
            更新日志
          </h2>
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
                <h3>{release.title}</h3>
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
      {/* Editorial highlights need published Storyflow articles, not tutorial filler. */}

      <section className="section closing">
        <div className="container closing-inner">
          <h2>现在就开始写。</h2>
          <div className="button-row button-row-center">
            <div className="hero-desktop-cta">
              <DownloadMenu />
            </div>
            <a
              className="button button-primary hero-mobile-cta"
              href={docsPath}
              data-storyflow-page-link="true"
            >
              跟着教程开始
              <span className="button-icon" aria-hidden="true">
                →
              </span>
            </a>
          </div>
          <p className="hero-platforms">
            macOS 12+ · Apple Silicon / Intel · Windows x64
          </p>
        </div>
      </section>
    </>
  );
}

function getCurrentPageTarget(): PageTarget {
  if (typeof window === "undefined") {
    return { pathname: landingPath, hash: "" };
  }

  return {
    pathname: window.location.pathname,
    hash: window.location.hash,
  };
}

function normalizePagePath(pathname: string) {
  const normalized = pathname.replace(/\/$/, "");
  return normalized === "" ? landingPath : normalized;
}

function isDocsPagePath(pathname: string) {
  return normalizePagePath(pathname) === "/docs";
}

function isHandledPagePath(pathname: string) {
  const normalized = normalizePagePath(pathname);
  return normalized === landingPath || normalized === "/docs";
}

function scrollToPageHash(hash: string) {
  window.requestAnimationFrame(() => {
    if (!hash) {
      window.scrollTo({ top: 0 });
      return;
    }

    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView();
    }
  });
}

export function App() {
  const [pageTarget, setPageTarget] = useState<PageTarget>(() =>
    getCurrentPageTarget(),
  );
  const isDocsPage = isDocsPagePath(pageTarget.pathname);

  useEffect(() => {
    document.title = isDocsPage
      ? "Storyflow 新手教程 - 从项目到第一份稿件"
      : "Storyflow - 小说创作者的 AI 桌面工作台";
  }, [isDocsPage]);

  useEffect(() => {
    const handlePopState = () => {
      setPageTarget(getCurrentPageTarget());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    scrollToPageHash(pageTarget.hash);
  }, [pageTarget]);

  const handlePageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }

    const link = (event.target as Element).closest<HTMLAnchorElement>(
      "a[data-storyflow-page-link='true']",
    );
    if (!link || link.target || link.hasAttribute("download")) {
      return;
    }

    const targetUrl = new URL(link.href, window.location.href);
    if (
      targetUrl.origin !== window.location.origin ||
      !isHandledPagePath(targetUrl.pathname)
    ) {
      return;
    }

    event.preventDefault();

    const nextTarget = {
      pathname: targetUrl.pathname,
      hash: targetUrl.hash,
    };
    const nextUrl = `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (nextUrl !== currentUrl) {
      window.history.pushState(null, "", nextUrl);
    }

    setPageTarget(nextTarget);
  };

  return (
    <div className="page-shell" onClick={handlePageClick}>
      <Header isDocsPage={isDocsPage} />
      <a className="skip-link" href="#main-content">
        跳到正文
      </a>
      <main className="main-content" id="main-content" tabIndex={-1}>
        {isDocsPage ? <DocsPage /> : <LandingPage />}
      </main>
      <footer className="site-footer">
        <div className="container footer-grid">
          <div>
            <strong>Storyflow</strong>
            <p>小说创作者的 AI 桌面工作台</p>
          </div>
          <div>
            <h3>产品</h3>
            <a href="/#workflow" data-storyflow-page-link="true">
              理解产品
            </a>
            <a href="/#review" data-storyflow-page-link="true">
              改动审阅
            </a>
            <a href="/docs/#install" data-storyflow-page-link="true">
              下载桌面版
            </a>
          </div>
          <div>
            <h3>资源</h3>
            <a href={docsPath} data-storyflow-page-link="true">
              文档
            </a>
            <a href={docsPath} data-storyflow-page-link="true">
              新手教程
            </a>
          </div>
          <div className="footer-help">
            <h3>常见问题</h3>
            {faqs.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
        <div className="container footer-meta">
          <span>© 2026 Storyflow</span>
          <span>支持 Apple Silicon、Intel Mac 和 Windows x64。</span>
        </div>
      </footer>
    </div>
  );
}

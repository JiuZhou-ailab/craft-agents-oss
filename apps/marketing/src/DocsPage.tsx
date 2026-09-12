// input: Current tutorial route and chapter catalog
// output: One chapter with site navigation, current-page outline and previous/next links
// pos: Public /docs/ route family; mounts only the selected chapter

import { useEffect, useRef, useState } from "react";
import { docsChapters, findDocsChapter } from "./docs-content";

export function DocsPage({ pathname }: { pathname: string }) {
  const chapter = findDocsChapter(pathname);
  const index = chapter ? docsChapters.indexOf(chapter) : -1;
  const previous = docsChapters[index - 1];
  const next = chapter ? docsChapters[index + 1] : undefined;
  const article = useRef<HTMLElement>(null);
  const [headings, setHeadings] = useState<
    { id: string; text: string; level: number }[]
  >([]);
  const [activeHeading, setActiveHeading] = useState("");

  useEffect(() => {
    const elements = Array.from(
      article.current?.querySelectorAll<HTMLElement>("h2[id], h3[id]") ?? [],
    );
    setHeadings(
      elements.map((heading) => ({
        id: heading.id,
        text: heading.textContent ?? "",
        level: Number(heading.tagName.slice(1)),
      })),
    );
    let frame = 0;
    const update = () => {
      frame = 0;
      const current =
        elements
          .filter((heading) => heading.getBoundingClientRect().top <= 108)
          .slice(-1)[0] ?? elements[0];
      setActiveHeading(current?.id ?? "");
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return (
    <div className="docs-layout">
      <section className="docs-hero">
        <p className="docs-kicker">Storyflow 新手教程</p>
        <h1>{chapter?.title ?? "没有找到这个教程页面"}</h1>
        {chapter?.path === "/docs/" && <p>用同一个小练习，分五步学会写作、修改和保存。打开桌面应用，从第一步开始。</p>}
      </section>
      <nav className="docs-toc" aria-label="教程目录">
        {["开始使用", "遇到问题"].map(group => (
          <div className="docs-nav-section" key={group}>
            <p>{group}</p>
            {docsChapters.filter(item => item.group === group).map(item => (
              <a key={item.path} href={item.path} data-storyflow-page-link="true" aria-current={item === chapter ? "page" : undefined}>{item.title}</a>
            ))}
          </div>
        ))}
        <details className="docs-more" open>
          <summary>操作参考</summary>
          {docsChapters.filter(item => item.group === "操作参考").map(item => (
            <a key={item.path} href={item.path} data-storyflow-page-link="true" aria-current={item === chapter ? "page" : undefined}>{item.title}</a>
          ))}
        </details>
      </nav>
      <aside className="docs-page-toc" aria-label="本页目录">
        <p>本页目录</p>
        <nav aria-label="本页标题">
          {headings.map((heading) => (
            <a
              key={heading.id}
              href={`#${heading.id}`}
              data-level={heading.level}
              aria-current={
                activeHeading === heading.id ? "location" : undefined
              }
            >
              {heading.text}
            </a>
          ))}
        </nav>
      </aside>
      <article className="docs-page" ref={article}>
        {chapter ? <chapter.Content /> : <p>这个地址没有对应的章节。<a href="/docs/" data-storyflow-page-link="true">返回教程首页</a>。</p>}
        {chapter && <nav className="docs-pagination" aria-label="章节翻页">
          {previous ? <a rel="prev" href={previous.path} data-storyflow-page-link="true"><span>← 上一步</span><strong>{previous.title}</strong></a> : <span />}
          {next && <a rel="next" href={next.path} data-storyflow-page-link="true"><span>下一步 →</span><strong>{next.title}</strong></a>}
        </nav>}
      </article>
    </div>
  );
}

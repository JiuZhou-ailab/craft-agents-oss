// input: Public installer links and existing product walkthrough screenshots
// output: First-project tutorial and linked interface reference
// pos: Public /docs/ page, independent of landing-page presentation

import { downloadOptions } from "./downloads";

const docsImages = {
  header: "/reference-assets/docs/doc-00-header.png",
  windowMap: "/reference-assets/docs/doc-01-window-map.png",
  sourceTree: "/reference-assets/docs/doc-02-source-tree.png",
  collaboration: "/reference-assets/docs/doc-03-collaboration.png",
  initialBrief: "/reference-assets/docs/doc-05-initial-brief.png",
  chapterCheck: "/reference-assets/docs/doc-06-chapter-check.png",
  fullReview: "/reference-assets/docs/doc-07-full-review.png",
  skillMenu: "/reference-assets/docs/doc-08-skill-menu.png",
} as const;

export function DocsPage() {
  return (
    <div className="docs-layout">
      <section className="docs-hero">
        <p className="docs-kicker">Storyflow 新手教程</p>
        <h1>从一个项目，写出第一份稿件</h1>
        <p>从安装到审阅第一份稿件，跟着四步开始。已有项目，也可以用目录直接查找需要的操作。</p>
      </section>
      <nav className="docs-toc" aria-label="教程目录">
        <p>开始使用</p>
        <a href="#install">1. 安装与准备</a>
        <a href="#create-project">2. 创建项目</a>
        <a href="#first-task">3. 第一次写作</a>
        <a href="#review-changes">4. 审阅与保存</a>
        <details className="docs-more">
          <summary>操作参考</summary>
          <a href="#window-map">认识工作台</a>
          <a href="#header-tools">常用工具</a>
          <a href="#source-tree">整理项目文件</a>
          <a href="#collaboration">与助手协作</a>
          <a href="#checklist">上手检查</a>
          <a href="#initial-brief">交代创作背景</a>
          <a href="#chapter-check">检查一章正文</a>
          <a href="#full-review">使用审查技能</a>
        </details>
      </nav>
      <article className="docs-page">
        <section className="docs-summary">
          <h2>这次先完成一件小事</h2>
          <p>让助手根据你的目标写一份简报或一段正文，把结果保存在项目文件中，再检查一次改动。Skills、数据源和自动化可以等需要时再配置。</p>
        </section>

        <section className="docs-section" id="install">
          <div className="docs-section-copy">
            <p className="docs-kicker">准备</p>
            <h2>1. 安装桌面版，选择可用模型</h2>
            <p>按电脑类型选择安装包。Mac 可在系统的“关于本机”中查看芯片；macOS 需要 12.0 或更高版本。</p>
            <div className="installer-grid">
              {downloadOptions.map((option) => (
                <a download href={option.href} key={option.id}>
                  <strong>{option.label} ↓</strong><span>{option.detail}</span>
                </a>
              ))}
            </div>
            <p>打开应用后按引导完成设置。使用 Storyflow 托管模型需要登录账号；使用自己的模型服务时，在设置中配置相应连接，并在对话中选择可用模型。</p>
            <p className="docs-note">作品文件保存在本地文件夹中。使用在线模型时，请求及任务所需内容会发送给相应服务商。</p>
          </div>
        </section>

        <section className="docs-section" id="create-project">
          <div className="docs-section-copy">
            <h2>2. 创建你的作品项目</h2>
            <h3>创建项目功能怎么用</h3>
            <p>
              创建项目可以理解成给一本新作品开一个独立资料柜。系统只建立空项目，不预先创建目录或文件；项目结构由你真正创建或导入的内容决定。
            </p>
            <h3>创建时要决定什么</h3>
            <ul className="docs-inline-list">
              <li>项目名称：建议直接写作品名或暂定名，例如《女扮男装入朝后》。</li>
              <li>保存位置：决定这个项目放在哪个工作区或文件夹里，方便以后找回。</li>
            </ul>
            <h3>空项目从哪里开始</h3>
            <p>
              新项目从空白文件夹开始。你可以直接描述目标，也可以选择下面的操作。
            </p>
            <ul className="docs-inline-list">
              <li>描述目标：在对话中告诉助手题材、主角、冲突、篇幅和禁区。</li>
              <li>导入已有内容：选择 Markdown 或 TXT 文件；同名文件会跳过，不会覆盖。</li>
              <li>新建文件：从一个真实文件开始，按需要逐步形成目录。</li>
              <li>使用 Skill：为当前任务选择可复用的写作方法，也可以稍后再添加。</li>
            </ul>
            <details className="docs-more">
              <summary>想继续规划整本作品？</summary>
              <p>没有旧稿时，建议先描述项目；已有材料时，直接导入文件。随后按真实工作需要逐步沉淀：</p>
              <ul className="docs-inline-list">
                <li>先填简报：题材、主角、核心钩子、篇幅、禁区。</li>
                <li>再推大纲：每章钩子、冲突、反转、情绪落点。</li>
                <li>再补人物和素材：动机、秘密、关系变化、可复用设定。</li>
                <li>最后写正文：每章一个文件，把正式内容沉淀到正文区。</li>
              </ul>
              <p>如果作者只是想临时问一个问题，可以继续用聊天；如果要认真推进一篇作品，就应该创建项目。</p>
            <ul className="docs-bullet-list">
              <li>把选题信息丢给助手，让助手先追问会影响大纲的关键问题。</li>
              <li>确认题材、人设、篇幅、读者期待和禁区。</li>
              <li>让助手先填简报，再推大纲，不要一上来直接写正文。</li>
              <li>大纲确认后，逐章写正文，每章一个文件。</li>
              <li>每次改动都回到对应文件里沉淀，不只留在聊天里。</li>
            </ul>
            </details>
          </div>
        </section>

        <section className="docs-section" id="first-task">
          <div className="docs-section-copy">
            <p className="docs-kicker">第一次任务</p>
            <h2>3. 先讨论方向，再写一份文件</h2>
            <p>在项目对话中说明这次的目标。可以从下面的示例开始，把题材、人物和限制换成自己的内容。</p>
            <blockquote className="prompt-example">我想写一个悬疑短篇：主角是一名修复旧照片的店主，在一张合照中发现了不该出现的人。先帮我讨论主角动机和核心冲突，列出需要我决定的问题，暂时不要修改文件。</blockquote>
            <p>如果只想分析，可使用探索模式。确认方向后，切换到允许写入的模式，再明确要求把结果保存到项目里。</p>
            <blockquote className="prompt-example">根据刚才确认的方向，在项目中新建<code>故事简报.md</code>，写下主角、核心冲突、预期篇幅和待定问题。先只完成简报，不写正文。</blockquote>
            <p className="docs-note">完成信号：项目目录出现<code>故事简报.md</code>，打开后能看到内容。若结果只在聊天里，继续要求助手保存到文件；已有稿件则可以用 @ 引用对应文件，再说明具体修改范围。</p>
          </div>
        </section>

        <section className="docs-section" id="review-changes">
          <div className="docs-section-copy">
            <p className="docs-kicker">检查结果</p>
            <h2>4. 审阅改动，保存一个版本</h2>
            <p>Agent 写入后，打开文件改动审阅，检查新增和删除的内容。满意的改动选择接受；不想保留的改动选择拒绝，或在对话中说明需要调整的地方。</p>
            <p className="docs-note">审阅的是已经写入文件的改动。接受表示保留，拒绝会尝试撤回；如果文件出现冲突，先核对内容，再继续处理。</p>
            <p>打开“版本管理”，点击“保存当前版本”旁的“保存”，确认历史列表中出现新记录。继续写作时先完成一个章节，再检查人物、设定和情节；需要恢复时，先核对版本记录的时间和说明。</p>
          </div>
          <figure className="docs-figure">
            <img width={2338} height={1976} loading="lazy" src="/reference-assets/storyflow-review-diff.png" alt="Storyflow 文件改动审阅中的接受与拒绝操作" />
            <figcaption>查看具体增删，再决定保留哪些内容。</figcaption>
          </figure>
        </section>

        <div className="docs-reference-heading">
          <p className="docs-kicker">操作参考</p>
          <h2>需要时，再认识这些工具</h2>
          <p>下面保留已有项目的界面示例。截图中的目录和内容由该项目创建，不是每个新项目的默认结构；布局以当前应用为准。</p>
        </div>

        <section className="docs-section" id="header-tools">
          <div className="docs-section-copy">
            <h2>常用工具在哪里</h2>
          </div>
          <figure className="docs-figure docs-figure-wide">
            <img width={3700} height={940} loading="lazy" src={docsImages.header} alt="真实截图：Header 功能区" />
            <figcaption>图 0：Header 功能区</figcaption>
          </figure>
          <ul className="docs-bullet-list">
            <li>
              <strong>项目切换：</strong>从一本书切到另一本书。
            </li>
            <li>
              <strong>数据源：</strong>接入资料、文件夹、外部服务，适合挂参考资料和素材库。
            </li>
            <li>
              <strong>技能：</strong>给助手加载专门工作方法，例如写作法、拆文法、审校法。
            </li>
            <li>
              <strong>自动化：</strong>让任务按规则自动运行，适合定时检查和持续跟进。
            </li>
            <li>
              <strong>设置：</strong>模型、权限和应用设置。
            </li>
            <li>
              <strong>版本管理：</strong>保存、查看、恢复写作版本，相当于作品的时间机器。
            </li>
          </ul>
        </section>

        <section className="docs-section" id="window-map">
          <div className="docs-section-copy">
            <h2>认识工作台</h2>
          </div>
          <figure className="docs-figure docs-figure-wide">
            <img width={3870} height={2536} loading="lazy" src={docsImages.windowMap} alt="真实截图：整体框选" />
            <figcaption>图 1：整体框选</figcaption>
          </figure>
          <ul className="docs-bullet-list">
            <li>
              <strong>资料目录：</strong>一本书的分区书架。正文、大纲、角色、风格、素材分开放，避免所有信息混在聊天记录里。
            </li>
            <li>
              <strong>正文 / 文档区：</strong>正在编辑的作品文件。截图里打开的是第一章正文，它会被保存成作品资产。
            </li>
            <li>
              <strong>助手协作区：</strong>助手检查章节是否和大纲 beat 对齐，也可以继续写下一章、重写、扩写或改方向。
            </li>
            <li>
              <strong>输入区：</strong>作者给助手下一步任务，例如继续、重写、加强冲突、改成更爽。
            </li>
          </ul>
        </section>

        <section className="docs-section" id="source-tree">
          <div className="docs-section-copy">
            <h2>按你的习惯整理项目文件</h2>
            <p>项目目录显示真实文件。下面是一种整理方式，你可以按自己的作品调整。</p>
          </div>
          <figure className="docs-figure docs-figure-contain">
            <img width={1460} height={2260} loading="lazy" src={docsImages.sourceTree} alt="真实截图：资料树框选" />
            <figcaption>图 2：资料树框选</figcaption>
          </figure>
          <ul className="docs-bullet-list">
            <li>
              <strong>全局信息：</strong>放大纲、人物、地点、风格、时间线、状态、素材等长期资料。
            </li>
            <li>
              <strong>正文：</strong>只放真正会给读者看的章节。
            </li>
            <li>
              <strong>当前章节：</strong>正在编辑的具体正文文件。
            </li>
          </ul>
        </section>

        <section className="docs-section" id="collaboration">
          <div className="docs-section-copy">
            <h2>和助手讨论下一步</h2>
          </div>
          <figure className="docs-figure docs-figure-wide">
            <img width={3060} height={2220} loading="lazy" src={docsImages.collaboration} alt="真实截图：写作协作区框选" />
            <figcaption>图 3：写作协作区框选</figcaption>
          </figure>
          <ul className="docs-bullet-list">
            <li>
              <strong>作品草稿：</strong>沉淀正文和修改痕迹。
            </li>
            <li>
              <strong>助手反馈：</strong>检查章节钩子、主要事件、信息差、情绪落点等 beat 是否对齐。
            </li>
            <li>
              <strong>下一步：</strong>作者像和编辑沟通一样，要求继续写、重写、调整节奏或加强某条线。
            </li>
          </ul>
        </section>

        <section className="docs-section docs-checklist" id="checklist">
          <div className="docs-section-copy">
            <h2>判断是否用对了</h2>
          </div>
          <ul className="docs-bullet-list">
            <li>能在项目目录中找到刚创建的文件，打开后有完整内容。</li>
            <li>知道如何引用已有文件，并说明这次需要助手处理的范围。</li>
            <li>已经检查过一次改动，并知道从哪里查看版本历史。</li>
          </ul>
        </section>

        <section className="docs-section" id="initial-brief">
          <div className="docs-section-copy">
            <h2>交代创作背景</h2>
            <p>主要就是题材，人设，核心梗，金手指之类的。</p>
          </div>
          <figure className="docs-figure docs-figure-wide">
            <img width={1280} height={888} loading="lazy" src={docsImages.initialBrief} alt="真实截图：初始信息和关键问题确认" />
            <figcaption>初始给出的信息越明确越好</figcaption>
          </figure>
        </section>

        <section className="docs-section" id="chapter-check">
          <div className="docs-section-copy">
            <h2>检查一章正文</h2>
            <p>先检查一个章节的人物动机、情节因果和前文衔接，确认后再继续下一章，便于及时调整方向。</p>
          </div>
          <figure className="docs-figure docs-figure-wide">
            <img width={1280} height={888} loading="lazy" src={docsImages.chapterCheck} alt="真实截图：一章写完后进行检查" />
            <figcaption>一章写完后进行检查</figcaption>
          </figure>
        </section>

        <section className="docs-section" id="full-review">
          <div className="docs-section-copy">
            <h2>使用技能审查全文</h2>
            <p>
              写完后让 Agent 审查一遍全文，查看哪里有逻辑上的问题和错误。你可以自定义自己的技能，告诉 Agent 后它会帮你写，比如小说审查。
            </p>
          </div>
          <figure className="docs-figure docs-figure-wide">
            <img width={1280} height={888} loading="lazy" src={docsImages.fullReview} alt="真实截图：小说审查技能" />
            <figcaption>写完后让 Agent 审查一遍全文</figcaption>
          </figure>
          <div className="docs-section-copy docs-subsection">
            <p>然后在对话框中打出 “/” 字符后就可以看到你定义的技能了。</p>
          </div>
          <figure className="docs-figure docs-figure-contain">
            <img width={897} height={1280} loading="lazy" src={docsImages.skillMenu} alt="真实截图：对话框中输入斜杠查看技能" />
            <figcaption>在对话框中打出 “/” 字符后可以看到你定义的技能</figcaption>
          </figure>
        </section>
      </article>
    </div>
  );
}

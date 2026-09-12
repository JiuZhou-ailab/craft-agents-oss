// input: Shared download links and native product captures
// output: Tutorial chapters with stable routes, legacy anchors and preserved exercise content
// pos: Single chapter catalog for tutorial rendering and navigation

import { useState } from "react";
import { downloadOptions } from "./downloads";
import { ProductTour } from "./ProductTour";

const practicePrompts = {
  brief: `请在当前项目中新建“创作要求.md”，保存以下要求：
主角：苏白，一位科学主播。
场景：晚上八点十分，他在出租屋开播，直播间只有 37 位观众。
事件：桌上有一颗黑色金属球，附近的螺丝开始向它移动。
风格：对白自然，用动作制造悬念，先不解释异常原因。
本次目标：只写约 300 字的开场，不写整章。
先只保存这些要求，不写正文。完成后告诉我文件位置，并给出可点击的文件链接。`,
  opening: `请先阅读当前项目的“创作要求.md”，按要求写约 300 字的直播开场。
新建“第01章.md”保存正文，不要改动创作要求，也不要提前解释金属球的来历。
完成后给出“第01章.md”的文件链接。`,
  revision: `请只修改“第01章.md”中的这一句：
“粘贴原句”
把它改得更有画面感，用动作表现异常，不直接解释原因。
其他段落保持原样。请把修改写入原文件，完成后说明改了哪里。`,
  save: `请把刚才已经写好的开场保存到当前项目的“第01章.md”，不要重新改写。
如果同名文件已经存在，先读取并告诉我内容是否一致，不要直接覆盖。
完成后告诉我实际保存路径，并给出可点击的文件链接。`,
};

function PromptExample({ title, text }: { title: string; text: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("已复制，切回 Storyflow 粘贴到输入框。");
    } catch {
      setStatus("未能复制，请选中下方文字手动复制。");
    }
  }
  return (
    <div className="prompt-example">
      <div className="prompt-heading">
        <strong>{title}</strong>
        <button type="button" onClick={copy} aria-label={`复制：${title}`}>复制指令</button>
      </div>
      <pre>{text}</pre>
      <p className="prompt-status" role="status">{status || "复制后粘贴到桌面应用；本页不会发送任务。"}</p>
    </div>
  );
}

export const docsChapters = [
  {
    path: "/docs/",
    title: "从这里开始",
    group: "开始使用",
    anchors: ["overview-title"],
    Content: () => (<>
<section className="docs-summary">
          <h2 id="overview-title">这次先完成一件小事</h2>
          <p>写一段约 300 字的悬疑开场，改好其中一句，保存到电脑上。练习结束时，你会有两个文件：<code>创作要求.md</code> 和 <code>第01章.md</code>。</p>
          <p>先照着示例做一遍，熟悉后再换成自己的故事。不需要先安装技能，也不用先做整本书的大纲。</p>
          <a className="docs-next" href="/docs/install/#install" data-storyflow-page-link="true">从安装开始 →</a>
          <a className="docs-next" href="/docs/create-project/#create-project" data-storyflow-page-link="true">已经能正常对话？从项目开始 →</a>
        </section>
    </>),
  },
  {
    path: "/docs/install/",
    title: "1. 安装与准备",
    group: "开始使用",
    anchors: ["install", "install-title", "choose-installer"],
    Content: () => (<>
<section className="docs-section" id="install">
          <div className="docs-section-copy">
            <p className="docs-kicker">第 1 步 · 先让助手能回复你</p>
            <h2 id="install-title">安装并连接模型</h2>
            <p>这里是教程网页。下面的写作操作要在安装后的 Storyflow 桌面应用里完成。</p>
            <h3 id="choose-installer">选择安装包</h3>
            <p>Mac：点屏幕左上角苹果菜单，打开“关于本机”。芯片是 Apple M 系列就选 Apple Silicon，处理器是 Intel 就选 Intel Mac。Windows 电脑选择 Windows 版。</p>
            <div className="installer-grid">
              {downloadOptions.map((option) => (
                <a download href={option.href} key={option.id}>
                  <strong>{option.label} ↓</strong>
                  <span>{option.detail}</span>
                </a>
              ))}
            </div>
            <ol className="docs-steps">
              <li>打开下载的安装包。Mac 将 Storyflow 拖到“应用程序”，再从那里打开；Windows 按安装窗口提示完成安装。</li>
              <li>在应用左下角点头像或“本地用户”，选择“个人资料”。使用 Storyflow 托管模型时，在这里登录；没有账号时，使用页面提供的注册入口。若页面要求邮箱验证，完成验证后再继续。</li>
              <li>回到主界面，点击左侧“新建任务”，再点输入框下方右侧的模型名称，选择账号可用的模型。模型就是替你阅读和写作的 AI。</li>
              <li>在输入框里输入“你好，请回复：可以开始写作了”，点击发送按钮。收到回复后，再做下一步。</li>
            </ol>
            <p className="docs-checkpoint"><strong>完成标志</strong>收到一条正常回复，而不是“不可用”、登录提醒或连接错误。遇到问题先看<a href="/docs/troubleshooting/#help-model" data-storyflow-page-link="true">模型无法使用</a>。</p>
            <details className="docs-more">
              <summary>我已经有自己的模型服务</summary>
              <p>从左下角用户菜单打开“设置”，进入“AI”，点击“+ 添加连接”，按服务商提供的信息完成配置，再回到对话选择这个连接和模型。不要把服务商的 API Key 当作 Storyflow 登录密码填写。</p>
            </details>
            <p className="docs-note">作品文件放在你选择的本地文件夹里。使用在线模型时，任务需要的文字和资料会发送给对应服务。</p>
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/create-project/",
    title: "2. 创建项目",
    group: "开始使用",
    anchors: ["create-project", "create-project-title", "project-how", "project-options", "project-start"],
    Content: () => (<>
<section className="docs-section" id="create-project">
          <div className="docs-section-copy">
            <p className="docs-kicker">第 2 步 · 给文件找一个固定位置</p>
            <h2 id="create-project-title">创建你的作品项目</h2>
            <h3 id="project-how">一个项目就是一个作品文件夹</h3>
            <p>对话用来交代任务和讨论，文件用来保存稿件。先建一个练习项目，后面的两份文件都放在这里。</p>
            <h3 id="project-options">选择文件夹</h3>
            <ol className="docs-steps">
              <li>先在电脑的“文稿”或“文档”中，新建一个空文件夹，命名为“黑洞直播”。</li>
              <li>回到 Storyflow，把鼠标移到左侧“项目”标题上，点击右边的“添加本地项目”图标。</li>
              <li>在弹出的系统窗口中，选中刚建好的“黑洞直播”文件夹并确认。</li>
              <li>查看左侧项目列表，确认当前打开的是“黑洞直播”。项目名称来自文件夹名称，不需要再填写一张创建表单。</li>
            </ol>
            <h3 id="project-start">看到空白页面是正常的</h3>
            <p>新项目不会自动生成大纲、人物或正文。看到“从哪里开始？”以及“新建文件”“导入已有内容”等入口，说明可以开始了。本次练习直接在对话里发任务。</p>
            <p className="docs-checkpoint"><strong>完成标志</strong>左侧能找到“黑洞直播”，并且正在这个项目中操作。若你在“自由对话”里，先点回项目。</p>
            <details className="docs-more">
              <summary>我已经有旧稿，怎么开始？</summary>
              <p>可以直接把已有稿件所在的文件夹添加为项目。也可以先建空文件夹，再点“导入已有内容”选择 Markdown 或 TXT 文件；同名文件会跳过。第一次练习建议使用单独的空文件夹。</p>
            </details>
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/first-task/",
    title: "3. 第一次写作",
    group: "开始使用",
    anchors: ["first-task", "first-task-title", "write-brief", "write-opening"],
    Content: () => (<>
<section className="docs-section" id="first-task">
          <div className="docs-section-copy">
            <p className="docs-kicker">第 3 步 · 在同一段对话里完成两次任务</p>
            <h2 id="first-task-title">先存创作要求，再写开场</h2>
            <ol className="docs-steps">
              <li>选中“黑洞直播”项目，点击左侧“新建任务”。发送前确认对话属于这个项目。</li>
              <li>在输入框下方左侧，点击当前运行模式，选择“询问运行”。这个模式允许写文件，修改前会先询问你。</li>
              <li>复制下面的指令，粘贴到应用输入框，点击发送。若出现操作确认，核对要写入的文件名后允许本次操作。</li>
            </ol>
            <h3 id="write-brief">先保存一份创作要求</h3>
            <PromptExample title="保存创作要求" text={practicePrompts.brief} />
            <p>等待助手完成。如果它提出问题，直接在同一对话里回答；如果已经生成文件，就点击回复中的 <code>创作要求.md</code> 链接打开它。</p>
            <p className="docs-checkpoint"><strong>完成标志</strong>文档区打开了 <code>创作要求.md</code>，里面能看到主角、直播场景和篇幅要求。只有聊天回复，还不算保存完成。</p>
            <h3 id="write-opening">接着写约 300 字的正文</h3>
            <p>继续在刚才的对话中发送第二条指令。<code>.md</code> 是文本文件的扩展名，可以直接在 Storyflow 里阅读，不需要学习 Markdown 语法。</p>
            <PromptExample title="写第一段开场" text={practicePrompts.opening} />
            <ol className="docs-steps">
              <li>等任务完成，点击回复中的 <code>第01章.md</code>，在文档区阅读正文。</li>
              <li>再从项目文件目录里找到并打开它，确认这份稿件属于当前项目。</li>
              <li>读一遍，挑一句你想改的地方。下一步只改这一句。</li>
            </ol>
            <p className="docs-checkpoint"><strong>完成标志</strong>能打开两份文件：创作要求和第一章正文。找不到文件时，按<a href="/docs/troubleshooting/#help-file" data-storyflow-page-link="true">文件没有出现</a>处理。</p>
          </div>
          <div className="docs-tour">
            <ProductTour steps={["workspace", "context"]} label="对话与文件位置示意" detail />
          </div>
          <p className="docs-caption">看位置即可：对话中的文件链接可以打开右侧文档。图中是已有示例项目，你生成的文字和文件数量会不同。可以点击“查看全貌”或打开“原图”。</p>
        </section>
    </>),
  },
  {
    path: "/docs/review-changes/",
    title: "4. 修改与审阅",
    group: "开始使用",
    anchors: ["review-changes", "review-changes-title"],
    Content: () => (<>
<section className="docs-section" id="review-changes">
          <div className="docs-section-copy">
            <p className="docs-kicker">第 4 步 · 把修改范围说小一点</p>
            <h2 id="review-changes-title">修改一句，并检查改动</h2>
            <ol className="docs-steps">
              <li>在输入框输入 <code>@</code>，搜索 <code>第01章.md</code>，点击匹配的文件，把这份正文带入当前任务。</li>
              <li>从正文复制一句你想修改的原文，替换下面的“粘贴原句”，再把整条指令粘贴到输入框发送。</li>
              <li>写入完成后，点击这轮回复下方的文件改动摘要，打开对应文件的审阅。</li>
            </ol>
            <PromptExample title="只修改一句" text={practicePrompts.revision} />
            <p>审阅里会显示新增和删除的文字。先检查是否只动了指定句子，再决定保留还是撤回。</p>
            <ul className="docs-inline-list">
              <li><strong>Accept（接受）：</strong>保留这次改动。</li>
              <li><strong>Reject（拒绝）：</strong>尝试撤回这次改动。遇到冲突提示时，先打开文件核对，不要反复点击。</li>
              <li><strong>方向还不对：</strong>在对话里指出问题，例如“这句太夸张，改得克制一些”。</li>
            </ul>
            <p className="docs-note">助手的改动已经写入文件，审阅用来决定是否保留。如果你只想先看建议，在发送前选择“只读探索”，确认后再切回“询问运行”。</p>
            <p className="docs-checkpoint"><strong>完成标志</strong>回到 <code>第01章.md</code>，能找到自己决定保留的句子，并确认其他段落没有被误改。</p>
          </div>
          <div className="docs-tour">
            <ProductTour steps={["review"]} label="文件改动审阅示意" detail />
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/save-return/",
    title: "5. 保存与继续",
    group: "开始使用",
    anchors: ["save-return", "save-return-title"],
    Content: () => (<>
<section className="docs-section" id="save-return">
          <div className="docs-section-copy">
            <p className="docs-kicker">第 5 步 · 下次还能接着写</p>
            <h2 id="save-return-title">保存版本，再打开一次</h2>
            <ol className="docs-steps">
              <li>打开正文，点击文档工具栏右端的“版本管理”。</li>
              <li>在“保存当前版本”这一行点击“保存”，等历史列表出现记录。若提示“没有新的改动需要保存”，说明当前没有新变化，查看已有记录即可。</li>
              <li>关闭文档标签，再从项目目录打开 <code>第01章.md</code>，确认刚才的修改还在。</li>
              <li>下次启动 Storyflow，点左侧“黑洞直播”项目，再打开文件继续写。需要延续讨论时，展开项目，选择原来的对话。</li>
            </ol>
            <p className="docs-note">版本记录保存的是当前项目的状态。“恢复”会影响项目文件，先保存现在的版本，再核对目标记录的时间和说明。这次练习不需要执行恢复。</p>
            <p className="docs-checkpoint"><strong>完成标志</strong>重新打开的文件仍有修改后的内容，版本列表中也有可识别的记录。你已经完成了一次写作、修改和留存。</p>
          </div>
          <div className="docs-tour">
            <ProductTour steps={["history"]} label="保存版本的位置示意" detail />
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/checklist/",
    title: "检查是否学会",
    group: "开始使用",
    anchors: ["checklist", "checklist-title"],
    Content: () => (<>
<section className="docs-section docs-checklist" id="checklist">
          <div className="docs-section-copy">
            <h2 id="checklist-title">离开教程前，自己试一次</h2>
            <p>不看上面的步骤，试着完成这四件事。哪一步做不到，就点对应链接回看。</p>
            <ul className="docs-inline-list">
              <li><a href="/docs/create-project/#create-project" data-storyflow-page-link="true">找到练习项目</a>，说出文件保存在电脑的哪个文件夹。</li>
              <li><a href="/docs/first-task/#write-opening" data-storyflow-page-link="true">打开第一章</a>，区分聊天里的回答和已经保存的稿件。</li>
              <li><a href="/docs/review-changes/#review-changes" data-storyflow-page-link="true">引用一个文件</a>，让助手只改指定的一句话，再核对结果。</li>
              <li><a href="/docs/save-return/#save-return" data-storyflow-page-link="true">保存并重新打开</a>，确认修改没有丢失。</li>
            </ul>
            <p>完成后，可以把同样的方法用于自己的故事：先交代要求，再写一小段，检查后再继续下一段。</p>
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/troubleshooting/",
    title: "常见问题",
    group: "遇到问题",
    anchors: ["troubleshooting", "troubleshooting-title", "help-model", "help-file", "help-review", "help-project", "tutorial-contact"],
    Content: () => (<>
<section className="docs-section" id="troubleshooting">
          <div className="docs-section-copy">
            <h2 id="troubleshooting-title">卡住时，按现象查找</h2>
            <h3 id="help-model">模型不可用，或发送后没有正常回复</h3>
            <p>先看输入框下方是否选中了模型。使用托管模型时，到“个人资料”确认已登录；提示登录失效时重新登录。使用自己的连接时，到“设置 → AI”核对连接配置。若仍有错误，保留错误文字再<a href="/docs/troubleshooting/#tutorial-contact" data-storyflow-page-link="true">联系我们</a>，不要把不停点发送当作修复。</p>
            <h3 id="help-file">回复里有内容，项目里却没有文件</h3>
            <p>确认当前在“黑洞直播”项目中，并且运行模式是“询问运行”。如果还在“只读探索”，先切换模式；如果操作在等待确认，先核对并处理确认请求。</p>
            <PromptExample title="把已有结果保存到文件" text={practicePrompts.save} />
            <p>随后点击回复中的文件链接。如果文件在其他位置，要求助手说明实际保存路径，再与所选项目文件夹核对。</p>
            <h3 id="help-review">找不到改动摘要或版本按钮</h3>
            <p>先确认这轮任务确实修改了一个文件。如果只是回复建议，按第 4 步明确要求写入。版本管理在打开文档后的工具栏里，不在聊天发送按钮旁边。界面较窄时，先把应用窗口放大。</p>
            <h3 id="help-project">重开后找不到项目或正文</h3>
            <p>先在左侧展开“项目”，再选择原来的项目。如果移动了电脑上的作品文件夹，在项目菜单中重新关联实际位置。不要为了找回文件重复创建同名空文件夹。</p>
            <h3 id="tutorial-contact">还是卡住了</h3>
            <p>飞书联系 <strong>派大星</strong>，或发邮件到 <a href="mailto:zjdding@gmail.com">zjdding@gmail.com</a>。请说明电脑系统、正在做第几步、点击了什么，以及完整错误提示；附一张相关界面截图会更容易定位问题。</p>
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/workspace/",
    title: "工作台与文件",
    group: "操作参考",
    anchors: ["reference-title", "window-map", "window-map-title", "header-tools", "header-tools-title", "source-tree", "source-tree-title"],
    Content: () => (<>
<div className="docs-reference-heading">
          <p className="docs-kicker">操作参考</p>
          <h2 id="reference-title">熟悉工作台与文件</h2>
          <p>这一页介绍工作台和文件目录。协作方法与技能用法可以从左侧“操作参考”进入。教程实拍来自示例项目，标注不是应用里的按钮。</p>
        </div>
<section className="docs-section" id="window-map">
          <div className="docs-section-copy">
            <h2 id="window-map-title">认识工作台</h2>
            <ul className="docs-inline-list">
              <li><strong>左侧导航：</strong>选择项目和对话，打开技能、数据源或设置。</li>
              <li><strong>对话区：</strong>交代任务、回答问题，查看助手执行结果和文件链接。</li>
              <li><strong>文档区：</strong>打开文件，阅读正文和检查修改。</li>
              <li><strong>项目目录：</strong>查找当前项目中的真实文件，关闭文档后也能从这里找回。</li>
            </ul>
            <a href="/docs/first-task/#first-task" data-storyflow-page-link="true">回到界面示意图 ↑</a>
          </div>
        </section>
<section className="docs-section" id="header-tools">
          <div className="docs-section-copy">
            <h2 id="header-tools-title">常用工具在哪里</h2>
            <p>左侧的“技能”存放可重复使用的工作方法，“数据源”连接任务需要的资料，“定时任务”安排以后运行的任务。刚入门时，先使用项目文件和普通对话就够了。设置在左下角的用户菜单里。</p>
          </div>
        </section>
<section className="docs-section" id="source-tree">
          <div className="docs-section-copy">
            <h2 id="source-tree-title">按你的习惯整理项目文件</h2>
            <p>故事变长后，可以逐步增加“大纲.md”“人物.md”，正文按章节分文件。告诉助手“先读人物设定，只修改第 2 章”，比让它一次重写全部文件更容易检查。目录名称由你决定，应用不会要求一套固定模板。</p>
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/collaboration/",
    title: "与助手协作",
    group: "操作参考",
    anchors: ["collaboration", "collaboration-title", "initial-brief", "initial-brief-title", "chapter-check", "chapter-check-title"],
    Content: () => (<>
<section className="docs-section" id="collaboration">
          <div className="docs-section-copy">
            <h2 id="collaboration-title">怎样让助手少走弯路</h2>
            <p>一次任务说清四件事：读哪份资料、做什么、不要改什么、结果放哪里。例如：“阅读人物.md，检查第02章.md 的人物动机，只列出有原文依据的问题，先不要修改文件。”</p>
          </div>
        </section>
<section className="docs-section" id="initial-brief">
          <div className="docs-section-copy">
            <h2 id="initial-brief-title">把练习换成自己的故事</h2>
            <p>把示例里的主角、场景、冲突和篇幅替换为你的设定。还没想清楚时，可以先发：“我想写一个［题材］故事，主角是［身份］，目前只确定了［想法］。请先问我 3 个会影响开场的问题，暂时不要写正文。”回答后再保存创作要求。</p>
          </div>
        </section>
<section className="docs-section" id="chapter-check">
          <div className="docs-section-copy">
            <h2 id="chapter-check-title">检查一章正文</h2>
            <p>用 <code>@</code> 引用章节和人物设定，选择“只读探索”，要求助手“引用原句，检查人物动机、情节因果和前文衔接”。先看问题是否成立，选中要改的部分，再切回“询问运行”执行。</p>
          </div>
        </section>
    </>),
  },
  {
    path: "/docs/skills/",
    title: "使用技能",
    group: "操作参考",
    anchors: ["full-review", "full-review-title"],
    Content: () => (<>
<section className="docs-section" id="full-review">
          <div className="docs-section-copy">
            <h2 id="full-review-title">什么时候需要技能</h2>
            <p>技能（Skill）是一份可重复使用的工作说明。例如，每次审查章节都按同样的标准检查人物动机和叙事节奏，就可以使用审查技能。它是可选项，普通写作任务不必先安装技能。</p>
            <ol className="docs-steps">
              <li>从左侧打开“技能”，查看已有技能的说明，确认它适合当前任务。</li>
              <li>点击输入区的加号，移到“选择技能”，搜索并选择已安装的技能。</li>
              <li>补充要处理的文件和范围，再发送任务。选了技能仍然需要说明这次要做什么。</li>
            </ol>
          </div>
          <div className="docs-tour">
            <ProductTour steps={["add-menu"]} label="选择技能的位置示意" detail />
          </div>
        </section>
    </>),
  },
 ];

export function findDocsChapter(pathname: string) {
  return docsChapters.find(chapter => chapter.path.replace(/\/$/, "") === pathname.replace(/\/$/, ""));
}

// Keep previously shared /docs/#section URLs useful after chapter separation.
export function resolveLegacyDocsTarget(target: { pathname: string; hash: string }) {
  if (target.pathname.replace(/\/$/, "") !== "/docs" || !target.hash) return target;
  let anchor: string;
  try {
    anchor = decodeURIComponent(target.hash.slice(1));
  } catch {
    return target;
  }
  const chapter = docsChapters.find(chapter => chapter.anchors.includes(anchor));
  return chapter ? { ...target, pathname: chapter.path } : target;
}

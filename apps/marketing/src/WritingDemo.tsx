// input: Curated sample text and existing Storyflow product captures
// output: Readable, local writing demonstration with goal, draft, and review states
// pos: Marketing-only demonstration; never reads or writes a real Project

import { useId, useState } from "react";
import "./writing-demo.css";

const stages = ["创作目标", "正文成果", "改动审阅"] as const;
const chapter = [
  "“兄弟们，今天给大家做一个很简单的物理小实验。”",
  "晚上八点十七分，苏白准时开播。",
  "镜头里是一间不足二十平的出租屋。二手电脑、二手电容麦、发黄台灯，还有桌上一个核桃拳头大的黑色金属球。",
  "直播间人数：37。",
  "弹幕稀稀拉拉。",
  "【来了，苏老师今天又带大家科学认知世界了。】",
  "【上次说手捏核聚变，这次准备捏什么？】",
  "苏白扫了眼弹幕，神色平静。",
  "他把黑色金属球推到镜头前。",
  "“先说明，这不是玩具，也不是模型。”",
  "“这是我自制的第一代微型重力井发生器。”",
];

export function ReviewExcerpt() {
  const [decision, setDecision] = useState<"accepted" | "rejected" | null>(
    null,
  );
  return (
    <div className="demo-review">
      <div className="demo-file-label">01-主播你刚才说什么，黑洞？.md</div>
      <p>苏白扫了眼弹幕，神色平静。</p>
      {decision !== "accepted" && <del>他把黑色金属球推到镜头前。</del>}
      {decision !== "rejected" && (
        <ins>
          他把黑色金属球推到镜头前。桌上的螺丝轻轻一颤，向球体滑了一寸。
        </ins>
      )}
      <p>“先说明，这不是玩具，也不是模型。”</p>
      <div className="demo-review-actions">
        {decision === null ? (
          <>
            <button type="button" onClick={() => setDecision("rejected")}>
              拒绝改动
            </button>
            <button type="button" onClick={() => setDecision("accepted")}>
              接受改动
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setDecision(null)}>
            重新审阅
          </button>
        )}
      </div>
      <p className="demo-status" role="status">
        {decision === "accepted"
          ? "演示：已保留这处改动。"
          : decision === "rejected"
            ? "演示：已恢复原文。"
            : "示例改动，仅供体验审阅。"}
      </p>
    </div>
  );
}

export function WritingDemo({ label = "写作演示" }: { label?: string }) {
  const [stage, setStage] = useState<(typeof stages)[number]>("正文成果");
  const panelId = useId();
  return (
    <section className="writing-demo" aria-label={label}>
      <div className="demo-titlebar">
        <span className="demo-dots" aria-hidden="true">
          ● ● ●
        </span>
        <span>Storyflow</span>
        <span>示例项目</span>
      </div>
      <div className="demo-tabs" role="group" aria-label="选择演示阶段">
        {stages.map((item, index) => (
          <button
            type="button"
            key={item}
            aria-pressed={stage === item}
            aria-controls={panelId}
            onClick={() => setStage(item)}
          >
            <span aria-hidden="true">0{index + 1}</span>
            {item}
          </button>
        ))}
      </div>
      <div className="demo-workspace" id={panelId}>
        <aside className="demo-conversation">
          <div className="demo-file-label">第一章 · 黑洞直播</div>
          <p className="demo-request">
            写一个直播开场。让读者跟着主角一起发现黑洞，先有异常，再揭示原因。
          </p>
          <div className="demo-response">
            <p>先把这一章的悬念落在具体场景里。</p>
            <ul>
              <li>主角：平静的科学主播</li>
              <li>场景：只有 37 人的直播间</li>
              <li>钩子：一颗黑色金属球</li>
            </ul>
            <p className="demo-completed">✓ 正文已呈现于右侧</p>
            <span className="demo-file-chip">▤ 正文 / 第 01 章.md</span>
          </div>
          <p className="demo-disclosure">
            示例内容演示。新建项目从空白文件夹开始。
          </p>
        </aside>
        <div className="demo-document" aria-label={stage}>
          <div className="demo-file-label">
            {stage === "创作目标"
              ? "创作要求.md"
              : stage === "改动审阅"
                ? "检查正文改动"
                : "第 01 章.md"}
          </div>
          <div className="demo-paper">
            {stage === "创作目标" ? (
              <>
                <h3>第一章的创作目标</h3>
                <p>让一场平常的直播，出现一件无法解释的事。</p>
                <h4>人物与场景</h4>
                <p>
                  苏白，一位科学主播。出租屋、二手设备、稀疏的弹幕，和桌上的黑色金属球。
                </p>
                <h4>这一章要做到</h4>
                <ul>
                  <li>用弹幕建立读者熟悉的日常。</li>
                  <li>让异常通过具体动作发生。</li>
                  <li>把解释留给下一段。</li>
                </ul>
                <h4>语气要求</h4>
                <p>对白自然，叙述克制，不提前替读者解释悬念。</p>
              </>
            ) : stage === "改动审阅" ? (
              <ReviewExcerpt />
            ) : (
              <>
                <h3>第 01 章 主播你刚才说什么，黑洞？</h3>
                {chapter.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="demo-bottom">
        <span>内容演示 · 不会修改你的文件</span>
        <a
          href="/reference-assets/storyflow-editor.webp"
          target="_blank"
          rel="noreferrer"
        >
          查看真实界面 ↗
        </a>
      </div>
    </section>
  );
}

const projectFiles = {
  "创作要求.md": {
    title: "创作要求",
    paragraphs: [
      "第一章：黑洞直播。",
      "主角在出租屋开播，向 37 位观众展示一个黑色金属球。",
      "语气要求：对白自然，叙述克制。通过具体动作制造悬念，不提前解释异常。",
    ],
  },
  "人物.md": {
    title: "苏白",
    paragraphs: [
      "身份：科学主播。",
      "面对直播间的质疑，他没有急于证明自己，而是把金属球推向镜头。",
      "人物动机：让观众亲眼看到实验发生。",
    ],
  },
  "第 01 章.md": {
    title: "第 01 章 主播你刚才说什么，黑洞？",
    paragraphs: chapter,
  },
} as const;

export function ProjectDemo() {
  const [file, setFile] = useState<keyof typeof projectFiles>("创作要求.md");
  const documentId = useId();
  return (
    <section className="writing-demo project-demo" aria-label="项目文件演示">
      <div className="demo-titlebar">
        <span className="demo-dots" aria-hidden="true">
          ● ● ●
        </span>
        <span>Storyflow</span>
        <span>示例项目</span>
      </div>
      <div className="project-files" role="group" aria-label="选择项目文件">
        <span>⌄ 黑洞直播</span>
        {Object.keys(projectFiles).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={file === name}
            aria-controls={documentId}
            onClick={() => setFile(name as keyof typeof projectFiles)}
          >
            ▤ {name}
          </button>
        ))}
      </div>
      <article className="demo-paper" id={documentId} aria-label="文件内容">
        <aside className="project-context" aria-label="续写任务的引用依据">
          <strong>续写任务 · 示例</strong>
          <p>接着第一章写：金属球开始出现异常，苏白仍在直播。</p>
          <p>Agent 的上下文：点击引用查看原文</p>
          {Object.keys(projectFiles).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={file === name}
              onClick={() => setFile(name as keyof typeof projectFiles)}
            >
              @{name}
            </button>
          ))}
          <p>沿用人物动机与已有情节，按创作要求保持克制叙述。</p>
        </aside>
        <h3>{projectFiles[file].title}</h3>
        {projectFiles[file].paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </article>
      <div className="demo-bottom">
        <span>示例文件，由作者组织</span>
        <a
          href="/reference-assets/storyflow-editor.webp"
          target="_blank"
          rel="noreferrer"
        >
          查看真实界面 ↗
        </a>
      </div>
    </section>
  );
}

export function SkillsDemo() {
  const [showExample, setShowExample] = useState(false);
  const panelId = useId();
  return (
    <section className="writing-demo" aria-label="Skills 方法演示">
      <div className="demo-titlebar">
        <span className="demo-dots" aria-hidden="true">
          ● ● ●
        </span>
        <span>Storyflow · Skills</span>
        <span>示例项目</span>
      </div>
      <div className="demo-tabs" role="group" aria-label="查看 Skill">
        <button
          type="button"
          aria-pressed={!showExample}
          aria-controls={panelId}
          onClick={() => setShowExample(false)}
        >
          方法说明
        </button>
        <button
          type="button"
          aria-pressed={showExample}
          aria-controls={panelId}
          onClick={() => setShowExample(true)}
        >
          使用示例
        </button>
      </div>
      <article className="demo-paper" id={panelId}>
        <h3>book-deconstructor</h3>
        {showExample ? (
          <>
            <h4>把方法用到这次创作</h4>
            <p>在任务中选择已安装的拆书 Skill，再交代要分析的材料和目标。</p>
            <blockquote className="skill-prompt">
              拆解我提供的第一章：提炼开场钩子、人物动机和悬念推进的方法。先给出依据，再说明哪些方法可以用到我的作品中。
            </blockquote>
            <p>这是示例指令。实际分析需要你提供原文。</p>
            <a
              className="text-arrow"
              href="/docs/#full-review"
              data-storyflow-page-link="true"
            >
              在 Storyflow 中使用 Skill →
            </a>
          </>
        ) : (
          <>
            <p>
              系统化拆解一本书，运用 RIA
              拆书法提取核心框架、关键观点并转化为行动。
            </p>
            <h4>R · Reading</h4>
            <p>阅读原文，忠实摘录原书核心段落或章节要点。</p>
            <h4>I · Interpretation</h4>
            <p>用自己的话转述核心概念，关联已知知识。</p>
            <h4>A · Appropriation</h4>
            <p>联系实际场景，把方法转化为具体行动。</p>
          </>
        )}
      </article>
      <div className="demo-bottom">
        <span>方法可查看，也可按项目编辑</span>
        <a
          href="/reference-assets/storyflow-skills-detail.webp"
          target="_blank"
          rel="noreferrer"
        >
          查看真实界面 ↗
        </a>
      </div>
    </section>
  );
}

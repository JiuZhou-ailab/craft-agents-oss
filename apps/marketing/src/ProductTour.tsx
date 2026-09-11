// input: Unmodified current Electron captures and authored tour captions
// output: Clean product previews or annotated tutorial tours with optional playback
// pos: Shared public product evidence for the homepage and tutorial
import { useEffect, useId, useRef, useState } from "react";
import "./product-tour.css";

export const captures = {
  workspace: {
    title: "目标与正文",
    text: "在左侧对话里交代目标，点击文件链接，就能在右侧阅读、编辑正文。",
    focus: [250, 45, 960, 420],
    mark: [750, 80, 460, 355],
  },
  context: {
    title: "引用项目文件",
    text: "从对话打开人物文件。正文、人物与创作要求在同一个项目中，目录位于文档右侧。",
    focus: [720, 0, 720, 490],
    mark: [1220, 45, 210, 200],
  },
  review: {
    title: "审阅具体改动",
    text: "点击本轮的改动汇总卡，在右侧对照具体增删，选择 Accept（接受）或 Reject（拒绝）。",
    focus: [735, 345, 475, 255],
    mark: [750, 380, 445, 195],
  },
  skills: {
    title: "查看写作方法",
    text: "在 Skill 详情中阅读检查顺序。用「编辑文件」调整方法，再点「立即使用」带入任务。",
    focus: [430, 420, 810, 300],
    mark: [465, 455, 750, 245],
  },
  sources: {
    title: "接入参考资料",
    text: "数据源详情展示连接方式、资料位置和使用说明。示例连接的是本地作品文件夹。",
    focus: [310, 180, 820, 390],
    mark: [320, 195, 800, 355],
  },
  history: {
    title: "保存作品版本",
    text: "从编辑器打开「版本管理」，保存当前内容。历史中出现记录后，可以按需恢复。",
    focus: [440, 305, 560, 300],
    mark: [465, 340, 510, 170],
  },
  "add-menu": {
    title: "把方法带入任务",
    text: "点击输入区的加号，选择技能或数据源，让已有的方法和资料参与本次任务。",
    focus: [250, 585, 500, 310],
    mark: [435, 635, 290, 70],
  },
} as const;
export type CaptureKey = keyof typeof captures;
export const captureUrl = (key: CaptureKey) =>
  `/reference-assets/current/${key}.png`;

export function ProductTour({
  steps,
  label = "真实界面导览",
  detail = false,
  annotated = true,
}: {
  steps: readonly CaptureKey[];
  label?: string;
  detail?: boolean;
  annotated?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(detail);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLElement>(null);
  const id = useId();
  const key = steps[index];
  const capture = captures[key];
  const [x, y, w, h] = capture.focus;
  const scale = Math.min(1440 / w, 900 / h);
  const transform = zoom
    ? `translate(${(1440 - w * scale) / 2 - x * scale}px, ${(900 - h * scale) / 2 - y * scale}px) scale(${scale})`
    : "translate(0px, 0px) scale(1)";
  useEffect(() => {
    const scene = root.current?.querySelector<HTMLElement>(".tour-scene");
    if (scene) scene.scrollLeft = (scene.scrollWidth - scene.clientWidth) / 2;
  }, [key, zoom]);
  useEffect(() => {
    if (!playing) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    if (root.current) observer.observe(root.current);
    const timer = window.setInterval(() => {
      const focused = document.activeElement;
      const otherControlFocused =
        root.current?.contains(focused) &&
        !focused?.classList.contains("tour-play");
      if (
        !visible ||
        media.matches ||
        root.current?.querySelector(".tour-scene")?.matches(":hover") ||
        otherControlFocused
      )
        return;
      setIndex((value) => (value + 1) % steps.length);
      setFailed(false);
    }, 6000);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [playing, steps.length]);
  const select = (next: number) => {
    setIndex(next);
    setFailed(false);
    setPlaying(false);
  };
  return (
    <section
      className="product-tour"
      data-zoom={zoom}
      data-annotated={annotated}
      aria-label={label}
      ref={root}
    >
      <div className="tour-tabs" role="group" aria-label="选择实拍步骤">
        {steps.map((step, i) => (
          <button
            type="button"
            key={step}
            aria-pressed={i === index}
            aria-controls={id}
            onClick={() => select(i)}
          >
            {annotated && <span>{String(i + 1).padStart(2, "0")}</span>}
            {captures[step].title}
          </button>
        ))}
      </div>
      <div
        className="tour-scene"
        id={id}
        tabIndex={0}
        role="region"
        aria-label="截图细节，窄屏可横向滚动"
      >
        {failed ? (
          <p role="status" className="tour-fallback">
            截图暂未加载。{capture.text}
            <a href="/docs/">阅读操作教程 →</a>
          </p>
        ) : (
          <svg
            viewBox="0 0 1440 900"
            role="img"
            aria-labelledby={`${id}-title`}
          >
            <title
              id={`${id}-title`}
            >{`${capture.title}：${capture.text} 当前 Storyflow 桌面界面，示例项目。`}</title>
            <g className="tour-camera" style={{ transform }}>
              <image
                key={key}
                className="tour-image"
                href={captureUrl(key)}
                width="1440"
                height="900"
                onError={() => setFailed(true)}
              />
              {annotated && (
                <>
                  <rect
                    className="tour-outline"
                    x={capture.mark[0]}
                    y={capture.mark[1]}
                    width={capture.mark[2]}
                    height={capture.mark[3]}
                    rx="5"
                  />
                  <circle
                    className="tour-marker"
                    cx={capture.mark[0] + 14}
                    cy={capture.mark[1] + 14}
                    r="13"
                  />
                  <text
                    className="tour-marker-label"
                    x={capture.mark[0] + 14}
                    y={capture.mark[1] + 19}
                  >
                    1
                  </text>
                </>
              )}
            </g>
          </svg>
        )}
      </div>
      <div className="tour-caption" aria-live={playing ? "off" : "polite"}>
        {annotated && (
          <p>
            <span className="tour-number">1</span>
            {capture.text}
          </p>
        )}
        <div className="tour-actions">
          <span>当前实拍 · 示例内容</span>
          <button
            type="button"
            aria-pressed={zoom}
            onClick={() => setZoom((value) => !value)}
          >
            {zoom ? "查看全貌" : annotated ? "放大标注" : "查看细节"}
          </button>
          {steps.length > 1 && (
            <button
              className="tour-play"
              type="button"
              aria-pressed={playing}
              onClick={() => setPlaying((value) => !value)}
            >
              {playing ? "暂停导览" : "播放导览"}
            </button>
          )}
          <a href={captureUrl(key)} target="_blank" rel="noreferrer">
            原图 ↗
          </a>
        </div>
      </div>
    </section>
  );
}

import { CodexMarkdownRenderer, type MarkdownHost } from "@alwith/module-chat/markdown"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  CloudIcon,
  CpuIcon,
  FileTextIcon,
  FolderIcon,
  KeyboardIcon,
  LayersIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  WrenchIcon
} from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { describeError } from "@/lib/error-text"
import { AuxWindowShell } from "@/components/alwith-ui/aux-window-shell"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { openExternal } from "@/lib/open"

import contentEn from "../../../guide/index.md?raw"
import contentZh from "../../../guide/index.zh-CN.md?raw"
import logo from "../../../src-tauri/icons/128x128.png"
import "@alwith/module-chat/styles.css"
import { guideCopy } from "./guide-locale"
import "./guide.css"

const CHAPTER_ICONS = [
  BookOpenIcon,
  PlayIcon,
  PanelLeftIcon,
  MessageSquareIcon,
  CpuIcon,
  FolderIcon,
  LayersIcon,
  CloudIcon,
  KeyboardIcon,
  WrenchIcon
] as const

function chaptersFrom(content: string, welcomeTitle: string) {
  return content.split(/^## /m).map((chapter, index) => {
    if (index === 0) return { title: welcomeTitle, text: chapter }
    const end = chapter.indexOf("\n")
    return { title: chapter.slice(0, end), text: chapter.slice(end + 1) }
  })
}

function InterfaceMap({ navigate, copy }: { navigate: (index: number) => void; copy: ReturnType<typeof guideCopy> }) {
  return (
    <div className="guide-interface">
      <div className="guide-interface-bar">
        <img className="guide-interface-mark" src={logo} alt="" />
        <strong>ALWith U⁺</strong>
        <span>{copy.interface.label}</span>
      </div>
      <div className="guide-interface-body">
        <div className="guide-interface-sidebar">
          <div className="guide-interface-tools">
            <SearchIcon />
            <PlusIcon />
          </div>
          <span className="guide-interface-label">{copy.interface.yourProjects}</span>
          <div className="guide-interface-project">
            <FolderIcon /> {copy.interface.myProject}
          </div>
          <Button variant="secondary" onClick={() => navigate(2)}>
            <MessageSquareIcon /> {copy.interface.firstTask}
          </Button>
          <div className="guide-interface-account">Account & settings</div>
        </div>
        <div className="guide-interface-chat">
          <span className="guide-interface-label">{copy.interface.conversation}</span>
          <div className="guide-interface-request">{copy.interface.request}</div>
          <div className="guide-interface-response">
            <ShieldCheckIcon />
            <span>
              {copy.interface.response[0]}
              <br />
              {copy.interface.response[1]}
              <br />
              {copy.interface.response[2]}
            </span>
          </div>
          <Button variant="outline" className="guide-interface-compose" onClick={() => navigate(3)}>
            {copy.interface.describeNext}
            <ArrowRightIcon />
          </Button>
        </div>
        <div className="guide-interface-files">
          <FileTextIcon />
          <span>README.md</span>
          <div />
          <div />
          <div />
          <Button variant="ghost" onClick={() => navigate(5)}>
            {copy.interface.openFiles}
          </Button>
        </div>
      </div>
      <p>{copy.interface.clickPart}</p>
    </div>
  )
}

function GuideHome({
  navigate,
  chapters,
  details,
  copy
}: {
  navigate: (index: number) => void
  chapters: ReturnType<typeof chaptersFrom>
  details: Array<{ icon: (typeof CHAPTER_ICONS)[number]; summary: string; group: string; takeaway: string }>
  copy: ReturnType<typeof guideCopy>
}) {
  return (
    <div className="guide-home">
      <section className="guide-hero">
        <div className="guide-hero-copy">
          <span className="guide-edition">
            <BookOpenIcon /> {copy.edition}
          </span>
          <h1>
            {copy.heroTitle[0]}
            <br />
            {copy.heroTitle[1]}
          </h1>
          <p>{copy.heroBody}</p>
          <div className="guide-hero-actions">
            <Button size="lg" onClick={() => navigate(1)}>
              {copy.startAction}
              <ArrowRightIcon />
            </Button>
            <Button variant="outline" size="lg" onClick={() => navigate(2)}>
              {copy.exploreAction}
            </Button>
          </div>
          <span className="guide-availability">{copy.availability}</span>
        </div>
        <InterfaceMap navigate={navigate} copy={copy} />
      </section>
      <section className="guide-path" aria-label={copy.pathAria}>
        {copy.path.map((step, index) => (
          <div key={step.title}>
            <span className="guide-step">{index + 1}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </div>
        ))}
      </section>
      <section className="guide-topics">
        <div className="guide-section-heading">
          <h2>{copy.topicsTitle}</h2>
          <p>{copy.topicsDesc}</p>
        </div>
        <div className="guide-topic-grid">
          {[3, 4, 5, 6, 7, 9].map((index) => {
            const Icon = details[index].icon
            return (
              <Button key={index} variant="outline" className="guide-topic-card" onClick={() => navigate(index)}>
                <Icon />
                <span>
                  <strong>{chapters[index].title}</strong> <span>{details[index].summary}</span>
                </span>
                <ArrowRightIcon />
              </Button>
            )
          })}
        </div>
      </section>
      <section className="guide-first-task">
        <div>
          <span className="guide-example-label">{copy.firstTaskLabel}</span>
          <h2>{copy.firstTaskTitle}</h2>
          <p>{copy.firstTaskBody}</p>
        </div>
        <blockquote>{copy.firstTaskQuote}</blockquote>
      </section>
      <footer className="guide-home-footer">
        <span>{copy.footerTitle}</span>
        <span>{copy.footerTagline}</span>
      </footer>
    </div>
  )
}

export function GuidePage() {
  const { i18n } = useTranslation()
  const copy = guideCopy(i18n.language)
  const chapters = useMemo(
    () => chaptersFrom(i18n.language.toLowerCase().startsWith("zh") ? contentZh : contentEn, copy.welcomeTitle),
    [copy.welcomeTitle, i18n.language]
  )
  const details = useMemo(
    () => CHAPTER_ICONS.map((icon, index) => ({ icon, ...copy.details[index]! })),
    [copy]
  )
  const [selected, setSelected] = useState(0)
  const { resolvedTheme } = useTheme()
  const host = useMemo<MarkdownHost>(
    () => ({
      theme: resolvedTheme,
      copyLabel: i18n.language.toLowerCase().startsWith("zh") ? "复制" : "Copy",
      openLink: (url) => {
        void openExternal(url).catch((error: unknown) => toast.error(describeError(error)))
      }
    }),
    [i18n.language, resolvedTheme]
  )
  const chapter = chapters[selected]
  const detail = details[selected]
  return (
    <AuxWindowShell
      title={copy.windowTitle}
      showTitleBar={!navigator.platform.includes("Win")}
      sidebarClassName="guide-sidebar"
      className="guide-window"
      sidebar={
        <nav aria-label={copy.chaptersAria} className="guide-navigation">
          <div className="guide-brand">
            <img src={logo} alt="" />
            <strong>{copy.brand}</strong>
          </div>
          {chapters.map((item, index) => {
            const Icon = details[index].icon
            return (
              <div key={item.title}>
                {(index === 0 || details[index - 1].group !== details[index].group) && (
                  <p className="guide-navigation-group">{details[index].group}</p>
                )}
                <Button
                  variant="ghost"
                  className="guide-navigation-item"
                  aria-current={selected === index ? "page" : undefined}
                  onClick={() => setSelected(index)}
                >
                  <Icon />
                  {item.title}
                </Button>
              </div>
            )
          })}
          <div className="guide-navigation-footer">
            <CheckIcon />
            <span>
              {copy.bundled}
              <br />
              <small>{copy.editionShort}</small>
            </span>
          </div>
        </nav>
      }
    >
      <main key={selected} className="guide-main" aria-label={chapter.title}>
        {selected === 0 ? (
          <GuideHome navigate={setSelected} chapters={chapters} details={details} copy={copy} />
        ) : (
          <div className="guide-reading">
            <header className="guide-reading-header">
              <Button variant="ghost" size="sm" onClick={() => setSelected(0)}>
                <ArrowLeftIcon />
                {copy.guideHome}
              </Button>
              <span>{detail.group}</span>
            </header>
            <div className="guide-reading-layout">
              <article>
                <div className="guide-chapter-heading">
                  <detail.icon />
                  <h1>{chapter.title}</h1>
                  <p>{detail.summary}</p>
                </div>
                <div className="guide-key-point">
                  <ShieldCheckIcon />
                  <p>{detail.takeaway}</p>
                </div>
                <div className="guide-prose">
                  <CodexMarkdownRenderer text={chapter.text} host={host} />
                </div>
              </article>
              <aside className="guide-reading-aside">
                <strong>{copy.inThisChapter}</strong>
                {chapter.text
                  .split(/^### /m)
                  .slice(1)
                  .map((part) => (
                    <p key={part.split("\n")[0]}>{part.split("\n")[0]}</p>
                  ))}
                <div>
                  <BookOpenIcon />
                  <p>{copy.workThrough}</p>
                </div>
              </aside>
            </div>
            <nav className="guide-page-navigation" aria-label={copy.adjacentAria}>
              <Button
                variant="outline"
                aria-label={`${copy.previous} ${chapters[selected - 1]!.title}`}
                onClick={() => setSelected(selected - 1)}
              >
                <ArrowLeftIcon />
                <span>
                  <small>{copy.previous}</small>
                  {chapters[selected - 1]!.title}
                </span>
              </Button>
              {selected < chapters.length - 1 && (
                <Button
                  variant="outline"
                  aria-label={`${copy.next} ${chapters[selected + 1]!.title}`}
                  onClick={() => setSelected(selected + 1)}
                >
                  <span>
                    <small>{copy.next}</small>
                    {chapters[selected + 1]!.title}
                  </span>
                  <ArrowRightIcon />
                </Button>
              )}
            </nav>
          </div>
        )}
      </main>
    </AuxWindowShell>
  )
}

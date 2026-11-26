import { ArchiveIcon, BlocksIcon, GaugeIcon, PuzzleIcon, SparklesIcon } from "lucide-react"
import type { ComponentType, SVGProps } from "react"

import { MeetingsGlyph, ScheduledTasksGlyph } from "./feature-glyphs"

export type WorkbenchPage =
  | "overview"
  | "plugins"
  | "extensions"
  | "skills"
  | "groups"
  | "automation"
  | "archives"
  | "usage"

export type WorkbenchFeatureId = Exclude<WorkbenchPage, "overview">

interface WorkbenchFeature {
  id: WorkbenchFeatureId
  labelKey: string
  descriptionKey: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

export interface WorkbenchFeatureGroup {
  id: "capabilities" | "workflow" | "records"
  labelKey: string
  items: WorkbenchFeature[]
}

/** Shared by the workbench navigation and overview so names stay identical everywhere. */
export const WORKBENCH_GROUPS: WorkbenchFeatureGroup[] = [
  {
    id: "capabilities",
    labelKey: "workbench.groups.capabilities",
    items: [
      {
        id: "plugins",
        labelKey: "workbench.plugins",
        descriptionKey: "workbench.pluginsDesc",
        icon: PuzzleIcon
      },
      {
        id: "extensions",
        labelKey: "workbench.extensions",
        descriptionKey: "workbench.extensionsDesc",
        icon: BlocksIcon
      },
      {
        id: "skills",
        labelKey: "workbench.skills",
        descriptionKey: "workbench.skillsDesc",
        icon: SparklesIcon
      }
    ]
  },
  {
    id: "workflow",
    labelKey: "workbench.groups.workflow",
    items: [
      {
        id: "groups",
        labelKey: "workbench.meetings",
        descriptionKey: "workbench.meetingsDesc",
        icon: MeetingsGlyph
      },
      {
        id: "automation",
        labelKey: "workbench.automation",
        descriptionKey: "workbench.automationDesc",
        icon: ScheduledTasksGlyph
      }
    ]
  },
  {
    id: "records",
    labelKey: "workbench.groups.records",
    items: [
      {
        id: "archives",
        labelKey: "workbench.archives",
        descriptionKey: "workbench.archivesDesc",
        icon: ArchiveIcon
      },
      {
        id: "usage",
        labelKey: "workbench.usage",
        descriptionKey: "workbench.usageDesc",
        icon: GaugeIcon
      }
    ]
  }
]

/**
 * Apps published by the company for this build. Each entry is a manifest address: the installer
 * reads the metadata from that address and downloads the code that sits beside it, so the version
 * the panel installs always matches what the publisher serves today.
 */
export interface CompanyApp {
  id: string
  name: string
  description: { "zh-CN": string; en: string }
  manifestUrl: string
}

const PUBLISHER = "https://bi-api.finture.id/api/ext"

export const COMPANY_APPS: readonly CompanyApp[] = [
  {
    id: "bi-metrics",
    name: "BI Metrics",
    description: {
      "zh-CN": "查看公司 BI 看板订阅指标、当日异动告警与月报原图，深链直达详情。",
      en: "Company BI subscriptions, today's anomaly alerts and monthly report images, with deep links to details."
    },
    manifestUrl: `${PUBLISHER}/bi-metrics/manifest.json`
  },
  {
    id: "yup-kb",
    name: "YUP 知识库",
    description: {
      "zh-CN": "在应用内查阅公司知识库，与云盘共用同一份登录态，不必再登录网页。",
      en: "Read the company knowledge base inside the app on the same session as Drive, without signing in to the web again."
    },
    manifestUrl: `${PUBLISHER}/yup-kb/manifest.json`
  },
  {
    id: "etms-strategy-review",
    name: "ETMS 策略审核",
    description: {
      "zh-CN": "列出待审 ETMS 策略，并在应用内给出审核结论。",
      en: "Lists pending ETMS strategies and records the review verdict in place."
    },
    manifestUrl: `${PUBLISHER}/etms-strategy-review/manifest.json`
  }
]

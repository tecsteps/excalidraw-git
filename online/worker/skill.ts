// The agent instructions of the Kurviq MCP: the local skill
// (scenes-mcp/skill/excalidraw-scenes/SKILL.md), with what differs online.
import localSkill from "../../scenes-mcp/skill/excalidraw-scenes/SKILL.md";

const INTRO = (app: string) => `# Kurviq: how to work with the user's drawings

The user works in **Kurviq** (${app}), an Excalidraw with **scenes** (named
drawings, URL \`${app}/<scene>\`). Scenes live in the user's browser and,
if the user connected GitHub, in a GitHub repo they chose (several people
can share one repo). The MCP server gives you tools for it. The user is
often **looking at Kurviq while you work** and edits by hand in between.

**You work through the user's open Kurviq tab.** Your MCP link belongs to
one browser: every tool needs Kurviq open there (any scene). Your edits run
in that tab with the real Excalidraw (text measured with the real fonts,
real PNG images) and are committed to GitHub with the user's connection,
marked as agent commits; the tab merges them into what the user is doing.
Without GitHub (\`app_status\` shows \`github: false\`) all scenes are
local-only: they exist only in that browser, and you read and edit them
there the same way.

If a tool answers "Kurviq is not open", ask the user to open ${app} and
keep the tab open, then try again.

`;

const TROUBLESHOOTING = (app: string) => `## Troubleshooting

- "Kurviq is not open in the user's browser": ask the user to open ${app}
  in the browser the agent link was made in (MCP button, top left).
- "GitHub is not connected": the user can connect it in the Scenes sidebar;
  until then, work with local-only scenes.
- Local file paths (images, edit files) and PDF export are not available
  through the Kurviq MCP: pass images as http(s) or data URLs; the user
  exports PDFs in Kurviq (Slides sidebar → PDF).
`;

const section = (text: string, heading: string) => {
  const start = text.indexOf(heading);
  if (start < 0) {
    return null;
  }
  const end = text.indexOf("\n## ", start + heading.length);
  return [start, end < 0 ? text.length : end + 1] as const;
};

export const kurviqSkill = (app: string) => {
  let text = String(localSkill).replace(/^---[\s\S]*?---\s*/, "");
  const intro = text.indexOf("## Golden rules");
  text = INTRO(app) + text.slice(intro);
  for (const heading of ["## Live mode", "## Troubleshooting"]) {
    const range = section(text, heading);
    if (range) {
      text = text.slice(0, range[0]) + text.slice(range[1]);
    }
  }
  text = text
    .replace(/your headless\s+Excalidraw, which commits it/g, "the user's Kurviq tab, which commits it")
    .replace(/in your headless Excalidraw and are\s+gone when it stops/g, "in the user's Kurviq tab (browser storage)")
    .replace(/your headless Excalidraw/g, "the user's Kurviq tab")
    .replace(/\s*\(localhost:3101\)/g, "")
    .replace(/the scenes server's HTTP API/g, "Kurviq's or GitHub's HTTP API")
    .replace(/absolute file path,\s+/g, "");
  return `${text.trimEnd()}\n\n${TROUBLESHOOTING(app)}`;
};

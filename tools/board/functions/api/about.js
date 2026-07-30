import { authenticate } from '../_shared/auth.js';
import { json } from '../_shared/http.js';

const summary = `Spoolcast turns writing into television. The launch product: a writer feeds in
their own writing, and Spoolcast plans a season from it, designs the cast and world once, then
produces each episode through a staged pipeline: structure, screenplay, shot board, generated
visuals and narration, review, final cut. The finished season lands on the creator's public
profile as a series page that reads like a streaming show, where viewers spend credits to watch
past the free episodes and the creator earns a share.

The same pipeline is a general video workflow. Every stage can be completed with AI, edited by
hand, or run hands-off by autopilot under a budget, and per-step rules give the AI persistent
direction instead of one-off prompts. Creators making ads or client work use the workflow
privately, without the storefront.

Two halves evolve separately. The engine owns production: drafting, asset generation, review,
rendering, publishing. The site owns people: accounts, profiles, the show pages, and credits.
Only files and metadata cross between the two.

Current state: the editor and public watch pages are hosted, the engine deploys to Railway, and
content sits behind a storage seam with an R2 mirror. The big builds between here and launch:
manuscript-to-season ingestion, the autopilot runner, cloud rendering, the automated publish
handoff, and the credits paywall.`;

const architecture = `flowchart TB
  EDITOR["Editor (Cloudflare Pages)"]
  SITE["Creator site (profiles, portfolio)"]
  ENGINE["Pipeline engine (Railway)"]

  subgraph STAGES["Engine stages"]
    DRAFT["Drafting steps"]
    GEN["Image + video generation"]
    TTS["Narration"]
    REVIEW["Review boards"]
    RENDER["Final cut + formats"]
    PUBLISH["Package + publish"]
  end

  EDITOR --> ENGINE
  SITE --> ENGINE
  ENGINE --> DRAFT
  ENGINE --> GEN
  ENGINE --> TTS
  ENGINE --> REVIEW
  ENGINE --> RENDER
  ENGINE --> PUBLISH

  STAGES --> R2[("Content storage (R2 mirror)")]
  DRAFT --> LLM["Model APIs"]
  GEN --> KIE["kie.ai"]
  TTS --> GOOGLE["Google TTS"]
  RENDER --> WORKER["Render worker (Remotion + ffmpeg)"]
  PUBLISH --> YOUTUBE["YouTube"]`;

const pipeline = `flowchart LR
  IDEA["Core idea"] --> MESSAGE["Core message"]
  MESSAGE --> SETUP["Project setup"]
  SETUP --> STRUCTURE["Structure outline"]
  STRUCTURE --> KIT["World kit"]
  KIT --> SCREENPLAY["Screenplay"]
  SCREENPLAY --> BOARD["Shot board + shot list"]
  BOARD --> GENERATE["Visual + narration generation"]
  GENERATE --> REVIEW["Visual review + final cut"]
  REVIEW --> PUBLISH["Package + publish"]`;

export async function onRequestGet(context) {
  const auth = await authenticate(context.request, context.env);
  if (auth.response) return auth.response;

  const repositoryUrl = context.env.GITHUB_REPO_URL?.replace(/\/+$/, '');
  const links = repositoryUrl
    ? [
        { label: 'Engineering tasks', url: `${repositoryUrl}/blob/main/docs/TASKS.md` },
        {
          label: 'Engine vs site architecture',
          url: `${repositoryUrl}/blob/main/docs/architecture-engine-vs-site.md`,
        },
        { label: 'Business model', url: `${repositoryUrl}/blob/main/docs/business-model.md` },
      ]
    : [];

  return json({ summary, architecture, pipeline, links }, 200, {
    'X-Board-Identity': auth.identity,
  });
}

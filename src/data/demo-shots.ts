// Visual Pacing mock plan. Mirrors working/visual-pacing-plan.md: chunk → beat
// (one narration line) → one or more images, each with a "why now" rationale,
// hold time, and whether it's distinct from the previous image. Inventory and
// summary counts are derived from this single source so they can't drift.
// (Sample content adapted from a real 5-minute devlog pacing plan.)
export type VPImage = { id: string; what: string; why: string; hold: string; distinct: boolean; refs: string; firstWord: string; lastWord: string; startS: number; endS: number; firstIdx: number; lastIdx: number }
export type VPBeat = { code: string; range: string; narration: string; images: VPImage[] }
export type VPChunk = { id: string; title: string; range: string; summary: string; words: string[]; beats: VPBeat[] }
export type VPOverlay = { id: string; trigger: string; image: string; dur: string; placement: string; anchor: string; chunk: string; firstIdx: number; lastIdx: number }

// Mock pacing plan — extracted from spoolcast-dev-log-11 (33 images, C001 split to 6).
// Nested chunk → beat → image; each image carries its Whisper-aligned time + word span.
export const visualPacingPlan: {
  source: string; style: string; runtime: string
  opening: number; body: number
  chunks: VPChunk[]; overlays: VPOverlay[]
} = {
  source: "spoolcast-dev-log-06", style: "wojak-gpt2", runtime: "~5.0 min",
  opening: 9, body: 24,
  chunks: [
    {
      id: "C001", title: "Cold Open", range: "0–22s", summary: "Agent failed mid-ship. VPN drops. Three compaction attempts, all dead.",
      words: ["I", "was", "in", "the", "middle", "of", "shipping", "a", "video", "when", "my", "AI", "agent", "failed.", "Not", "because", "it", "crashed,", "not", "because", "it", "ran", "out", "of", "tokens,", "because", "the", "VPN", "connection", "to", "the", "server", "it", "was", "running", "on", "kept", "dropping.", "Every", "time", "the", "agent", "tried", "to", "compress", "the", "conversation,", "the", "connection", "cut", "out", "and", "the", "session", "died.", "Three", "failed", "attempts", "in", "a", "row.", "After", "the", "third,", "I", "gave", "up."],
      beats: [
        {
          code: "001A", range: "0.0–3.4s", narration: "I was in the middle of shipping a video when my AI agent failed.",
          images: [
            { id: "IMG01", what: "Builder slams machine shut at dimly-lit airport gate at midnight. Departure board behind: every flight CANCELLED in red.", why: "Immediate visual hook — failure + frustration. Sets tone before a word of explanation.", hold: "3.4s", distinct: true, refs: "builder", firstWord: "I", lastWord: "failed.", startS: 0.0, endS: 3.4, firstIdx: 0, lastIdx: 13 },
          ],
        },
        {
          code: "001B", range: "4.1–22.0s", narration: "split into 5 visual moments at sentence boundaries:",
          images: [
            { id: "IMG02", what: "Crash icon with red circle-slash overlaid, beside a token counter also struck through. Both false causes being dismissed. Dark background with a single green checkmark appearing: \"Not this.\"", why: "\"Not because it crashed. Not because it ran out of tokens.\" — visually eliminate the wrong answers before revealing the real one. The viewer sees two theories rejected in 3 seconds.", hold: "3.4s", distinct: true, refs: "—", firstWord: "Not", lastWord: "tokens.", startS: 4.1, endS: 7.54, firstIdx: 17, lastIdx: 27 },
            { id: "IMG03", what: "Close-up of closed machine screen. Progress bar frozen at 87%, sparks from the crack in the percentage.", why: "\"Because the VPN connection kept dropping.\" — the real cause. Frozen progress = the stall. Sparks = the connection breaking.", hold: "3.4s", distinct: true, refs: "—", firstWord: "Because", lastWord: "dropping.", startS: 8.52, endS: 11.9, firstIdx: 32, lastIdx: 44 },
            { id: "IMG04", what: "AI-figure struggles to cram papers through a narrow tube labeled COMPACTION. A lightning bolt strikes the tube mid-cram, shattering it. Papers fly everywhere. The shattered tube pieces float in the air.", why: "\"Every time the agent tried to compress the conversation, the connection cut out and the session died.\" — the failure loop made physical. Lightning = connection drop, shattered tube = dead session.", hold: "4.5s", distinct: true, refs: "ai-figure", firstWord: "Every", lastWord: "died.", startS: 12.72, endS: 17.24, firstIdx: 47, lastIdx: 61 },
            { id: "IMG05", what: "Three red X marks stacked vertically on dark screen. Each X pulses slightly larger than the last.", why: "\"Three failed attempts in a row.\" — visual counting of the failures. Quick flash (~1.5s) — the stacking Xs make the repetition feel physical.", hold: "1.5s", distinct: true, refs: "—", firstWord: "Three", lastWord: "row.", startS: 18.22, endS: 19.72, firstIdx: 66, lastIdx: 66 },
            { id: "IMG06", what: "Builder's hand releasing the machine handle, turning away from the gate. Silhouette against the red CANCELLED board.", why: "\"After the third, I gave up.\" — the surrender moment. Emotional pivot from frustration to defeat. Quick cut (~1.4s), holds through transition to promise.", hold: "1.4s", distinct: true, refs: "builder", firstWord: "After", lastWord: "up.", startS: 20.6, endS: 22.02, firstIdx: 66, lastIdx: 66 },
          ],
        },
      ],
    },
    {
      id: "C002", title: "Promise + Spoolcast Intro", range: "23–48s", summary: "Promise what viewer will learn. Introduce Spoolcast pipeline.",
      words: ["By", "the", "end,", "you", "will", "understand", "why", "I", "switched", "tools", "mid", "-project", "and", "why", "the", "software", "that", "wraps", "around", "an", "AI", "model", "matters", "as", "much", "as", "the", "model", "itself.", "Quick", "context.", "Spoolcast", "is", "my", "AI", "video", "pipeline.", "I", "give", "it", "messy", "source", "material,", "build", "notes,", "screenshots,", "chat", "logs,", "and", "agents", "help", "turn", "that", "into", "videos.", "Understand", "the", "source.", "Write", "the", "story.", "Plan", "what", "appears", "on", "screen.", "Make", "the", "narration", "and", "visuals.", "Render", "the", "final", "video."],
      beats: [
        {
          code: "002A", range: "23.2–30.4s", narration: "By the end, you will understand why I switched tools mid-project, and why the software that wraps around an AI model matters as much as the model itself.",
          images: [
            { id: "IMG07", what: "Video-making machine on bright TV-show set with stage lights. Builder stands beside it, hand on lever. Clean video reel glowing at output end.", why: "Orientation: introduces the system that makes this video. \"You will understand\" paired with \"here's the machine that makes it.\"", hold: "7.2s", distinct: true, refs: "builder", firstWord: "By", lastWord: "itself.", startS: 23.25, endS: 30.35, firstIdx: 0, lastIdx: 24 },
          ],
        },
        {
          code: "002B", range: "31.3–47.9s", narration: "Quick context. Spoolcast is my AI video pipeline... understand the source, write the story, plan what appears on screen, make the narration and visuals, render the final video.",
          images: [
            { id: "IMG08", what: "Five glass chambers light up in sequence: eye icon → pen icon → canvas icon → speaker icon → film strip icon. Each glows as the narration reaches it. Dark background, clean progression.", why: "Visualize the pipeline steps as they're spoken. Each step gets its own visual activation.", hold: "9.2s", distinct: true, refs: "—", firstWord: "Quick", lastWord: "turn", startS: 31.29, endS: 40.49, firstIdx: 28, lastIdx: 50 },
            { id: "IMG09", what: "Same machine, wide shot. Messy inputs drop into left side: chat bubbles, screenshot cards, text file pages. Clean glowing video reel emerges right side. Builder pulls lever, activating a stage.", why: "Show the messy-input → clean-output contrast. The Spoolcast promise made visual.", hold: "7.4s", distinct: true, refs: "builder", firstWord: "that", lastWord: "video.", startS: 40.49, endS: 47.91, firstIdx: 51, lastIdx: 71 },
          ],
        },
      ],
    },
    {
      id: "C003", title: "Almost Shipped", range: "49–70s", summary: "Tool stopped working. Hotel room in China. Ep 17 almost done.",
      words: ["This", "episode", "is", "about", "what", "happened", "when", "the", "tool", "I", "was", "using", "stopped", "working", "and", "I", "had", "to", "find", "a", "new", "one", "from", "a", "hotel", "room", "in", "China.", "The", "video", "was", "episode", "17", "of", "a", "daily", "AI", "news", "show.", "Script", "done,", "clips", "generated,", "final", "render", "complete,", "one", "command", "left", "to", "publish,", "and", "the", "tool", "that", "was", "supposed", "to", "run", "that", "command", "could", "no", "longer", "finish", "a", "sentence."],
      beats: [
        {
          code: "003A", range: "49.2–55.3s", narration: "This episode is about what happened when the tool I was using stopped working, and I was in a hotel room in China with a video almost finished.",
          images: [
            { id: "IMG10", what: "Factory conveyor belt. Three completed packages move toward a launch pad: SCRIPT ✓, CLIPS ✓, RENDER ✓. Builder walks alongside, checking each.", why: "Stakes: show the progress that's about to stall. Three green checks build expectation.", hold: "6.1s", distinct: true, refs: "builder", firstWord: "This", lastWord: "China.", startS: 49.24, endS: 55.28, firstIdx: 0, lastIdx: 25 },
          ],
        },
        {
          code: "003B", range: "56.2–69.5s", narration: "The video was episode seventeen of a daily AI news show. Script written, clips generated, final render running. One command left to publish. And the tool that had been doing this for months could no longer finish a sentence.",
          images: [
            { id: "IMG11", what: "Launch pad close-up. One empty slot labeled PUBLISH. The red button is cracked. A cable between builder's outstretched hand and the console sparks and breaks, inches away.", why: "The almost-shipped moment: everything done except the one thing that failed. The sparking cable = the broken connection.", hold: "13.3s", distinct: true, refs: "builder", firstWord: "The", lastWord: "sentence.", startS: 56.22, endS: 69.48, firstIdx: 29, lastIdx: 66 },
          ],
        },
      ],
    },
    {
      id: "C004", title: "Codex Remote Server", range: "71–86s", summary: "Codex was the tool. Remote server. Desktop is just a window.",
      words: ["The", "tool", "was", "codex,", "open", "-AI's", "coding", "agent.", "For", "months,", "it", "was", "how", "I", "shipped", "everything,", "but", "it", "runs", "on", "a", "remote", "server.", "Your", "desktop", "is", "just", "a", "window.", "When", "the", "connection", "drops,", "you", "feel", "every", "mile", "between", "you", "and", "the", "machine", "doing", "the", "work."],
      beats: [
        {
          code: "004A", range: "70.8–76.3s", narration: "The tool was Codex, OpenAI's coding agent. For months, it was how I shipped everything.",
          images: [
            { id: "IMG12", what: "Builder at a table with open notebook showing Codex interface. Behind the notebook, a giant transparent screen shows a distant server room across an ocean. A thin glowing cable stretches from the notebook across the water.", why: "Introduce the tool that failed. Show the physical distance between builder and server — the cable across the ocean is the metaphor.", hold: "5.5s", distinct: true, refs: "builder", firstWord: "The", lastWord: "everything,", startS: 70.81, endS: 76.27, firstIdx: 0, lastIdx: 16 },
          ],
        },
        {
          code: "004B", range: "77.2–85.5s", narration: "But it runs on a remote server. Your desktop is just a window. When the connection drops, you feel every mile between you and the machine doing the work.",
          images: [
            { id: "IMG13", what: "Same scene, but the cable now has three visible breaks with sparking ends. Builder's reflection in the screen staring at the breaks. The server room on the other side glows, bright and unreachable.", why: "The cable breaks = the three failed compactions. The distance becomes the problem.", hold: "8.3s", distinct: true, refs: "builder", firstWord: "but", lastWord: "work.", startS: 77.17, endS: 85.51, firstIdx: 22, lastIdx: 44 },
          ],
        },
      ],
    },
    {
      id: "C005", title: "Context Compaction Explained", range: "87–115s", summary: "What compaction is. One interrupted call = dead session.",
      words: ["Here", "is", "what", "context", "compaction", "means.", "Every", "message", "stays", "in", "the", "chat", "history.", "After", "hours,", "that", "is", "tens", "of", "thousands", "of", "words.", "The", "model", "can", "only", "hold", "so", "much,", "so", "the", "agent", "summarizes", "the", "early", "parts", "and", "keeps", "going.", "But", "that", "summary", "needs", "one", "uninterrupted", "call.", "If", "your", "connection", "drops,", "the", "compaction", "fails,", "the", "context", "window", "fills", "up,", "and", "the", "session", "dies.", "I", "watch", "the", "four", "-second", "drop", "destroy", "hours", "of", "work", "three", "times.", "I", "didn't", "try", "a", "fourth."],
      beats: [
        {
          code: "005A", range: "86.8–100.1s", narration: "Here is what context compaction means. Every message stays in the chat history. After a few hundred messages, the history is longer than what the model can read at once. To keep going, the agent summarizes the early parts and keeps going.",
          images: [
            { id: "IMG14", what: "Ai-figure feeds a giant scroll of chat messages into a funnel labeled CONTEXT WINDOW. The funnel is overflowing with paper. The ai-figure works methodically, feeding more scroll.", why: "Visualize the chat history as a physical object. Overflowing funnel = context window full. Ai-figure = the agent trying to manage it.", hold: "13.3s", distinct: true, refs: "ai-figure", firstWord: "Here", lastWord: "going.", startS: 86.79, endS: 100.13, firstIdx: 0, lastIdx: 40 },
          ],
        },
        {
          code: "005B", range: "101.0–114.5s", narration: "But that summary needs one uninterrupted call to the model. If the connection drops mid-compaction, the session dies. I watched a four-second drop destroy hours of work three times. I didn't try a fourth.",
          images: [
            { id: "IMG15", what: "A machine labeled COMPACTION tries to cram the overflow through a narrow tube. A lightning bolt strikes the tube mid-cram, shattering it. Papers fly everywhere. Ai-figure throws up its hands. The shattered tube pieces float in the air.", why: "The failure: lightning bolt = connection drop, shattered tube = dead session, flying papers = lost work. Physical consequence of a digital failure.", hold: "13.5s", distinct: true, refs: "ai-figure", firstWord: "But", lastWord: "fourth.", startS: 100.97, endS: 114.49, firstIdx: 43, lastIdx: 78 },
          ],
        },
      ],
    },
    {
      id: "C006", title: "Shenzhen Context", range: "116–121s", summary: "Builder in Shenzhen. VPS via VPN from China. Failure context.",
      words: ["I", "was", "in", "Xinjiang,", "on", "vacation,", "shipping", "a", "daily", "news", "show", "through", "a", "VPN", "from", "mainland", "China", "at", "midnight."],
      beats: [
        {
          code: "006A", range: "115.8–120.9s", narration: "I was in Shenzhen, on vacation, shipping a daily news show through a VPN from mainland China at midnight.",
          images: [
            { id: "IMG16", what: "Builder at a busy Shenzhen night market food stall. Chopsticks in one hand, phone in the other. Phone screen: server rack with giant red X, VPN shield cracked in half. Neon signs in Chinese characters glow behind. Builder looks at phone with exhausted disbelief, arm held out like the phone personally betrayed them.", why: "Location context: the absurdity of the situation. Vibrant night market vs dead server. The \"on vacation\" detail makes the frustration feel specific.", hold: "5.1s", distinct: true, refs: "builder", firstWord: "I", lastWord: "midnight.", startS: 115.78, endS: 120.86, firstIdx: 0, lastIdx: 15 },
          ],
        },
      ],
    },
    {
      id: "C007", title: "Infrastructure Gap", range: "122–143s", summary: "AI agents ranked by code, not network reliability. But software needs infrastructure.",
      words: ["This", "is", "the", "problem", "you", "don't", "anticipate", "when", "picking", "a", "tool.", "AI", "agents", "are", "ranked", "by", "benchmarks", "and", "code", "quality.", "Nobody", "ranks", "them", "by", "what", "happens", "when", "the", "network", "is", "unreliable,", "but", "they", "are", "software", "and", "software", "needs", "infrastructure.", "If", "that", "infrastructure", "is", "a", "server", "across", "the", "world", "and", "your", "connection", "is", "fragile,", "you", "have", "a", "very", "smart", "program", "that", "cannot", "finish", "a", "sentence."],
      beats: [
        {
          code: "007A", range: "122.2–132.6s", narration: "This is the problem you don't anticipate when picking a tool. AI agents are ranked by benchmarks and code quality.",
          images: [
            { id: "IMG17", what: "Giant glowing AI brain the size of a hot air balloon, suspended inside a glass server room over an ocean. A single frayed network cable dangles from it into the water below, sparking where it touches the waves. Builder stands on a tiny raft beneath, holding the severed end, looking up. The brain is brilliant, powerful, and completely unreachable.", why: "Visual metaphor for the core problem: brilliant intelligence, unreachable because of a fragile connection. The scale (giant brain, tiny raft) reinforces the absurdity.", hold: "10.4s", distinct: true, refs: "builder", firstWord: "This", lastWord: "unreliable.", startS: 122.23, endS: 132.63, firstIdx: 0, lastIdx: 32 },
          ],
        },
        {
          code: "007B", range: "133.5–143.4s", narration: "Nobody ranks them by what happens when the network is unreliable. But they're software, and software needs infrastructure.",
          images: [
            { id: "IMG18", what: "Meme-chad (clean-shaven, yellow spike hair, red OUCH! shirt) sits in a tiny lifeguard chair attached to the raft. He holds a scorecard: \"BENCHMARKS: 10/10 — CONNECTION: 0/10\". Builder looks from the scorecard to the sparking cable with flat expression.", why: "Chad adds comedic contrast. The scorecard makes the irony explicit: perfect benchmarks, zero connection. The builder's flat reaction = the deadpan punchline.", hold: "9.9s", distinct: true, refs: "builder, meme-chad", firstWord: "But", lastWord: "sentence.", startS: 133.51, endS: 143.45, firstIdx: 36, lastIdx: 63 },
          ],
        },
      ],
    },
    {
      id: "C008", title: "Looking for Local", range: "145–147s", summary: "Went looking for something that runs on my machine.",
      words: ["So", "I", "went", "looking", "for", "something", "that", "runs", "on", "my", "machine."],
      beats: [
        {
          code: "008A", range: "144.8–147.3s", narration: "So I went looking for something that runs on my machine.",
          images: [
            { id: "IMG19", what: "Builder in a dark room lit only by a laptop screen. Search query glowing: \"AI coding agent runs locally no server\". The screen shoots a beam of light across the dark room toward a distant opening. Silhouettes of remote-server-shaped monsters lurk in the shadows between builder and the light. Builder leans forward, squinting.", why: "The search moment. Transition from problem to solution. Server-monsters = the things being left behind. Beam of light = the path forward.", hold: "2.5s", distinct: true, refs: "builder", firstWord: "So", lastWord: "machine.", startS: 144.76, endS: 147.32, firstIdx: 0, lastIdx: 10 },
          ],
        },
      ],
    },
    {
      id: "C009", title: "Hermes Discovery", range: "149–156s", summary: "Found Hermes. Open-source, same category. Three differences.",
      words: ["What", "I", "found", "was", "Hermes,", "an", "open", "source", "agent", "from", "News", "Research.", "Same", "category.", "Three", "differences", "turned", "out", "to", "matter."],
      beats: [
        {
          code: "009A", range: "148.7–156.4s", narration: "What I found was Hermes, an open-source agent from Nous Research. Same category. Three differences turned out to matter.",
          images: [
            { id: "IMG20", what: "Builder kicks open a heavy vault door, light flooding in from behind the camera. Inside the vault: three pedestals on a stone floor. Left pedestal: open terminal with blinking cursor and green checkmark. Center: three glowing abstract provider shapes connected by arrows to one central hub. Right: notebook radiating warmth with a house icon on screen. Builder strides toward them, hand reaching for the terminal.", why: "The discovery. Three pedestals = the three differences about to be revealed. Vault door = something valuable found. The dramatic entrance earns the reveal.", hold: "7.7s", distinct: true, refs: "builder", firstWord: "What", lastWord: "matter.", startS: 148.65, endS: 156.37, firstIdx: 0, lastIdx: 19 },
          ],
        },
      ],
    },
    {
      id: "C010", title: "Terminal Access", range: "158–186s", summary: "First difference: sandbox vs shell. Agent directions from back seat vs driver's seat.",
      words: ["First,", "terminal", "access.", "Desktop", "agents", "run", "inside", "a", "sandbox.", "They", "can", "read", "files,", "but", "they", "cannot", "run", "commands", "or", "make", "network", "requests.", "To", "reach", "anything", "outside", "the", "file", "system,", "you", "need", "a", "separate", "bridge", "server.", "That", "is", "a", "lot", "of", "work", "just", "to", "run", "git", "push.", "Hermes", "has", "a", "shell.", "Anything", "you", "would", "type", "into", "a", "terminal,", "it", "can", "run.", "In", "a", "sandbox,", "the", "agent", "gives", "directions", "from", "the", "backseat.", "With", "a", "shell,", "it", "is", "in", "the", "driver's", "seat."],
      beats: [
        {
          code: "010A", range: "157.6–173.9s", narration: "First: terminal access. Desktop agents run inside a sandbox. They can suggest commands but they can't run them. Anything real — git push, npm install, reading a file — you need a separate bridge server. A lot of work just to run git push.",
          images: [
            { id: "IMG21", what: "Split screen, left side emphasized. A character pounds both fists against the inside of a glass box labeled SANDBOX. Outside the box, a database server, an API endpoint, and a build tool sit on shelves — bright, available, unreachable. The character's hands are pressed flat against the glass, face desperate.", why: "The sandbox problem: trapped with resources visible but unreachable. The glass box makes the barrier physical.", hold: "16.3s", distinct: true, refs: "—", firstWord: "First,", lastWord: "push.", startS: 157.64, endS: 173.94, firstIdx: 0, lastIdx: 50 },
          ],
        },
        {
          code: "010B", range: "174.9–185.7s", narration: "Hermes has a shell. Real terminal. It can read files, run commands, install packages, start servers. In a sandbox, the agent gives directions from the back seat. With a shell, it's in the driver's seat.",
          images: [
            { id: "IMG22", what: "Split screen, right side now emphasized. Builder at open terminal, hands flying across keyboard. Cables shoot out in all directions, connecting to the same database, API, and build tool with crackling energy. Small label below: \"Back seat → Driver's seat\".", why: "The shell solution. Same resources, now reachable. The \"back seat → driver's seat\" label makes the metaphor explicit.", hold: "10.8s", distinct: true, refs: "builder", firstWord: "Hermes", lastWord: "seat.", startS: 174.9, endS: 185.7, firstIdx: 55, lastIdx: 78 },
          ],
        },
      ],
    },
    {
      id: "C011", title: "Model Choice + Pricing", range: "187–217s", summary: "Second difference: model-agnostic. 87¢ vs $14. Real numbers.",
      words: ["Second,", "Model", "Choice.", "Most", "agents", "are", "locked", "to", "one", "provider.", "Hermes", "works", "with", "any", "of", "them.", "I", "switched", "to", "DeepSeek", "about", "87", "cents", "per", "million", "output", "tokens.", "The", "model", "I", "was", "using", "before", "costs", "$14", ".16", "more.", "A", "heavy", "session", "on", "the", "old", "tool,", "$30.", "Same", "session", "on", "DeepSeek,", "$2.", "Ship", "every", "day", "and", "that", "is", "900", "a", "month", "versus", "60.", "For", "someone", "building", "on", "their", "own,", "that", "difference", "is", "real."],
      beats: [
        {
          code: "011A", range: "187.0–202.7s", narration: "Second: model choice. I can use any model with an API key. I switched to DeepSeek, about eighty-seven cents per million tokens. The model I was using before costs fourteen dollars. Sixteen times more.",
          images: [
            { id: "IMG23", what: "Game-show set with two podiums under bright stage lights. Left podium: a tiny stack of three coins with label \"87¢/M\". Builder stands behind it, looking right with jaw dropped. Right podium: a coin tower so tall it goes off-frame, label \"$14/M\", with scaffolding holding it up.", why: "The price contrast. The visual scale (three coins vs tower needing scaffolding) makes the 16x difference feel physical and absurd.", hold: "15.7s", distinct: true, refs: "builder", firstWord: "Second,", lastWord: "16", startS: 186.99, endS: 202.71, firstIdx: 0, lastIdx: 42 },
          ],
        },
        {
          code: "011B", range: "202.7–216.6s", narration: "A heavy session on the old tool: thirty bucks. Same session on DeepSeek: two. Ship every day and that's nine hundred a month versus sixty. That's real.",
          images: [
            { id: "IMG24", what: "Meme-chad (clean-shaven, yellow spike hair, red OUCH! shirt) stands between the two podiums, arms confidently crossed, smug grin — clearly the game-show host. Below each podium, a digital calculator display: left shows \"$2 / session\", right shows \"$30 / session\". Builder points at the coin difference with jaw still dropped.", why: "Chad hosts the comparison — makes the price gap feel like a game-show reveal. The calculator numbers make the abstraction concrete.", hold: "13.9s", distinct: true, refs: "builder, meme-chad", firstWord: "times", lastWord: "real.", startS: 202.71, endS: 216.63, firstIdx: 43, lastIdx: 70 },
          ],
        },
      ],
    },
    {
      id: "C012", title: "Local-First", range: "218–232s", summary: "Third difference: everything on laptop. No VPS, no VPN. WiFi drops, nothing dies.",
      words: ["Third,", "it", "runs", "entirely", "on", "my", "laptop.", "No", "virtual", "private", "server,", "no", "remote", "server,", "no", "VPN.", "The", "agent,", "the", "model", "calls,", "the", "tools,", "the", "memory,", "everything", "lives", "on", "the", "machine", "in", "front", "of", "me.", "I", "lose", "Wi", "-Fi,", "nothing", "dies."],
      beats: [
        {
          code: "012A", range: "217.9–232.0s", narration: "Third: it runs entirely on my laptop. No VPS, no remote server, no VPN. The agent, the model calls, the tools, the memory — everything lives on the machine in front of me. I lose WiFi, nothing dies.",
          images: [
            { id: "IMG25", what: "Builder sits cross-legged on a mountaintop at sunrise, MacBook open on lap, screen glowing. From the screen radiate five glowing constellation lines connecting to orbiting labels: AGENT, MODEL, MEMORY, TOOLS, MCP. Each label orbits like a small moon. No server racks, no cloud icons, no VPN tunnels anywhere in the vast landscape. A tiny WiFi icon in the corner of the screen has a red X — builder doesn't even notice. Calm, in control.", why: "The freedom moment. Self-contained system as a mountaintop — vast empty landscape, everything needed is right there. The dead WiFi with no reaction is the punchline.", hold: "14.1s", distinct: true, refs: "builder", firstWord: "Third,", lastWord: "dies.", startS: 217.9, endS: 232.02, firstIdx: 0, lastIdx: 39 },
          ],
        },
      ],
    },
    {
      id: "C013", title: "MCP Bridge Test", range: "233–255s", summary: "First test: MCP server bridge. Built for Codex. Would it work with Hermes?",
      words: ["The", "first", "real", "test", "was", "the", "bridge", "to", "my", "project", "tracker.", "I", "built", "a", "small", "server", "that", "lets", "AI", "agents", "write", "directly", "to", "my", "project", "database.", "Built", "it", "for", "codecs.", "Work", "with", "another", "agent", "I", "use.", "Would", "it", "work", "with", "something", "completely", "different?", "Plug", "it", "into", "Hermes.", "Same", "config.", "Same", "protocol.", "Zero", "changes."],
      beats: [
        {
          code: "013A", range: "233.3–248.3s", narration: "The first real test was the bridge to my project tracker. I built a small server that lets AI agents write directly to my project database. Built it for Codex. Worked with another agent I use.",
          images: [
            { id: "IMG26", what: "Universal power strip labeled MCP sits center frame. Already connected: a square plug labeled \"Codex\" and a round plug labeled \"Claude Code\". On the other end of the strip, a database labeled PROJECTS glows steady green. Builder kneels beside the strip, holding a triangular plug labeled \"Hermes\", examining it — about to connect.", why: "The bridge: show the universal protocol. Two plugs already working, third about to try. The database glowing green = it's alive and waiting.", hold: "15.0s", distinct: true, refs: "builder", firstWord: "The", lastWord: "database.", startS: 233.33, endS: 240.91, firstIdx: 0, lastIdx: 25 },
          ],
        },
        {
          code: "013B", range: "249.2–255.4s", narration: "Plugged it into Hermes. Same config. Same protocol. Zero changes.",
          images: [
            { id: "IMG27", what: "Close-up: builder plugging the triangular Hermes connector into the MCP strip. A satisfying spark jumps as the connection completes. The PROJECTS database pulses brighter, green intensifying. Builder's face: relief and satisfaction.", why: "The connection moment. \"Zero changes\" made physical — plug fits, spark confirms, database brightens. The relief on builder's face is the payoff.", hold: "6.2s", distinct: true, refs: "builder", firstWord: "Dilt", lastWord: "changes.", startS: 241.85, endS: 255.43, firstIdx: 29, lastIdx: 52 },
          ],
        },
      ],
    },
    {
      id: "C014", title: "Success", range: "257–276s", summary: "One hour, four changes. Stuck video shipped. No drops.",
      words: ["Within", "an", "hour,", "I", "finished", "shipping", "the", "video", "stuck", "behind", "three", "dead", "sessions.", "Then", "another", "video", "stuck", "for", "a", "week.", "Then", "I", "fixed", "where", "videos", "were", "miscategorized", "on", "my", "project", "site.", "Then", "I", "fixed", "how", "source", "links", "display.", "For", "changes,", "one", "session.", "No", "drops.", "No", "dead", "compactions."],
      beats: [
        {
          code: "014A", range: "256.9–269.7s", narration: "Within an hour, I finished shipping the video stuck behind three dead sessions. Then another video stuck for a week. Then I fixed where videos were miscategorized. Then I fixed how source links display.",
          images: [
            { id: "IMG28", what: "Victory parade float with four giant banners, each lighting up as named. Banner 1: EPISODE 17 SHIPPED (rocket launching). Banner 2: DEV-LOG SHIPPED (film reel spinning). Banner 3: CATEGORIES FIXED (puzzle piece clicking in). Banner 4: LINKS FIXED (chain links connecting). Builder stands on the float platform, watching each banner light up.", why: "Four wins visualized as celebration floats. Each banner activates as the narration names it — the viewer tracks the count.", hold: "12.8s", distinct: true, refs: "builder", firstWord: "Within", lastWord: "fixed", startS: 256.89, endS: 264.49, firstIdx: 0, lastIdx: 25 },
          ],
        },
        {
          code: "014B", range: "270.6–275.6s", narration: "Four changes, one session. No drops. No dead compactions.",
          images: [
            { id: "IMG29", what: "Builder riding on top of the float, arms raised, confetti raining down from above. All four banners fully lit and glowing. No finish line flag anywhere — just forward momentum. Pure celebration.", why: "The payoff: builder celebrating, confetti, no finish line. Forward momentum, not completion. The emotional peak of the video.", hold: "5.0s", distinct: true, refs: "builder", firstWord: "where", lastWord: "compactions.", startS: 264.49, endS: 275.61, firstIdx: 26, lastIdx: 46 },
          ],
        },
      ],
    },
    {
      id: "C015", title: "The Lesson", range: "277–296s", summary: "Not that Hermes is better. Models are comparable. Difference is access.",
      words: ["Here's", "what", "I", "actually", "learned.", "It", "is", "not", "that", "Hermes", "is", "better", "than", "Codex.", "The", "models", "are", "comparable.", "The", "difference", "is", "what", "the", "model", "is", "allowed", "to", "do.", "Put", "any", "of", "these", "systems", "in", "a", "sandbox", "with", "no", "terminal", "and", "no", "network,", "and", "you", "get", "a", "knowledgeable", "chatbot.", "Give", "them", "the", "keys", "to", "the", "machine,", "and", "they", "can", "actually", "build."],
      beats: [
        {
          code: "015A", range: "276.9–283.7s", narration: "Here's what I actually learned. It's not that Hermes is better than Codex. The models are comparable.",
          images: [
            { id: "IMG30", what: "Two identical glowing brains sit side by side on a stone table. Left brain has a glass dome lowered over it, label: CODEX. Right brain has no dome, label: HERMES. Both glow with the same intensity. A set of keys on a steel ring sits on the table between them. Builder stands behind the table, one hand on each pedestal, looking directly at the viewer.", why: "The comparison: same intelligence, different access. The glass dome vs open air is the entire thesis in one image. Builder looking at viewer = \"here's what I actually learned.\"", hold: "6.8s", distinct: true, refs: "builder", firstWord: "Here", lastWord: "comparable.", startS: 276.95, endS: 283.73, firstIdx: 0, lastIdx: 23 },
          ],
        },
        {
          code: "015B", range: "284.6–296.0s", narration: "split into 2 visual moments:",
          images: [
            { id: "IMG31", what: "Same scene, but action: the glass dome is now fully lowered over the CODEX brain. A hand (builder's) picks up the key ring from the table and places it next to the HERMES brain. The HERMES brain glows slightly brighter. An arrow graphic traces from the keys to the brain, with the word \"ACCESS\" along the arrow.", why: "\"The difference is what the model is allowed to do. Put any of these systems in a sandbox, you get a knowledgeable chatbot.\" — the transfer: keys move from center to Hermes. The dome lowering = the sandbox closing.", hold: "5.5s", distinct: true, refs: "builder", firstWord: "The", lastWord: "terminal", startS: 284.65, endS: 290.05, firstIdx: 28, lastIdx: 47 },
            { id: "IMG32", what: "Wide shot: the table now. CODEX brain trapped under dome, glowing dimly. HERMES brain with keys beside it, glowing bright. Builder has stepped back from the table, arms crossed, looking at both. The choice is clear.", why: "\"Give them the keys to the machine, and they can actually build.\" — the wide shot shows the full contrast. The viewer can compare both states simultaneously. Builder's crossed arms = this isn't a question anymore.", hold: "5.9s", distinct: true, refs: "builder", firstWord: "and", lastWord: "build.", startS: 290.05, endS: 296.01, firstIdx: 47, lastIdx: 59 },
          ],
        },
      ],
    },
    {
      id: "C016", title: "Closing Thesis", range: "297–301s", summary: "The harness matters as much as the model. Maybe more.",
      words: ["The", "harness", "matters", "as", "much", "as", "the", "model.", "Maybe", "more."],
      beats: [
        {
          code: "016A", range: "297.4–300.9s", narration: "The harness matters as much as the model. Maybe more.",
          images: [
            { id: "IMG33", what: "Builder walking away from camera down a long road at golden hour. Over one shoulder: a laptop bag. In one hand: a single key, glinting in the sunset light. Far behind in the distance: a giant glass cage sits empty and shattered. No text. No labels. Just the road, the key, and the broken cage fading into the background.", why: "The closing thesis. Walking away = moving forward. Key in hand = owns the access now. Shattered cage behind = the sandbox is broken and left behind. Golden hour = earned optimism. No text = the image speaks.", hold: "3.5s", distinct: true, refs: "builder", firstWord: "The", lastWord: "more.", startS: 297.35, endS: 300.87, firstIdx: 0, lastIdx: 9 },
          ],
        },
      ],
    },
  ],
  overlays: [
    { id: "R01", trigger: "sixteen times more", image: "Price-check double-take GIF (shocked face zoom)", dur: "2.0s", placement: "Centered", anchor: "IMG23", chunk: "C011", firstIdx: 35, lastIdx: 37 },
    { id: "R02", trigger: "Four changes, one session", image: "Victory celebration GIF (confetti burst)", dur: "2.5s", placement: "Centered", anchor: "IMG29", chunk: "C014", firstIdx: 38, lastIdx: 42 },
  ],
}

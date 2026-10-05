import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentWall, SidePanel } from "rebar-ui";
import { BlockRenderer } from "@rebar-ui/placement";
import type { Construct } from "@rebar-ui/placement";
import { BuzzThread } from "./BuzzThread";
import { ProductionInfo } from "./ProductionInfo";
import { ChatBox } from "./ChatBox";
import { ConfigPage } from "./ConfigPage";
import { JoinPage } from "./JoinPage";
import { HeatmapPage } from "./HeatmapPage";
import { MemberDetails } from "./MemberDetails";
import { BootedBar } from "./BootedBar";
import { useBuzz } from "./buzz";
import type { BuzzMessage } from "./buzz";
import { readConfig, withQuery, writeConfig } from "./config";
import type { HiveConfig } from "./config";
import { chatAvailable, forWall, useHive, useProduction } from "./hive";

// Display preferences live on the Config page (saved in this browser). The address bar can still override them for a tuning link:
//   ?demo        a fake, organic wall (no host needed)       ?serviceOrb=strato  the orb style services wear (spark, strato, chorus)
//   ?cols=5&rows=4   the wall's size (page = cols x rows)    ?orb=css         plain CSS orbs instead of the real shaders
//   ?mode=dim    dim, rather than hide, filtered-out tiles   ?theme=dark      force dark
const q = new URLSearchParams(window.location.search);
const BASE = import.meta.env.BASE_URL;
const path = window.location.pathname.replace(/\/+$/, "");
const onConfigRoute = path.endsWith("/config");
const onJoinRoute = path.endsWith("/join");
const onHeatmapRoute = path.endsWith("/heatmap");

function applyTheme(theme: HiveConfig["theme"]) {
  const dark = theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : theme === "dark";
  if (dark) document.documentElement.setAttribute("data-theme", "dark"); // the nav's theme toggle takes over from here
  else document.documentElement.removeAttribute("data-theme");
}

// Set the theme before anything renders. Rebar's theme toggle reads <html data-theme> once, when it mounts, and React runs a child's
// effects before its parent's: setting the theme in an effect left the toggle believing it was light while the page was dark, so
// the first click changed nothing visible and it took a few clicks to line up again.
applyTheme(withQuery(readConfig(), q).theme);

export function App() {
  const demo = q.has("demo");
  const [saved, setSaved] = useState(readConfig);                       // what the Config page edits
  const cfg = onConfigRoute ? saved : withQuery(saved, q);              // what the wall shows: saved, plus address-bar overrides
  const { members, live } = useHive(demo);
  const { total: production, projects: topProjects } = useProduction(demo, members);
  const { messages, send, info } = useBuzz(demo);
  const [replyTo, setReplyTo] = useState<BuzzMessage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hostMode, setHostMode] = useState<"demo" | "work" | null>(null);
  useEffect(() => {
    fetch(`${BASE}mode`).then((r) => (r.ok ? r.json() : null)).then((j: { mode?: "demo" | "work" } | null) => setHostMode(j?.mode ?? null)).catch(() => undefined);
  }, []);

  // The toggle keeps its own copy of the mode, so when the theme changes from outside it (the Config page, or the OS flipping while on
  // "system") it is remounted to pick up the new value instead of holding a stale one.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    applyTheme(cfg.theme);
    setThemeTick((n) => n + 1);
    if (cfg.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { applyTheme("system"); setThemeTick((n) => n + 1); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [cfg.theme]);

  // The nav's theme toggle only flips <html data-theme>, which dies with the page: every other page (the heatmap, Config, Join) is a fresh load that
  // would go back to the saved preference. So when the toggle changes the theme, save it as the preference, like picking it on the Config page.
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => {
      const now: "light" | "dark" = el.getAttribute("data-theme") === "dark" ? "dark" : "light";
      setSaved((prev) => {
        const resolved = prev.theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : prev.theme;
        if (now === resolved) return prev; // our own applyTheme, or no change
        const next = { ...prev, theme: now };
        writeConfig(next);
        return next;
      });
    });
    obs.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Mark the nav link for the page we are on (the header block does not), so it can be styled as the current one.
  useEffect(() => {
    const here = window.location.pathname.replace(/\/+$/, "");
    navRef.current?.querySelectorAll<HTMLAnchorElement>("a.rebar-link").forEach((a) => {
      if (a.querySelector("img")) return; // the logo link
      if (new URL(a.href).pathname.replace(/\/+$/, "") === here) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  });

  // The Buzz drawer stays open beside the wall. It opens by itself when the first chatty agent arrives, and you can fold it away.
  const chatty = members.filter((m) => m.chatty).length;
  const [drawer, setDrawer] = useState(cfg.drawer);
  const hadChatty = useRef(false);
  useEffect(() => {
    if (chatty > 0 && !hadChatty.current) setDrawer(true);
    hadChatty.current = chatty > 0;
  }, [chatty]);

  // The top nav is Rebar's `site-header` block: logo (bee + wordmark, light and dark variants), links, status and the theme toggle.
  const nav: Construct[] = [
    {
      type: "site-header",
      logo: { label: "AI Hive", href: BASE, wordmarkSrc: `${BASE}aihive-logo.svg`, wordmarkSrcDark: `${BASE}aihive-logo-reversed.svg`, wordmarkHeight: 42 },
      items: [
        { href: BASE, label: "Wall" },
        { href: `${BASE}config`, label: "Config" },
        { href: `${BASE}join`, label: "Join this Hive" },
      ],
      trailing: { kind: "text", text: onConfigRoute ? "Config" : onJoinRoute ? "Join" : onHeatmapRoute ? "Heatmap" : demo || hostMode === "demo" ? "● Demo" : live ? "● Live" : "● Reconnecting…" },
      themeToggle: { sections: ["mode"], hideLabel: true },
      ariaLabel: "AI Hive",
    },
  ];
  // The page is exactly one screen tall: the nav on top, then the content (the wall scrolls on its own, beside the pinned Buzz panel).
  const navRef = useRef<HTMLDivElement>(null);
  const [navH, setNavH] = useState(64);
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const measure = () => setNavH(Math.round(el.getBoundingClientRect().height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: "var(--rebar-color-bg-primary, #fff)" }}>
      <div ref={navRef} className="hive-nav" style={{ flex: "none", position: "relative" }}>
        <BlockRenderer key={themeTick} blocks={nav} />
        {production !== null && !onConfigRoute && !onJoinRoute && !onHeatmapRoute ? (
          <div style={{ position: "absolute", right: 150, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 3 }}>
            <ProductionInfo total={production} projects={topProjects} />
          </div>
        ) : null}
      </div>
      {onHeatmapRoute ? (
        <main style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 32px" }}>
          <HeatmapPage demo={demo} />
        </main>
      ) : onJoinRoute ? (
        <main style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 32px" }}>
          <JoinPage />
        </main>
      ) : onConfigRoute ? (
        <main style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 32px" }}>
          <ConfigPage config={saved} onChange={setSaved} />
        </main>
      ) : (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <main style={{ boxSizing: "border-box", flex: 1, minWidth: 0, height: "100%", overflowY: "auto", padding: "16px 32px 24px" }}>
            {members.find((m) => m.id === selectedId) ? (
              <div style={{ marginBottom: 12 }}>
                <MemberDetails member={members.find((m) => m.id === selectedId)!} onClose={() => setSelectedId(null)} />
              </div>
            ) : null}
            <AgentWall members={members.map(forWall(cfg.serviceOrb))} selectedId={selectedId} onSelectedChange={setSelectedId} columns={cfg.cols} rows={cfg.rows} filterMode={cfg.filterMode} orb={cfg.orb} look="avatar" emptyText={live ? "Nobody is on the wall yet." : "Waiting for the Hive…"} />
          </main>
          <SidePanel title="Hive Chat" open={drawer} onOpenChange={setDrawer} width={360} style={{ height: "100%", flexShrink: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", height: `calc(100vh - ${navH}px - 112px)`, gap: 10 }}>
              <BuzzThread messages={messages} onReply={setReplyTo} />
              <ChatBox send={send} info={info} available={chatAvailable(members)} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} name={cfg.name} />
            </div>
          </SidePanel>
        </div>
      )}
    </div>
  );
}
            {demo ? null : <BootedBar />}

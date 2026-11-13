import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  ExternalLink,
  Globe2,
  History,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { createAuthClient } from "better-auth/react";
import type { ChatResult, ConversationMessage, ConversationSummary, Source } from "../shared/types";
import { ApiError, deleteAllConversations, deleteConversation, getConversation, getConversations, getHealth, sendChat, type ChatStreamEvent } from "./api";

const authClient = createAuthClient();
const privacyKey = "minimi-gemini-notice-accepted-v1";
const suggestions = [
  "What did I ask you on 3 November? Is it still accurate today?",
  "I shortlisted five CRM tools last Monday. What changed in pricing?",
  "Last Tuesday I asked about Postgres hosting. Check current pricing.",
];

type PendingError = { clientMessageId: string; message: string; retryable: boolean };

function readPrivacyChoice(): boolean {
  try { return window.localStorage.getItem(privacyKey) === "yes"; } catch { return false; }
}

function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function formatDate(value: string, timeZone = browserTimeZone(), options: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) {
  try { return new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(value)); }
  catch { return new Date(value).toLocaleDateString(); }
}

function formatTime(value: string, timeZone = browserTimeZone()) {
  try { return new Intl.DateTimeFormat(undefined, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
  catch { return new Date(value).toLocaleTimeString(); }
}

function formatDateHeading(value: string) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return formatDate(value, browserTimeZone(), { month: "long", year: "numeric" });
}

function dateKey(value: string) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: browserTimeZone() });
}

function useConversationGroups(conversations: ConversationSummary[]) {
  return useMemo(() => {
    const groups = new Map<string, ConversationSummary[]>();
    for (const conversation of conversations) {
      const key = dateKey(conversation.updatedAt);
      groups.set(key, [...(groups.get(key) ?? []), conversation]);
    }
    return [...groups.entries()].map(([key, items]) => ({ key, title: formatDateHeading(items[0].updatedAt), items }));
  }, [conversations]);
}

function CitationMarkdown({ message }: { message: ConversationMessage }) {
  const citationIndex = new Map(message.citations.map((source, index) => [source.id, index + 1]));
  const text = message.content.replace(/\[\[((?:C|P)\d+)\]\]/g, (_, id: string) => {
    const number = citationIndex.get(id);
    return number ? `[${number}](#source-${message.id}-${id})` : "";
  });
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, ...props }) {
            const citation = href?.match(/^#source-(.+)$/);
            if (citation) return <a className="inline-citation" href={href} aria-label={`Jump to source ${children}`}>{children}</a>;
            return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}<ExternalLink size={12} aria-hidden="true" /></a>;
          },
          code({ children, className, ...props }) {
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function SourceCard({ source, messageId, number }: { source: Source; messageId: string; number: number }) {
  return (
    <article className="source-card" id={`source-${messageId}-${source.id}`}>
      <div className="source-card-top">
        <span className={`source-vintage ${source.vintage}`}>{source.vintage === "previous" ? "THEN" : "NOW"}</span>
        <span className="source-number">{String(number).padStart(2, "0")}</span>
      </div>
      <a className="source-title" href={source.url} target="_blank" rel="noreferrer">
        {source.title}<ExternalLink size={13} aria-hidden="true" />
      </a>
      <p className="source-domain">{source.domain}</p>
      <p className="source-excerpt">{source.excerpt}</p>
      <div className="source-dates">
        {source.publishedAt && <span><CalendarDays size={12} /> Published {formatDate(source.publishedAt)}</span>}
        <span><Clock3 size={12} /> Found {formatTime(source.retrievedAt)}</span>
      </div>
    </article>
  );
}

function ComparisonCard({ message }: { message: ConversationMessage }) {
  if (!message.comparison.length) return null;
  return (
    <section className="comparison-card" aria-label="Then and now comparison">
      <div className="comparison-heading"><span className="comparison-mark">↗</span><div><span className="eyebrow">CHANGE CHECK</span><h3>Then, compared with now</h3></div></div>
      <div className="comparison-grid comparison-grid-head"><span>DETAIL</span><span>THEN</span><span>NOW</span></div>
      {message.comparison.map((row, index) => (
        <div className="comparison-grid comparison-row" key={`${row.label}-${index}`}>
          <strong>{row.label}</strong><p>{row.then || "Not captured"}</p><p>{row.now || "Not confirmed"}</p>
        </div>
      ))}
    </section>
  );
}

function MessageView({ message, searchedAt, onRetry }: { message: ConversationMessage; searchedAt?: string | null; onRetry?: () => void }) {
  const isAssistant = message.role === "assistant";
  return (
    <article className={`message-row ${isAssistant ? "assistant" : "user"}`}>
      {isAssistant && <div className="assistant-avatar" aria-hidden="true"><Sparkles size={15} /></div>}
      <div className="message-content-wrap">
        {isAssistant && <div className="message-byline"><span>MINIMI</span>{searchedAt && <span className="message-searched"><Globe2 size={12} /> Checked {formatTime(searchedAt)}</span>}</div>}
        <div className={`message-bubble ${isAssistant ? "assistant-bubble" : "user-bubble"}`}>
          {isAssistant ? <CitationMarkdown message={message} /> : <p>{message.content}</p>}
          {message.status === "failed" && onRetry && <button className="retry-link" onClick={onRetry}>Try again <ChevronRight size={14} /></button>}
        </div>
        {isAssistant && <ComparisonCard message={message} />}
        {isAssistant && message.citations.length > 0 && (
          <details className="sources-disclosure" open>
            <summary><span><Globe2 size={13} /> SOURCES</span><span>{message.citations.length} references <ChevronDown size={13} /></span></summary>
            <div className="source-list">
              {message.citations.map((source, index) => <SourceCard key={`${message.id}-${source.id}`} source={source} messageId={message.id} number={index + 1} />)}
            </div>
          </details>
        )}
        <time className="message-time" dateTime={message.createdAt}>{formatTime(message.createdAt, message.timeZone)}</time>
      </div>
    </article>
  );
}

function PrivacyGate({ onAccept }: { onAccept: () => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <main className="gate-page">
      <div className="gate-decoration gate-orb-one" /><div className="gate-decoration gate-orb-two" />
      <section className="privacy-card">
        <BrandMark large />
        <p className="eyebrow">BEFORE YOUR FIRST QUESTION</p>
        <h1>Research with a little memory.</h1>
        <p className="privacy-intro">Minimi uses live search and an AI model to check the web against what you asked before.</p>
        <div className="privacy-facts">
          <div><ShieldCheck size={18} /><p><strong>For professional research by adults 18+</strong><span>This demo is intended for professional use by adults.</span></p></div>
          <div><Sparkles size={18} /><p><strong>About the free AI tier</strong><span>Google may use prompts and responses to improve products, and human reviewers may process them.</span></p></div>
          <div><Globe2 size={18} /><p><strong>Search goes to Tavily</strong><span>Your web-search query is sent to Tavily. Don’t include sensitive or identifying details.</span></p></div>
          <div><History size={18} /><p><strong>Your history is saved to your account</strong><span>Conversation messages and search snapshots are stored so you can find them later and sync across devices.</span></p></div>
        </div>
        <a className="terms-link" href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">Read the Gemini API terms <ExternalLink size={14} /></a>
        <label className="acknowledge"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} /><span>I’m 18 or older, and I won’t enter sensitive, confidential, or personal information.</span></label>
        <button className="primary-button gate-continue" disabled={!checked} onClick={onAccept}>Continue to Minimi <ChevronRight size={16} /></button>
        <p className="privacy-footnote">Use the sources and their dates to judge each answer. Free service quotas apply.</p>
      </section>
    </main>
  );
}

function BrandMark({ large = false }: { large?: boolean }) {
  return <div className={`brand-lockup ${large ? "large" : ""}`}><span className="brand-mark"><span /><span /><span /></span><span className="brand-name">minimi<span className="brand-period">.</span></span></div>;
}

function SignInScreen({ onSignIn, loading, authReady }: { onSignIn: () => void; loading: boolean; authReady: boolean }) {
  return (
    <main className="signin-page">
      <div className="signin-top"><BrandMark /><span className="site-badge"><span className="live-dot" /> PRIVATE BY ACCOUNT</span></div>
      <section className="signin-layout">
        <div className="signin-copy">
          <p className="eyebrow">A RESEARCH ASSISTANT THAT REMEMBERS</p>
          <h1>The web changes.<br /><em>Your notes don’t.</em></h1>
          <p className="signin-lede">Ask a question, save the evidence, and come back later to see what moved.</p>
          <div className="signin-points"><span><Check size={15} /> Finds the conversation you mean</span><span><Check size={15} /> Rechecks current sources</span><span><Check size={15} /> Keeps dates and citations attached</span></div>
          <div className="orbit-illustration" aria-hidden="true">
            <div className="orbit-ring ring-a" /><div className="orbit-ring ring-b" />
            <div className="orbit-center"><Sparkles size={26} /></div>
            <div className="orbit-node node-a"><History size={16} /></div><div className="orbit-node node-b"><Globe2 size={16} /></div><div className="orbit-node node-c"><Clock3 size={15} /></div>
            <span className="orbit-label label-a">your past questions</span><span className="orbit-label label-b">the live web</span>
          </div>
        </div>
        <div className="signin-panel">
          <div className="panel-index">01 <span>YOUR RESEARCH DESK</span></div>
          <h2>Pick up where<br />you left off.</h2>
          <p>Sign in with Google to save searches, remember the date, and return to your research from any device.</p>
          <button className="google-button" onClick={onSignIn} disabled={loading || !authReady}>
            {loading ? <LoaderCircle className="spin" size={18} /> : <GoogleGlyph />}
            <span>{loading ? "Opening Google…" : "Continue with Google"}</span><ChevronRight size={16} />
          </button>
          {!authReady && <div className="setup-note"><CircleHelp size={16} /><span>Google sign-in is not configured yet. Add the credentials listed in <code>.env.example</code> and restart the dev server.</span></div>}
          <div className="signin-safe"><ShieldCheck size={16} /><span>Your conversations are private to your signed-in account.</span></div>
          <div className="panel-footer"><span>LIVE SEARCH</span><i /> <span>DATED MEMORY</span><i /> <span>CLICKABLE SOURCES</span></div>
        </div>
      </section>
      <footer className="signin-footer"><span>MINIMI RESEARCH / 2026</span><span>Built for the questions worth coming back to.</span></footer>
    </main>
  );
}

function App() {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const user = session?.user;
  const [privacyAccepted, setPrivacyAccepted] = useState(readPrivacyChoice);
  const [health, setHealth] = useState<{ gemini: boolean; search: boolean; googleAuth: boolean; regionAvailable: boolean } | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingError, setPendingError] = useState<PendingError | null>(null);
  const [memoryNote, setMemoryNote] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [errorToast, setErrorToast] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const groups = useConversationGroups(conversations);
  const now = useMemo(() => new Date(), []);
  const todayLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now);

  useEffect(() => {
    void getHealth().then((value) => setHealth(value.configured)).catch(() => setHealth(null));
  }, []);

  const refreshConversations = useCallback(async () => {
    try { setConversations(await getConversations()); }
    catch (error) {
      if (error instanceof ApiError && error.status !== 401) setErrorToast(error.message);
    }
  }, []);

  useEffect(() => {
    if (user) void refreshConversations();
    else { setConversations([]); setMessages([]); setActiveConversationId(null); }
  }, [user?.id, refreshConversations]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [messages, phase]);

  useEffect(() => {
    if (!errorToast) return;
    const timer = window.setTimeout(() => setErrorToast(""), 5_500);
    return () => window.clearTimeout(timer);
  }, [errorToast]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [draft]);

  const acceptPrivacy = () => {
    try { window.localStorage.setItem(privacyKey, "yes"); } catch { /* Continue for this tab if storage is unavailable. */ }
    setPrivacyAccepted(true);
  };

  const signIn = async () => {
    setAuthLoading(true);
    try { await authClient.signIn.social({ provider: "google", callbackURL: window.location.href }); }
    catch { setErrorToast("Google sign-in could not start. Check the OAuth settings and try again."); }
    finally { setAuthLoading(false); }
  };

  const signOut = async () => {
    await authClient.signOut();
    setAccountMenuOpen(false);
    setConversations([]);
    setMessages([]);
    setActiveConversationId(null);
  };

  const selectConversation = async (id: string) => {
    setMobileSidebarOpen(false);
    setPhase("");
    setPendingError(null);
    try {
      const value = await getConversation(id);
      setActiveConversationId(value.id);
      setMessages(value.messages);
      setMemoryNote("");
    } catch (error) {
      setErrorToast(error instanceof Error ? error.message : "Could not open that conversation.");
    }
  };

  const startNewChat = () => {
    setActiveConversationId(null);
    setMessages([]);
    setPhase("");
    setPendingError(null);
    setMemoryNote("");
    setDraft("");
    setMobileSidebarOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 60);
  };

  const removeConversation = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    if (!window.confirm("Delete this conversation and its saved search sources?")) return;
    try {
      await deleteConversation(id);
      setConversations((current) => current.filter((item) => item.id !== id));
      if (activeConversationId === id) startNewChat();
    } catch (error) {
      setErrorToast(error instanceof Error ? error.message : "Could not delete the conversation.");
    }
  };

  const clearHistory = async () => {
    if (!window.confirm("Clear every conversation and saved search source from your account? This cannot be undone.")) return;
    try {
      await deleteAllConversations();
      setConversations([]);
      setMessages([]);
      setActiveConversationId(null);
      setPendingError(null);
      setMemoryNote("");
      setAccountMenuOpen(false);
      setErrorToast("Your conversation history was cleared.");
    } catch (error) {
      setErrorToast(error instanceof Error ? error.message : "Could not clear your history.");
    }
  };

  const submitMessage = async (textValue = draft, retry?: PendingError) => {
    const text = textValue.trim();
    if (!text || submitting || !user) return;
    const clientMessageId = retry?.clientMessageId ?? crypto.randomUUID();
    const currentId = activeConversationId;
    if (!retry) {
      const optimistic: ConversationMessage = {
        id: clientMessageId,
        role: "user",
        content: text,
        citations: [],
        comparison: [],
        createdAt: new Date().toISOString(),
        timeZone: browserTimeZone(),
        status: "pending",
        errorCode: null,
      };
      setMessages((current) => [...current, optimistic]);
      setDraft("");
    } else {
      setMessages((current) => current.map((message) => message.id === clientMessageId ? { ...message, status: "pending", errorCode: null } : message));
    }
    setSubmitting(true);
    setPendingError(null);
    setMemoryNote("");
    setPhase("Looking through your earlier chats");
    let receivedResult = false;
    try {
      await sendChat({
        ...(currentId ? { conversationId: currentId } : {}),
        message: text,
        timeZone: browserTimeZone(),
        clientMessageId,
      }, (event: ChatStreamEvent) => {
        if (event.event === "status") setPhase(event.data.label);
        if (event.event === "result") {
          receivedResult = true;
          applyResult(event.data, clientMessageId, currentId);
        }
        if (event.event === "error") {
          receivedResult = true;
          setActiveConversationId(event.data.conversationId);
          setPendingError({ clientMessageId, message: event.data.message, retryable: event.data.retryable });
          setMessages((current) => current.map((message) => message.id === clientMessageId
            ? { ...message, id: event.data.userMessageId, status: "failed", errorCode: event.data.code }
            : message));
          setPhase("");
        }
      });
      if (!receivedResult) throw new Error("The response ended before Minimi sent an answer. Retry your message.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request failed. Retry your message.";
      setPendingError({ clientMessageId, message, retryable: !(error instanceof ApiError) || error.status === 429 || error.status >= 500 || error.status === 0 });
      setMessages((current) => current.map((item) => item.id === clientMessageId ? { ...item, status: "failed" } : item));
      setPhase("");
    } finally {
      setSubmitting(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const applyResult = (result: ChatResult, optimisticId: string, oldConversationId: string | null) => {
    setActiveConversationId(result.conversationId);
    setMessages((current) => {
      const withoutOptimisticReply = current.filter((message) => message.id !== result.assistantMessageId);
      const userMessage = withoutOptimisticReply.find((message) => message.id === optimisticId);
      const updated = withoutOptimisticReply.map((message) => message.id === optimisticId
        ? { ...message, id: result.userMessageId, status: "complete" as const }
        : message);
      const assistantMessage: ConversationMessage = {
        id: result.assistantMessageId,
        role: "assistant",
        content: result.answer,
        citations: result.citations,
        comparison: result.comparison,
        createdAt: new Date().toISOString(),
        timeZone: browserTimeZone(),
        status: "complete",
        errorCode: null,
      };
      if (!userMessage) {
        const recoveredUser: ConversationMessage = {
          id: result.userMessageId,
          role: "user",
          content: "Message restored from your saved conversation.",
          citations: [], comparison: [], createdAt: new Date().toISOString(), timeZone: browserTimeZone(), status: "complete", errorCode: null,
        };
        return [...updated, recoveredUser, assistantMessage];
      }
      return [...updated, assistantMessage];
    });
    const found = result.memoryMatches?.[0];
    if (found) setMemoryNote(`Found a related question from ${formatDate(found.createdAt)}.`);
    setPendingError(null);
    setPhase("");
    void refreshConversations();
    if (!oldConversationId) window.history.replaceState(null, "", `/c/${result.conversationId}`);
  };

  const retryPending = () => {
    if (!pendingError) return;
    const failed = messages.find((message) => message.id === pendingError.clientMessageId || message.errorCode);
    if (!failed) return;
    void submitMessage(failed.content, pendingError);
  };

  const visibleGroups = useMemo(() => groups.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.title.toLowerCase().includes(sidebarQuery.toLowerCase())),
  })).filter((group) => group.items.length), [groups, sidebarQuery]);

  if (!privacyAccepted) return <PrivacyGate onAccept={acceptPrivacy} />;
  if (sessionPending) return <main className="loading-page"><BrandMark /><LoaderCircle className="spin" size={24} /><span>Preparing your research desk…</span></main>;
  if (!user) {
    return <SignInScreen onSignIn={() => void signIn()} loading={authLoading} authReady={health?.googleAuth ?? false} />;
  }

  const userInitial = user.name?.trim().charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase();
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  return (
    <main className="app-shell">
      <div className={`mobile-scrim ${mobileSidebarOpen ? "visible" : ""}`} onClick={() => setMobileSidebarOpen(false)} />
      <aside className={`sidebar ${mobileSidebarOpen ? "open" : ""}`} aria-label="Conversation history">
        <div className="sidebar-brand-row"><BrandMark /><button className="icon-button mobile-close" aria-label="Close sidebar" onClick={() => setMobileSidebarOpen(false)}><X size={18} /></button></div>
        <button className="new-chat-button" onClick={startNewChat}><MessageSquarePlus size={17} /><span>New research</span><span className="shortcut">⌘ K</span></button>
        <div className="sidebar-section-label"><span>YOUR RESEARCH</span><span className="conversation-count">{conversations.length.toString().padStart(2, "0")}</span></div>
        <label className="history-search"><Search size={15} /><input value={sidebarQuery} onChange={(event) => setSidebarQuery(event.target.value)} placeholder="Find a conversation" /><kbd>/</kbd></label>
        <div className="conversation-list">
          {visibleGroups.length ? visibleGroups.map((group) => (
            <section className="conversation-group" key={group.key}>
              <h2>{group.title}</h2>
              {group.items.map((conversation) => (
                <div className={`conversation-item-row ${activeConversationId === conversation.id ? "active" : ""}`} key={conversation.id}>
                  <button className="conversation-item" onClick={() => void selectConversation(conversation.id)}>
                    <span className="conversation-copy"><span className="conversation-title">{conversation.title}</span><span className="conversation-time">{formatTime(conversation.updatedAt)}</span></span>
                  </button>
                  <span className="conversation-actions"><span className="message-count-badge">{conversation.messageCount}</span><button className="delete-conversation" type="button" aria-label={`Delete ${conversation.title}`} onClick={(event) => void removeConversation(event, conversation.id)}><Trash2 size={13} /></button></span>
                </div>
              ))}
            </section>
          )) : (
            <div className="empty-history"><History size={21} /><span>{sidebarQuery ? "No matching conversations" : "Your research will collect here"}</span></div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button className={`help-button ${helpOpen ? "selected" : ""}`} onClick={() => setHelpOpen((value) => !value)}><CircleHelp size={16} /><span>How Minimi works</span><ChevronRight size={14} /></button>
          {helpOpen && <div className="help-popover"><strong>One clear loop.</strong><p>Minimi searches only when a current answer needs evidence. It saves the sources and date so a later question can compare them.</p><a href="/DESIGN.md" target="_blank" rel="noreferrer">Read the design note <ExternalLink size={12} /></a></div>}
          <div className="account-wrap">
            <button className="account-button" onClick={() => setAccountMenuOpen((value) => !value)} aria-expanded={accountMenuOpen}>
              <span className="user-avatar">{userInitial}</span><span className="account-copy"><strong>{user.name || "Researcher"}</strong><small>Synced to your account</small></span><MoreHorizontal size={18} />
            </button>
            {accountMenuOpen && <div className="account-menu"><span className="account-email">{user.email}</span><button className="clear-history-action" onClick={() => void clearHistory()}><Trash2 size={14} /> Clear all history</button><button onClick={() => void signOut()}><LogOut size={14} /> Sign out</button></div>}
          </div>
        </div>
      </aside>

      <section className="main-column">
        <header className="topbar">
          <div className="topbar-title"><button className="icon-button mobile-menu" aria-label="Open sidebar" onClick={() => setMobileSidebarOpen(true)}><Menu size={19} /></button><div><span className="topbar-kicker">RESEARCH DESK</span><strong>{activeConversation?.title ?? "A question worth coming back to"}</strong></div></div>
          <div className="topbar-actions"><span className="web-status"><span className="live-dot" /> LIVE WEB</span><span className="topbar-date"><CalendarDays size={14} /> {todayLabel}</span><button className="icon-button help-icon" aria-label="About this demo" onClick={() => setHelpOpen((value) => !value)}><CircleHelp size={17} /></button></div>
        </header>

        <div className={`chat-scroll ${messages.length === 0 ? "empty-chat" : ""}`} ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="welcome-stage">
              <div className="welcome-overline"><span className="welcome-line" /> KEEP THE THREAD <span className="welcome-line" /></div>
              <h1>Ask today.<br /><em>Pick it up later.</em></h1>
              <p className="welcome-subtitle">One assistant for the live web and the questions you’ve already asked.</p>
              <div className="suggestion-grid">
                {suggestions.map((suggestion, index) => <button className="suggestion-card" key={suggestion} onClick={() => void submitMessage(suggestion)}><span className="suggestion-index">0{index + 1}</span><span>{suggestion}</span><ArrowUp className="suggestion-arrow" size={15} /></button>)}
              </div>
              <div className="welcome-note"><span className="note-icon"><History size={15} /></span><span>Try a follow-up tomorrow. Minimi keeps the date, answer, and sources together.</span></div>
            </div>
          ) : (
            <div className="thread">
              <div className="thread-date"><span /> {formatDate(messages[0].createdAt)} <span /></div>
              {messages.map((message) => {
                const retry = message.status === "failed" && pendingError?.clientMessageId === message.id;
                return <MessageView key={message.id} message={message} onRetry={retry ? retryPending : undefined} searchedAt={message.role === "assistant" && message.citations.length ? message.citations.find((source) => source.vintage === "current")?.retrievedAt : null} />;
              })}
              {memoryNote && <div className="memory-note"><History size={14} /> {memoryNote}</div>}
              {phase && <div className="thinking-row"><span className="thinking-mark"><LoaderCircle className="spin" size={15} /></span><span>{phase}</span><span className="thinking-dots"><i /><i /><i /></span></div>}
              {pendingError && <div className="error-inline"><span>{pendingError.message}</span>{pendingError.retryable && <button onClick={retryPending}>Retry <ChevronRight size={14} /></button>}</div>}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {health && !health.regionAvailable ? <div className="configuration-banner"><CircleHelp size={15} /><span>The free Gemini API tier is not available for this demo in your region. See the <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">service terms</a>.</span></div> : null}
          {health?.regionAvailable && (!health.gemini || !health.search) ? <div className="configuration-banner"><CircleHelp size={15} /><span>{!health.gemini && !health.search ? "Add Gemini and Tavily keys to enable answers and live search." : !health.gemini ? "Add GEMINI_API_KEY to enable answers." : "Add TAVILY_API_KEY to enable live search."} See <a href="/README.md" target="_blank" rel="noreferrer">setup notes</a>.</span></div> : null}
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void submitMessage(); }}>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitMessage(); } }}
              placeholder="Ask about something you want to remember…"
              rows={1}
              maxLength={8_000}
              aria-label="Message Minimi"
              disabled={submitting}
            />
            <div className="composer-bottom"><div className="composer-hint"><span><Globe2 size={13} /> Web search when it matters</span><span className="hint-divider" /><span><History size={13} /> Your past chats are in reach</span></div><button className="send-button" type="submit" disabled={!draft.trim() || submitting} aria-label="Send message">{submitting ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button></div>
          </form>
          <div className="composer-legal">Minimi can make mistakes. Check the linked sources before relying on an answer.</div>
        </div>
      </section>

      {errorToast && <div className="toast" role="status"><span className="toast-dot" />{errorToast}<button onClick={() => setErrorToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
    </main>
  );
}

function GoogleGlyph() {
  return <svg className="google-glyph" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.9c-.58 2.96-2.26 5.48-4.76 7.18l7.73 6c4.5-4.16 7.11-10.28 7.11-17.65z"/><path fill="#FBBC05" d="M10.53 28.59a14.4 14.4 0 0 1 0-9.18l-7.98-6.2a23.94 23.94 0 0 0 0 21.57l7.98-6.2z"/><path fill="#34A853" d="M24 48c6.48 0 11.92-2.13 15.89-5.8l-7.73-6c-2.14 1.45-4.9 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.2C6.51 42.62 14.62 48 24 48z"/></svg>;
}

export default App;


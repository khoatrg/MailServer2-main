import React, { useEffect, useRef, useState, useCallback } from "react";
import { getToken, API_BASE, listMessages } from "../api.js";

const MAX_BODY_CHARS = 2000;
const CHAT_HISTORY_KEY = 'chat_history';
const SELECTED_MODEL_KEY = 'chat_selected_model';

// ========== GLOBAL ENGINE (persist across component remounts) ==========
let globalEngine = null;
let globalEngineModel = null; // track which model is loaded
let globalWebllm = null;

// Helper: strip HTML tags
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper: load chat history from localStorage
function loadChatHistory() {
  try {
    const saved = localStorage.getItem(CHAT_HISTORY_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load chat history', e);
  }
  return [{ role: "system", content: "You are a helpful AI agent helping users." }];
}

// Helper: save chat history to localStorage
function saveChatHistory(messages) {
  try {
    // Giới hạn lưu 50 tin nhắn gần nhất để tránh localStorage quá lớn
    const toSave = messages.slice(-50);
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn('Failed to save chat history', e);
  }
}

// Helper: load selected model from localStorage
function loadSelectedModel(defaultModel) {
  try {
    const saved = localStorage.getItem(SELECTED_MODEL_KEY);
    if (saved) return saved;
  } catch (e) { /* ignore */ }
  return defaultModel;
}

// Helper: save selected model to localStorage
function saveSelectedModel(model) {
  try {
    localStorage.setItem(SELECTED_MODEL_KEY, model);
  } catch (e) { /* ignore */ }
}

export default function Chat({ defaultModel = "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC" }) {
  const [webllm, setWebllm] = useState(globalWebllm);
  const [engine, setEngine] = useState(globalEngine);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(() => loadSelectedModel(defaultModel));
  const [downloadStatus, setDownloadStatus] = useState(
    globalEngine ? `Model ready: ${globalEngineModel}` : ""
  );
  const [downloadVisible, setDownloadVisible] = useState(!!globalEngine);
  const [messages, setMessages] = useState(() => loadChatHistory());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const chatBoxRef = useRef(null);
  const [attachContext, setAttachContext] = useState(false);
  const [contextData, setContextData] = useState(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [availableMessages, setAvailableMessages] = useState([]);
  const [selectedUids, setSelectedUids] = useState(new Set());

  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Save chat history whenever messages change
  useEffect(() => {
    saveChatHistory(messages);
  }, [messages]);

  // Save selected model whenever it changes
  useEffect(() => {
    saveSelectedModel(selectedModel);
  }, [selectedModel]);

  // Load WebLLM library
  useEffect(() => {
    if (globalWebllm) {
      setWebllm(globalWebllm);
      const model_list = (globalWebllm.prebuiltAppConfig?.model_list) || [];
      setModels(model_list.map(m => m.model_id));
      return;
    }

    let mounted = true;
    async function loadLib() {
      try {
        const w = await import("@mlc-ai/web-llm");
        if (!mounted) return;
        globalWebllm = w;
        setWebllm(w);
        const model_list = (w.prebuiltAppConfig?.model_list) || [];
        const ids = model_list.map(m => m.model_id);
        setModels(ids);
        if (ids.length && !ids.includes(selectedModel)) {
          setDownloadStatus(`Model not found; switched to ${ids[0]}`);
          setSelectedModel(ids[0]);
        }
      } catch (pkgErr) {
        try {
          const w2 = await import("https://esm.run/@mlc-ai/web-llm");
          if (!mounted) return;
          globalWebllm = w2;
          setWebllm(w2);
          const model_list = (w2.prebuiltAppConfig?.model_list) || [];
          const ids = model_list.map(m => m.model_id);
          setModels(ids);
          if (ids.length && !ids.includes(selectedModel)) {
            setDownloadStatus(`Model not found; switched to ${ids[0]}`);
            setSelectedModel(ids[0]);
          }
        } catch (cdnErr) {
          console.error("Failed to load WebLLM:", pkgErr, cdnErr);
          setDownloadStatus("Failed to load WebLLM library.");
        }
      }
    }
    loadLib();
    return () => { mounted = false; };
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
  }, [messages]);

  // Check if engine already loaded for selected model
  useEffect(() => {
    if (globalEngine && globalEngineModel === selectedModel) {
      setEngine(globalEngine);
      setDownloadStatus(`Model ready: ${selectedModel}`);
      setDownloadVisible(true);
    } else if (globalEngine && globalEngineModel !== selectedModel) {
      // Different model selected, need to reload
      setDownloadStatus(`Current: ${globalEngineModel}. Click Download to load ${selectedModel}`);
    }
  }, [selectedModel]);

  async function initializeWebLLMEngine() {
    if (!webllm) { 
      setDownloadStatus("WebLLM not loaded."); 
      return; 
    }
    if (!selectedModel) { 
      setDownloadStatus("No model selected."); 
      return; 
    }

    // Nếu đã load model này rồi thì không cần load lại
    if (globalEngine && globalEngineModel === selectedModel) {
      setEngine(globalEngine);
      setDownloadStatus(`Model already loaded: ${selectedModel}`);
      setDownloadVisible(true);
      return;
    }

    setDownloadVisible(true);
    setDownloadStatus("Initializing engine...");

    try {
      const { MLCEngine } = webllm;
      const e = new MLCEngine();
      e.setInitProgressCallback((report) => {
        const text = report?.text || `Progress: ${Math.round((report?.progress || 0) * 100)}%`;
        setDownloadStatus(text);
      });
      
      await e.reload(selectedModel, { temperature: 1.0, top_p: 1 });
      
      // Store globally
      globalEngine = e;
      globalEngineModel = selectedModel;
      
      setEngine(e);
      setDownloadStatus(`Model loaded: ${selectedModel}`);
    } catch (err) {
      console.error("initializeWebLLMEngine failed", err);
      if (String(err).includes("Cannot find model record")) {
        setDownloadStatus(`Cannot find model: ${selectedModel}`);
      } else {
        setDownloadStatus("Failed to load: " + (err?.message || err));
      }
    }
  }

  async function openSelector() {
    setSelectorOpen(true);
    try {
      const res = await listMessages();
      if (res && Array.isArray(res.messages)) {
        setAvailableMessages(res.messages);
      } else {
        setAvailableMessages([]);
      }
    } catch (e) {
      console.error('Failed to load messages for selector', e);
      setAvailableMessages([]);
    }
  }

  function toggleSelect(uid) {
    setSelectedUids(prev => {
      const s = new Set(prev);
      if (s.has(uid)) s.delete(uid); else s.add(uid);
      return s;
    });
  }

  async function applySelection() {
    setSelectorOpen(false);
    if (!selectedUids || selectedUids.size === 0) {
      setContextData(null);
      setAttachContext(false);
      return;
    }
    setAttachContext(true);
    const token = getToken() || '';
    const out = [];
    for (const uid of Array.from(selectedUids)) {
      try {
        const resp = await fetch(`${API_BASE}/api/chat/message/${encodeURIComponent(uid)}`, {
          method: 'GET',
          headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}) }
        });
        if (!resp.ok) continue;
        const json = await resp.json().catch(() => null);
        const msg = (json && json.message) || json;
        if (msg) {
          let body = msg.text || stripHtml(msg.html) || '';
          if (body.length > MAX_BODY_CHARS) {
            body = body.slice(0, MAX_BODY_CHARS) + '\n...[truncated]';
          }
          out.push({
            uid,
            mailbox: msg.mailbox || 'INBOX',
            from: msg.from || '',
            subject: msg.subject || '',
            date: msg.date || '',
            body
          });
        }
      } catch (e) {
        console.warn('Error fetching message', uid, e);
      }
    }
    setContextData(out);
  }

  async function generateFullReply(msgs) {
    if (!engine) throw new Error("Engine not ready");
    const resp = await engine.chat.completions.create({
      messages: msgs,
      stream: false
    });
    let finalText = "";
    try {
      finalText = resp.choices?.[0]?.message?.content || resp.choices?.[0]?.delta?.content || "";
    } catch (e) { /* ignore */ }
    if (!finalText) {
      try {
        const msgObj = await engine.getMessage();
        finalText = msgObj.choices?.[0]?.message?.content || msgObj.choices?.[0]?.delta?.content || "";
      } catch (e) { /* ignore */ }
    }
    return finalText;
  }

  function appendMessage(msg) {
    setMessages(prev => [...prev, msg]);
  }

  function updateLastAssistant(content) {
    setMessages(prev => {
      const copy = [...prev];
      let idx = -1;
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i]?.role === 'assistant') { idx = i; break; }
      }
      if (idx === -1) copy.push({ role: 'assistant', content });
      else copy[idx] = { ...copy[idx], content };
      return copy;
    });
  }

  // Clear chat history
  function clearHistory() {
    const initial = [{ role: "system", content: "You are a helpful AI agent helping users." }];
    setMessages(initial);
    saveChatHistory(initial);
    setContextData(null);
    setAttachContext(false);
    setSelectedUids(new Set());
  }

  async function onMessageSend() {
    const userInput = (input || "").trim();
    if (!userInput || !engine) return;
    setBusy(true);

    appendMessage({ role: "user", content: userInput });
    appendMessage({ role: "assistant", content: "Thinking..." });
    setInput("");

    const history = Array.isArray(messagesRef.current) ? messagesRef.current : [];
    let finalSnapshot = [];

    if (attachContext && contextData && contextData.length) {
      const ctxText = contextData
        .map(m => `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.body || ''}`)
        .join('\n\n---\n\n');
      finalSnapshot.push({ role: 'system', content: 'User inbox context:\n' + ctxText });
    } else {
      if (history.length && history[0].role === 'system') {
        finalSnapshot.push(history[0]);
      } else {
        finalSnapshot.push({ role: 'system', content: 'You are a helpful AI agent helping users.' });
      }
    }

    finalSnapshot = finalSnapshot.concat(history.filter(m => m.role !== 'system'));
    finalSnapshot.push({ role: 'user', content: userInput });

    try {
      const finalText = await generateFullReply(finalSnapshot);
      updateLastAssistant(finalText || "");
    } catch (err) {
      console.error("generateFullReply error", err);
      updateLastAssistant("Error: " + (err?.message || err));
    } finally {
      setBusy(false);
      if (engine && typeof engine.runtimeStatsText === "function") {
        engine.runtimeStatsText().then(txt => setDownloadStatus(txt || "Finished")).catch(() => {});
      }
    }
  }

  return (
    <div className="chat-widget">
      <div className="chat-top">
        <div className="chat-top-left">
          <label className="chat-label">Model</label>
          <select className="chat-model-select" value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
            {models.length === 0 && <option>Loading models...</option>}
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div className="chat-top-right" style={{ display: 'flex', gap: 8 }}>
          <button className="primary-btn small" onClick={initializeWebLLMEngine}>
            {globalEngine && globalEngineModel === selectedModel ? '✓ Ready' : 'Download'}
          </button>
          <button 
            className="secondary-btn small" 
            onClick={clearHistory}
            title="Clear chat history"
            style={{ padding: '8px 12px', fontSize: 13 }}
          >
            🗑️ Clear
          </button>
        </div>
      </div>

      <div className="chat-status" aria-hidden={!downloadVisible}>
        {downloadVisible ? downloadStatus : "Press Download to load model"}
        {globalEngine && (
          <span style={{ marginLeft: 8, color: '#34a853', fontWeight: 600 }}>
            • Engine cached
          </span>
        )}
      </div>

      <div ref={chatBoxRef} className="chat-box" role="log" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`chat-message ${m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system"}`}>
            <div className="chat-bubble">
              <div className="meta">{m.role}</div>
              <div className="content">{m.content}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input-area">
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder={engine ? "Type a message and press Enter" : "Download model first"}
          disabled={!engine}
          onKeyDown={(e) => { if (e.key === "Enter") onMessageSend(); }}
        />
        <button className="primary-btn" onClick={onMessageSend} disabled={busy || !engine}>
          {busy ? "Thinking..." : "Send"}
        </button>
      </div>

      <label style={{ marginLeft: 12 }}>
        <input type="checkbox" checked={attachContext} onChange={async (e) => {
          const val = e.target.checked;
          setAttachContext(val);
          if (val) {
            try {
              const token = getToken() || '';
              const resp = await fetch(`${API_BASE}/api/chat/context`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...(token ? { Authorization: 'Bearer ' + token } : {})
                },
                body: JSON.stringify({ mailbox: 'INBOX', limit: 10, includeBodies: true, maxChars: 1500 })
              });
              if (!resp.ok) {
                setContextData(null);
                return;
              }
              const ct = resp.headers.get('content-type') || '';
              if (ct.includes('application/json')) {
                const json = await resp.json().catch(() => null);
                if (json?.success) {
                  setContextData(json.messages || []);
                } else {
                  setContextData(null);
                }
              } else {
                setContextData(null);
              }
            } catch (err) {
              console.error('Failed to fetch chat context', err);
              setContextData(null);
            }
          } else {
            setContextData(null);
          }
        }} />
        Attach Inbox Context
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 12 }}>
        <button type="button" className="btn btn--secondary btn--sm" onClick={openSelector} style={{ minWidth: 160 }}>
          Choose messages...
        </button>
        <div style={{ fontSize: 12, color: '#888' }}>
          {selectedUids.size ? `${selectedUids.size} selected` : ''}
        </div>
      </div>

      {selectorOpen && (
        <div className="chat-modal-backdrop">
          <div className="chat-modal">
            <div className="chat-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <h3 style={{ margin: 0 }}>Select messages to attach</h3>
                <div style={{ color: '#888', fontSize: 13 }}>{availableMessages.length} results</div>
              </div>
              <button className="icon-btn" onClick={() => setSelectorOpen(false)} aria-label="Close">✕</button>
            </div>

            <div className="chat-modal-body">
              <input
                className="search-input"
                placeholder="Filter by sender, subject or uid..."
                onChange={(e) => {
                  const q = (e.target.value || '').toLowerCase();
                  if (!q) {
                    setAvailableMessages(prev => prev.slice());
                    return;
                  }
                  setAvailableMessages(prev => prev.filter(m =>
                    String(m.from || '').toLowerCase().includes(q) ||
                    String(m.subject || '').toLowerCase().includes(q) ||
                    String(m.uid || '').toLowerCase().includes(q)
                  ));
                }}
              />

              <div className="selector-list" role="list">
                {availableMessages.length === 0 && <div className="selector-empty">No messages available</div>}
                {availableMessages.map(m => (
                  <label key={String(m.uid)} className="selector-item" role="listitem">
                    <input
                      type="checkbox"
                      checked={selectedUids.has(m.uid)}
                      onChange={() => toggleSelect(m.uid)}
                      className="selector-checkbox"
                    />
                    <div className="avatar">{(m.from || '').split('@')[0].slice(0, 1).toUpperCase()}</div>
                    <div className="selector-meta">
                      <div className="selector-top">
                        <div className="from">{m.from || '(unknown)'}</div>
                        <div className="date">{m.date || ''}</div>
                      </div>
                      <div className="subject">{m.subject || '(no subject)'}</div>
                      <div className="snippet">{(m.preview || m.snippet || '').slice(0, 140)}</div>
                      <div className="uid">uid: {m.uid}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="chat-modal-footer">
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-label" onClick={() => setSelectorOpen(false)}>Cancel</button>
                <button
                  className="primary-btn"
                  onClick={applySelection}
                  disabled={selectedUids.size === 0}
                >
                  Attach selected
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
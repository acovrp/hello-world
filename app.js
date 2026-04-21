// app.js — Council PWA Logic
// Communicates with extension via window.postMessage

// ── State ──
const state = {
  selectedModels: new Set(['claude', 'gemini', 'chatgpt']),
  maxRounds: 3,
  currentRound: 0,
  sessionActive: false,
  awaitingUserInput: false,
  extensionConnected: false,
  messages: [],         // full chat history for display
  councilHistory: [],   // {prompt, rounds:[{round, responses}]}
  currentSession: null,
};

const MODEL_CONFIG = {
  claude:  { name: 'Claude',   avatar: 'C', color: '#8b5cf6' },
  gemini:  { name: 'Gemini',   avatar: 'G', color: '#10b981' },
  chatgpt: { name: 'ChatGPT',  avatar: 'GP', color: '#f59e0b' },
};

// Relay order — ChatGPT first, Gemini second, Claude last (synthesiser)
const RELAY_ORDER = ['chatgpt', 'gemini', 'claude'];

// ── Extension bridge ──
// Extension injects a script that listens to postMessage
// We detect if extension is present by listening for a handshake

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const { type, ...data } = event.data || {};

  switch(type) {
    case 'COUNCIL_EXT_READY':
      state.extensionConnected = true;
      updateExtStatus(true);
      break;

    case 'COUNCIL_TYPING':
      showTypingIndicator(data.model);
      break;

    case 'COUNCIL_RESPONSE':
      hideTypingIndicator(data.model);
      appendAIMessage(data.model, data.response, data.round);
      break;

    case 'COUNCIL_ROUND_COMPLETE':
      handleRoundComplete(data.round, data.responses);
      break;

    case 'COUNCIL_ERROR':
      hideTypingIndicator(data.model);
      appendSystemMessage(`⚠ ${data.model} error: ${data.error}`);
      break;
  }
});

function sendToExtension(type, data = {}) {
  window.postMessage({ type, ...data }, '*');
}

// ── Model toggle ──
function toggleModel(model) {
  if (state.sessionActive) return;
  const pill = document.getElementById(`pill-${model}`);
  if (state.selectedModels.has(model)) {
    if (state.selectedModels.size <= 2) return; // min 2
    state.selectedModels.delete(model);
    pill.classList.remove('active');
    pill.classList.add('inactive');
  } else {
    state.selectedModels.add(model);
    pill.classList.add('active');
    pill.classList.remove('inactive');
  }
}

// ── Rounds ──
function changeRounds(delta) {
  state.maxRounds = Math.max(1, Math.min(10, state.maxRounds + delta));
  document.getElementById('roundsVal').textContent = state.maxRounds;
}

// ── Input helpers ──
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}

// ── Main send handler ──
function handleSend() {
  const input = document.getElementById('mainInput');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  if (state.awaitingUserInput) {
    // Between rounds — user adding input
    handleBetweenRoundInput(text);
  } else if (!state.sessionActive) {
    // New session
    startNewSession(text);
  }
}

// ── Start a new council session ──
function startNewSession(prompt) {
  // Hide welcome
  const welcome = document.getElementById('welcomeScreen');
  if (welcome) welcome.remove();

  state.sessionActive = true;
  state.currentRound = 0;
  state.currentSession = {
    prompt,
    startTime: new Date().toISOString(),
    rounds: [],
  };

  // Hide rounds selector
  document.getElementById('roundsRow').style.display = 'none';

  // Show user's message
  appendUserMessage(prompt);
  appendSystemMessage(`⚡ Council session started — ${Array.from(state.selectedModels).length} models, ${state.maxRounds} rounds`);

  // Update header
  document.getElementById('headerSub').textContent = 'Session Active';

  // Get active models in relay order
  const activeModels = RELAY_ORDER.filter(m => state.selectedModels.has(m));

  // Build the initial council context prompt
  const councilContext = buildCouncilPrompt(prompt, [], activeModels);

  // Start relay
  runRelay(prompt, councilContext, activeModels, 1);
}

// ── Build relay prompts ──
function buildCouncilPrompt(userQuery, previousResponses, activeModels) {
  return {
    userQuery,
    previousResponses,
    activeModels,
  };
}

function buildPromptForModel(model, userQuery, previousResponses, round) {
  const isFirst = previousResponses.length === 0;
  const isLast = true; // Claude is always last

  let prompt = '';

  if (model === 'chatgpt') {
    prompt = `You are part of a strategic council debate. 

USER QUERY: "${userQuery}"

You are responding FIRST. Give your honest, direct strategic perspective. Be analytical and specific. Don't hold back.

Round: ${round}`;
  }

  if (model === 'gemini') {
    const prevText = previousResponses.map(r =>
      `${MODEL_CONFIG[r.model]?.name || r.model}: ${r.response}`
    ).join('\n\n');

    prompt = `You are part of a strategic council debate.

USER QUERY: "${userQuery}"

PREVIOUS RESPONSE:
${prevText}

Now give YOUR perspective. Where do you agree? Where do you disagree or see something missing? Be direct and specific. Build on what was said or challenge it.

Round: ${round}`;
  }

  if (model === 'claude') {
    const prevText = previousResponses.map(r =>
      `${MODEL_CONFIG[r.model]?.name || r.model}: ${r.response}`
    ).join('\n\n');

    prompt = `You are the synthesiser in a strategic council debate.

USER QUERY: "${userQuery}"

THE DEBATE SO FAR:
${prevText}

Synthesise the best thinking from the debate. Add your own perspective. Identify the 2-3 most actionable insights. End by asking the user: what aspect do they want to explore deeper in the next round?

Round: ${round}`;
  }

  return prompt;
}

// ── Run the sequential relay ──
async function runRelay(userQuery, context, activeModels, round) {
  state.currentRound = round;
  updateRoundIndicator(round);

  const roundResponses = [];

  appendSystemMessage(`— Round ${round} of ${state.maxRounds} —`);

  for (const model of activeModels) {
    // Build prompt for this model (includes all previous responses in this round)
    const prompt = buildPromptForModel(model, userQuery, roundResponses, round);

    // Show typing indicator
    showTypingIndicator(model);
    document.getElementById('sendBtn').disabled = true;

    // Tell extension to send this prompt to this model's tab
    sendToExtension('COUNCIL_SEND', {
      model,
      prompt,
      round,
      sessionId: state.currentSession?.startTime,
    });

    // Wait for response (promise resolved when extension sends back COUNCIL_RESPONSE)
    const response = await waitForResponse(model, round);
    roundResponses.push({ model, response });
  }

  // Round complete
  state.currentSession?.rounds.push({ round, responses: roundResponses });

  // Show round summary card
  showRoundSummary(round, roundResponses, round >= state.maxRounds);

  document.getElementById('sendBtn').disabled = false;
}

// ── Wait for a specific model's response ──
function waitForResponse(model, round) {
  return new Promise((resolve) => {
    const handler = (event) => {
      if (event.source !== window) return;
      const { type, model: m, response, round: r } = event.data || {};
      if (type === 'COUNCIL_RESPONSE' && m === model && r === round) {
        window.removeEventListener('message', handler);
        resolve(response);
      }
      // Also handle errors
      if (type === 'COUNCIL_ERROR' && m === model) {
        window.removeEventListener('message', handler);
        resolve(`[${model} unavailable: ${event.data.error}]`);
      }
    };
    window.addEventListener('message', handler);

    // Timeout after 120 seconds
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve(`[${model} timed out]`);
    }, 120000);
  });
}

// ── Round complete ──
function handleRoundComplete(round, responses) {
  // Handled inline in runRelay
}

function showRoundSummary(round, responses, isFinal) {
  state.awaitingUserInput = !isFinal;

  const feed = document.getElementById('chatFeed');

  const card = document.createElement('div');
  card.className = 'round-card msg';
  card.innerHTML = `
    <div class="round-card-header">
      <span class="round-card-title">
        ${isFinal ? '🏁 Final Round Complete' : `✓ Round ${round} Complete`}
      </span>
      <span style="font-size:10px;color:var(--muted)">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="round-card-body">
      <p>${isFinal
        ? 'The council has completed all rounds. What did you learn?'
        : 'The council has spoken. Add your input to guide round ' + (round + 1) + ', or continue automatically.'
      }</p>
      <div class="round-actions">
        ${!isFinal ? `
          <button class="round-btn round-btn-primary" onclick="continueSession('')">
            Continue Round ${round + 1} →
          </button>
        ` : ''}
        <button class="round-btn round-btn-secondary" onclick="exportSession()">
          Export
        </button>
        <button class="round-btn round-btn-end" onclick="endSession()">
          End Session
        </button>
      </div>
    </div>
  `;

  feed.appendChild(card);
  scrollToBottom();

  if (isFinal) {
    endSession();
  } else {
    // Update input placeholder
    document.getElementById('mainInput').placeholder =
      `Add input for round ${round + 1}, or hit → to continue...`;
  }
}

// ── Between-round user input ──
function handleBetweenRoundInput(text) {
  state.awaitingUserInput = false;

  appendUserMessage(text);
  continueSession(text);
}

function continueSession(userInput) {
  state.awaitingUserInput = false;
  document.getElementById('mainInput').placeholder = 'Ask the council...';

  const nextRound = state.currentRound + 1;
  const activeModels = RELAY_ORDER.filter(m => state.selectedModels.has(m));

  // Build enriched query with user's input
  const enrichedQuery = userInput
    ? `${state.currentSession.prompt}\n\n[User guidance for round ${nextRound}: ${userInput}]`
    : state.currentSession.prompt;

  // Get all previous responses for context
  const allPrevious = state.currentSession.rounds.flatMap(r => r.responses);

  runRelay(enrichedQuery, null, activeModels, nextRound);
}

// ── Chat rendering ──
function appendUserMessage(text) {
  const feed = document.getElementById('chatFeed');
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `
    <div class="msg-header">
      <span class="msg-name">You</span>
      <span class="msg-time">${timestamp()}</span>
      <div class="msg-avatar" style="background:rgba(99,102,241,0.2);color:#6366f1">A</div>
    </div>
    <div class="msg-bubble">${escHtml(text)}</div>
  `;
  feed.appendChild(el);
  scrollToBottom();
}

function appendAIMessage(model, text, round) {
  const cfg = MODEL_CONFIG[model] || { name: model, avatar: '?', color: '#94a3b8' };
  const feed = document.getElementById('chatFeed');

  const el = document.createElement('div');
  el.className = `msg ${model}`;
  el.innerHTML = `
    <div class="msg-header">
      <div class="msg-avatar" style="background:${cfg.color}22;color:${cfg.color}">${cfg.avatar}</div>
      <span class="msg-name">${cfg.name}</span>
      <span style="font-size:10px;color:var(--muted);margin-left:4px">Round ${round}</span>
      <span class="msg-time">${timestamp()}</span>
    </div>
    <div class="msg-bubble">${formatAIText(text)}</div>
  `;
  feed.appendChild(el);
  scrollToBottom();
}

function appendSystemMessage(text) {
  const feed = document.getElementById('chatFeed');
  const el = document.createElement('div');
  el.className = 'msg system';
  el.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  feed.appendChild(el);
  scrollToBottom();
}

// ── Typing indicators ──
const typingEls = {};

function showTypingIndicator(model) {
  if (typingEls[model]) return;
  const cfg = MODEL_CONFIG[model] || { name: model, avatar: '?', color: '#94a3b8' };
  const feed = document.getElementById('chatFeed');

  const el = document.createElement('div');
  el.className = `msg ${model}`;
  el.id = `typing-${model}`;
  el.innerHTML = `
    <div class="msg-header">
      <div class="msg-avatar" style="background:${cfg.color}22;color:${cfg.color}">${cfg.avatar}</div>
      <span class="msg-name">${cfg.name} is thinking...</span>
    </div>
    <div class="msg-bubble">
      <div class="typing-indicator">
        <div class="typing-dot" style="background:${cfg.color}"></div>
        <div class="typing-dot" style="background:${cfg.color}"></div>
        <div class="typing-dot" style="background:${cfg.color}"></div>
      </div>
    </div>
  `;
  feed.appendChild(el);
  typingEls[model] = el;
  scrollToBottom();
}

function hideTypingIndicator(model) {
  const el = typingEls[model] || document.getElementById(`typing-${model}`);
  if (el) { el.remove(); delete typingEls[model]; }
}

// ── Session management ──
function endSession() {
  state.sessionActive = false;
  state.awaitingUserInput = false;
  state.currentRound = 0;

  // Save to history
  if (state.currentSession) {
    state.councilHistory.unshift(state.currentSession);
    saveHistory();
  }

  document.getElementById('headerSub').textContent = 'Multi-AI Strategic Debate';
  document.getElementById('roundsRow').style.display = 'flex';
  document.getElementById('mainInput').placeholder = 'Ask the council...';
  document.getElementById('sendBtn').disabled = false;
  updateRoundIndicator(0);

  appendSystemMessage('✓ Session ended — start a new question below');
  sendToExtension('COUNCIL_END_SESSION');
}

function newSession() {
  if (state.sessionActive) {
    if (!confirm('End current session and start new?')) return;
    endSession();
  }
  // Clear feed
  const feed = document.getElementById('chatFeed');
  feed.innerHTML = '';
}

function exportSession() {
  if (!state.currentSession) return;
  const text = formatSessionForExport(state.currentSession);
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `council-session-${Date.now()}.txt`;
  a.click();
}

function formatSessionForExport(session) {
  let out = `THE COUNCIL — Session Export\n`;
  out += `Date: ${new Date(session.startTime).toLocaleString()}\n`;
  out += `Query: ${session.prompt}\n\n`;
  out += `${'='.repeat(50)}\n\n`;

  session.rounds.forEach(r => {
    out += `ROUND ${r.round}\n${'-'.repeat(30)}\n`;
    r.responses.forEach(resp => {
      const name = MODEL_CONFIG[resp.model]?.name || resp.model;
      out += `\n${name.toUpperCase()}:\n${resp.response}\n`;
    });
    out += '\n';
  });

  return out;
}

// ── History ──
function toggleHistory() {
  // Simple alert-based history for now
  if (state.councilHistory.length === 0) {
    alert('No session history yet.');
    return;
  }
  const summary = state.councilHistory.slice(0, 5).map((s, i) =>
    `${i + 1}. ${s.prompt.slice(0, 60)}... (${s.rounds.length} rounds)`
  ).join('\n');
  alert('Recent sessions:\n\n' + summary);
}

function saveHistory() {
  try {
    localStorage.setItem('councilHistory', JSON.stringify(state.councilHistory.slice(0, 20)));
  } catch(e) {}
}

function loadHistory() {
  try {
    const h = localStorage.getItem('councilHistory');
    if (h) state.councilHistory = JSON.parse(h);
  } catch(e) {}
}

// ── UI helpers ──
function updateRoundIndicator(round) {
  const el = document.getElementById('roundText');
  if (round === 0) {
    el.textContent = 'Not started';
  } else {
    el.textContent = `Round ${round}/${state.maxRounds}`;
  }
}

function updateExtStatus(connected) {
  // Could show a green dot when extension is connected
  const sub = document.getElementById('headerSub');
  if (!state.sessionActive) {
    sub.textContent = connected ? 'Extension Connected ✓' : 'Multi-AI Strategic Debate';
  }
}

function scrollToBottom() {
  const feed = document.getElementById('chatFeed');
  requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
  });
}

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function formatAIText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^#{1,3}\s(.+)$/gm, '<strong style="color:#a5b4fc;display:block;margin-top:8px">$1</strong>')
    .replace(/^[-•]\s(.+)$/gm, '<span style="display:block;padding-left:10px;border-left:2px solid rgba(255,255,255,0.1);margin:3px 0">• $1</span>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// ── Init ──
loadHistory();

// Ping extension to check if connected
sendToExtension('COUNCIL_PING');
setTimeout(() => {
  if (!state.extensionConnected) {
    // Show subtle warning
    const feed = document.getElementById('chatFeed');
    const welcome = document.getElementById('welcomeScreen');
    if (welcome) {
      const warn = document.createElement('div');
      warn.style.cssText = 'padding:8px 12px;margin:0 0 8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:8px;font-size:11px;color:#fcd34d;text-align:center';
      warn.innerHTML = '⚠ Council extension not detected. Install it in Kiwi Browser to activate.';
      welcome.appendChild(warn);
    }
  }
}, 2000);

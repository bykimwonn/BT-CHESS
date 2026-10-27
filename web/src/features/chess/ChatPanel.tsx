import { useState } from 'react';

export interface ChatMessage { username: string; text: string; at: string }

interface ChatPanelProps {
  chat: ChatMessage[];
  connected: boolean;
  isSpectator: boolean;
  onChat: (text: string) => Promise<void>;
}

/** Plain in-game chat: the log and one input, nothing else. */
export function ChatPanel({ chat, connected, isSpectator, onChat }: ChatPanelProps) {
  const [text, setText] = useState('');
  return (
    <section className="card" aria-labelledby="chat-title">
      <div className="card-header"><h2 className="card-title" id="chat-title">Chat</h2></div>
      <div className="chat-box" role="log" aria-live="polite">
        {chat.length === 0 && <p className="small muted">No messages yet.</p>}
        {chat.map((message, index) => (
          <div className="chat-message" key={`${message.at}-${index}`}>
            <strong>{message.username}</strong> <span className="muted tiny">{new Date(message.at).toLocaleTimeString()}</span>
            <div>{message.text}</div>
          </div>
        ))}
      </div>
      {!isSpectator && (
        <form className="row" style={{ marginTop: '.5rem' }} onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          void onChat(text.trim()).then(() => setText('')).catch(() => undefined);
        }}>
          <label className="sr-only" htmlFor="chat-input">Chat message</label>
          <input id="chat-input" className="input" value={text} maxLength={300} placeholder="Say good luck…"
            onChange={(event) => setText(event.target.value)} />
          <button className="btn btn-sm" type="submit" disabled={!connected || !text.trim()}>Send</button>
        </form>
      )}
    </section>
  );
}

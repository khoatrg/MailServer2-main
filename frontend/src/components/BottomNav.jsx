import React from 'react';
import { Inbox } from 'lucide-react';
import { Send } from 'lucide-react';
import { SquarePen } from 'lucide-react';
import { Settings } from 'lucide-react';


export default function BottomNav({ active = 'inbox', onNavigate }) {
  return (
    <nav className="bottom-nav" aria-label="Main navigation">
      <button
        className={`nav-item ${active === 'inbox' ? 'active' : ''}`}
        onClick={() => onNavigate && onNavigate('inbox')}
      >
        <Inbox />        <span>Inbox</span>
      </button>
      <button
        className={`nav-item ${active === 'sent' ? 'active' : ''}`}
        onClick={() => onNavigate && onNavigate('sent')}
      >
        <Send />        <span>Sent</span>
      </button>
      <button
        className={`nav-item ${active === 'drafts' ? 'active' : ''}`}
        onClick={() => onNavigate && onNavigate('drafts')}
      >
        <SquarePen />        <span>Drafts</span>
      </button>
      <button
        className={`nav-item ${active === 'settings' ? 'active' : ''}`}
        onClick={() => onNavigate && onNavigate('settings')}
      >
        <Settings />        <span>Settings</span>
      </button>
    </nav>
  );
}
